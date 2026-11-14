// A tablet action and its Undo, as steps (docs/modules/devices/README.md, "Device actions";
// design 10.3, 11, R1). Framework-free so the order of steps is unit-tested and model-tested
// (tests/unit/devices-undo-model.test.ts); the tablet's runtime
// (src/components/devices/use-device-actions.tsx) supplies the steps. Every outcome moves
// the action's Undo journal entry through the one state machine in `undo-journal.ts`.
//
// - Local storage (the queue and the journal in IndexedDB) is best effort for the journal:
//   when it can't be written, the action and its Undo still go to the server by opId.
// - The person is authorized as for any action: when the Undo's level needs a PIN (the
//   household's points-PIN setting), the original actor's PIN pad comes first, also for an
//   Undo restored after a reload; a PIN refusal from the server asks once more and retries.
// - Only a queue entry that never left the tablet is removed locally (the server never knew).

import type { DeviceRefusal } from './action-policy';
import {
  journalEntry,
  journalStep,
  undoRefusalEvent,
  undoRoute,
  type JournalEvent,
  type UndoJournalEntry,
} from './undo-journal';

export type UndoActor = { actorUid: string; pinSessionId?: string };
export type UndoAnswer = { ok: true; data?: unknown } | { ok: false; code: DeviceRefusal; retryAfterSec?: number };

/**
 * Why something can't wait in the tablet's queue: it needs a PIN (queued sends carry no PIN
 * session, and the server refuses a PIN-level queued request), or the queue isn't durable
 * here (no IndexedDB: nothing would survive a reload, so nothing is promised).
 */
export type QueueRefusal = 'needs-pin' | 'not-durable';

/** Whether an action or Undo may be saved on the tablet for later (null: yes). */
export const queueRefusal = (input: { queueable: boolean; durable: boolean }): QueueRefusal | null =>
  !input.queueable ? 'needs-pin' : !input.durable ? 'not-durable' : null;

/** The tablet's words for a refused offline save. */
export const QUEUE_REFUSAL_COPY: Record<QueueRefusal, string> = {
  'needs-pin': 'That needs a PIN, so it needs a connection. Try again when the tablet is back online.',
  'not-durable': "Couldn't save offline on this tablet. Try again when connected.",
};

const bestEffort = async <T,>(work: () => Promise<T>, fallback: T): Promise<T> => {
  try {
    return await work();
  } catch {
    return fallback;
  }
};

// ---------------------------------------------------------------------------
// The action
// ---------------------------------------------------------------------------

export type PerformDeps = {
  /** The journal entry's identity (opId made before the first attempt; every retry reuses it). */
  entry: Pick<UndoJournalEntry, 'opId' | 'householdId' | 'deviceId' | 'generation' | 'capability' | 'actorUid' | 'label'>;
  /** The action has an Undo (a journal entry is kept). */
  undoable: boolean;
  /** Writes a new journal entry (best effort). */
  record: (entry: UndoJournalEntry) => Promise<void>;
  /** Applies an event to the stored journal entry (best effort). */
  step: (event: JournalEvent) => Promise<void>;
  /** Null when this action may wait in the queue (face level, durable queue); otherwise why not. */
  queueRefusal: QueueRefusal | null;
  /** Stores it in the queue (`sent`: an attempt without an answer may have reached the server). */
  enqueue: (sent: boolean) => Promise<void>;
  send: () => Promise<UndoAnswer>;
  /** Whether a successful answer changed something this tablet may Undo. */
  undoableAnswer: (data: unknown) => boolean;
  online: boolean;
  now: () => number;
};

export type PerformResult =
  /** Applied on the server; its Undo is offered. */
  | { kind: 'applied'; data: unknown }
  /** Answered successfully with nothing to take back (already done by someone, not due, …). */
  | { kind: 'noop'; data: unknown }
  /** Saved in the queue (never sent, or sent without an answer: `sent`). */
  | { kind: 'queued'; sent: boolean }
  /** Sent, no answer, and it can't wait in the queue: the server may hold it. Undo stays offered for the window left. */
  | { kind: 'unknown' }
  /** Not saved offline (it needs a PIN, or the queue isn't durable). */
  | { kind: 'not-queued'; reason: QueueRefusal }
  | { kind: 'refused'; code: DeviceRefusal; retryAfterSec?: number };

export async function performAction(deps: PerformDeps): Promise<PerformResult> {
  const journal = async (work: () => Promise<void>) => { if (deps.undoable) await bestEffort(work, undefined); };
  if (!deps.online) {
    if (deps.queueRefusal) return { kind: 'not-queued', reason: deps.queueRefusal };
    // The journal first: the local cancellation window is restorable from the moment it is queued.
    await journal(() => deps.record(journalEntry({ ...deps.entry, at: deps.now(), queued: true })));
    try {
      await deps.enqueue(false);
    } catch {
      await journal(() => deps.step({ type: 'discarded', at: deps.now() }));
      return { kind: 'refused', code: 'failed' };
    }
    return { kind: 'queued', sent: false };
  }
  await journal(() => deps.record(journalEntry({ ...deps.entry, at: deps.now() })));
  let answer: UndoAnswer;
  try {
    answer = await deps.send();
  } catch {
    // No answer: the server may have applied it. The opId is kept either way: in the queue
    // (resent with the same opId) when it can wait, otherwise as an unknown outcome whose
    // Undo stays offered for the window that may remain.
    if (!deps.queueRefusal) {
      try {
        await deps.enqueue(true);
        await journal(() => deps.step({ type: 'no-answer', at: deps.now(), queued: true }));
        return { kind: 'queued', sent: true };
      } catch {
        // Nothing could be stored: an unknown outcome.
      }
    }
    await journal(() => deps.step({ type: 'no-answer', at: deps.now(), queued: false }));
    return { kind: 'unknown' };
  }
  if (!answer.ok) {
    await journal(() => deps.step({ type: 'refused', at: deps.now() }));
    return { kind: 'refused', code: answer.code, ...(answer.retryAfterSec !== undefined ? { retryAfterSec: answer.retryAfterSec } : {}) };
  }
  const undoable = deps.undoableAnswer(answer.data);
  await journal(() => deps.step({ type: 'answered', at: deps.now(), undoable }));
  return undoable ? { kind: 'applied', data: answer.data } : { kind: 'noop', data: answer.data };
}

// ---------------------------------------------------------------------------
// The Undo
// ---------------------------------------------------------------------------

export type UndoFlowDeps = {
  /** Removes the queue entry only while it has never been sent (under the queue lock). */
  removeIfNeverSent: (opId: string) => Promise<boolean>;
  /** Applies an event to the stored journal entry (best effort). */
  step: (event: JournalEvent) => Promise<void>;
  /** Queues the Undo intent by opId (offline, or no answer). */
  enqueueUndo: () => Promise<void>;
  /** Null when the Undo may wait in the queue; otherwise why not (it is then never queued). */
  queueRefusal: QueueRefusal | null;
  /**
   * The person for the Undo: the original actor, with a PIN session when the level needs one
   * (`forcePin`: the server just refused the PIN, so ask again). Null: cancelled.
   */
  authorize: (forcePin: boolean) => Promise<UndoActor | null>;
  send: (actor: UndoActor) => Promise<UndoAnswer>;
  online: boolean;
  now: number;
};

export type UndoFlowResult =
  | { kind: 'undone' }
  /** Removed from the queue before it was ever sent. */
  | { kind: 'undone-locally' }
  | { kind: 'queued' }
  /** It can't wait in the queue (a PIN is needed, or the queue isn't durable): try again online. The entry stays undoable. */
  | { kind: 'needs-connection'; reason: QueueRefusal }
  | { kind: 'cancelled' }
  | { kind: 'refused'; code: DeviceRefusal; retryAfterSec?: number };

const PIN_CODES: ReadonlySet<DeviceRefusal> = new Set(['pin_required', 'pin_session_invalid', 'pin_fresh_required']);

/**
 * Runs an Undo tap for `entry` (the journal entry as currently stored, or as restored after
 * a reload). The route comes from the state machine (`undoRoute`).
 */
export async function runUndo(entry: UndoJournalEntry, deps: UndoFlowDeps): Promise<UndoFlowResult> {
  const step = (event: JournalEvent) => bestEffort(() => deps.step(event), undefined);
  let current = entry;
  const context = () => ({ now: deps.now, online: deps.online, undoCanWait: deps.queueRefusal === null });
  let route = undoRoute(current, context());
  if (route === 'remove-locally') {
    if (await bestEffort(() => deps.removeIfNeverSent(current.opId), false)) {
      await step({ type: 'undone', at: deps.now });
      return { kind: 'undone-locally' };
    }
    // It was sent meanwhile (another tab's sync, or this one's): it may be applied as of now.
    const sent: JournalEvent = { type: 'sync-retry', at: deps.now };
    current = journalStep(current, sent);
    await step(sent);
    route = undoRoute(current, context());
  }
  if (route === 'none') return { kind: 'refused', code: 'undo_expired' };
  const queueIt = async (): Promise<UndoFlowResult> => {
    if (deps.queueRefusal) return { kind: 'needs-connection', reason: deps.queueRefusal };
    try {
      await deps.enqueueUndo();
    } catch {
      return { kind: 'refused', code: 'unavailable' };
    }
    await step({ type: 'undo-sent', at: deps.now, queued: true });
    return { kind: 'queued' };
  };
  if (route === 'needs-connection') return { kind: 'needs-connection', reason: deps.queueRefusal ?? 'not-durable' };
  if (route === 'queue-undo') return queueIt();

  let actor = await deps.authorize(false);
  if (!actor) return { kind: 'cancelled' };
  await step({ type: 'undo-sent', at: deps.now, queued: false });
  let answer: UndoAnswer;
  try {
    answer = await deps.send(actor);
    if (!answer.ok && PIN_CODES.has(answer.code)) {
      actor = await deps.authorize(true);
      if (!actor) {
        await step({ type: 'undo-back', at: deps.now });
        return { kind: 'cancelled' };
      }
      answer = await deps.send(actor);
    }
  } catch {
    // No answer: the Undo waits in the queue (the server's tombstone makes the order irrelevant),
    // or, when it can't wait, the entry goes back to offering it.
    const queued = await queueIt();
    if (queued.kind !== 'queued') await step({ type: 'undo-back', at: deps.now });
    return queued;
  }
  if (!answer.ok) {
    await step(undoRefusalEvent(answer.code, deps.now));
    return { kind: 'refused', code: answer.code, ...(answer.retryAfterSec !== undefined ? { retryAfterSec: answer.retryAfterSec } : {}) };
  }
  await step({ type: 'undone', at: deps.now });
  return { kind: 'undone' };
}

/**
 * Callbacks to run when an action is taken back: its Undo succeeded (on the server or by
 * removing a never-sent queue entry), or its queued replay was dropped. In memory only
 * (the dashboard's local "Done" state lives as long as the page).
 */
export function createRevertRegistry() {
  const callbacks = new Map<string, () => void>();
  return {
    register: (opId: string, callback: (() => void) | undefined) => {
      if (callback) callbacks.set(opId.toLowerCase(), callback);
    },
    revert: (opId: string) => {
      const key = opId.toLowerCase();
      const callback = callbacks.get(key);
      callbacks.delete(key);
      callback?.();
    },
    forget: (opId: string) => { callbacks.delete(opId.toLowerCase()); },
    size: () => callbacks.size,
  };
}
