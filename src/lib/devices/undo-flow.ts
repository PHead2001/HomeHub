// Undo of a tablet action (docs/modules/devices/README.md, "Device actions"; design 10.3,
// R1). Framework-free so the order of steps is unit-tested; the tablet's runtime
// (src/components/devices/use-device-actions.tsx) supplies the steps.
//
// - Local storage (the queue and the Undo journal in IndexedDB) is best effort: when it
//   can't be read or written, the Undo still goes to the server by opId.
// - The person is authorized as for any action: when the Undo's level needs a PIN
//   (the household's points-PIN setting), the original actor's PIN pad comes first, also for
//   an Undo restored from the journal after a reload; a PIN refusal from the server asks once
//   more and retries.
// - A queue entry that never left the tablet is removed locally (the server never knew).

import type { DeviceRefusal } from './action-policy';
import { planUndo, type QueuedDeviceAction } from './offline-queue';
import type { UndoJournalEntry } from './undo-journal';

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

export type UndoFlowDeps = {
  queueGet: (opId: string) => Promise<QueuedDeviceAction | undefined>;
  removeIfNeverSent: (opId: string) => Promise<boolean>;
  markJournal: (opId: string, patch: Partial<Pick<UndoJournalEntry, 'state' | 'respondedAt'>>) => Promise<void>;
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

const bestEffort = async <T,>(work: () => Promise<T>, fallback: T): Promise<T> => {
  try {
    return await work();
  } catch {
    return fallback;
  }
};

export async function runUndo(entry: UndoJournalEntry, deps: UndoFlowDeps): Promise<UndoFlowResult> {
  const queued = await bestEffort(() => deps.queueGet(entry.opId), undefined);
  const plan = planUndo({ queued, originalViaQueue: entry.viaQueue, sentAt: entry.respondedAt ?? entry.sentAt, online: deps.online, now: deps.now });
  if (plan.kind === 'refuse') return { kind: 'refused', code: plan.code };
  if (plan.kind === 'remove-locally' && await bestEffort(() => deps.removeIfNeverSent(entry.opId), false)) {
    await bestEffort(() => deps.markJournal(entry.opId, { state: 'undone' }), undefined);
    return { kind: 'undone-locally' };
  }
  const queueIt = async (): Promise<UndoFlowResult> => {
    if (deps.queueRefusal) {
      await bestEffort(() => deps.markJournal(entry.opId, { state: 'confirmed' }), undefined);
      return { kind: 'needs-connection', reason: deps.queueRefusal };
    }
    try {
      await deps.enqueueUndo();
      return { kind: 'queued' };
    } catch {
      await bestEffort(() => deps.markJournal(entry.opId, { state: 'confirmed' }), undefined);
      return { kind: 'refused', code: 'unavailable' };
    }
  };
  if (plan.kind === 'queue') return queueIt();

  let actor = await deps.authorize(false);
  if (!actor) return { kind: 'cancelled' };
  await bestEffort(() => deps.markJournal(entry.opId, { state: 'undoing' }), undefined);
  let answer: UndoAnswer;
  try {
    answer = await deps.send(actor);
    if (!answer.ok && PIN_CODES.has(answer.code)) {
      actor = await deps.authorize(true);
      if (!actor) {
        await bestEffort(() => deps.markJournal(entry.opId, { state: 'confirmed' }), undefined);
        return { kind: 'cancelled' };
      }
      answer = await deps.send(actor);
    }
  } catch {
    // No answer: the Undo waits in the queue (the server's tombstone makes the order irrelevant).
    return queueIt();
  }
  if (!answer.ok) {
    await bestEffort(() => deps.markJournal(entry.opId, { state: 'confirmed' }), undefined);
    return { kind: 'refused', code: answer.code, ...(answer.retryAfterSec !== undefined ? { retryAfterSec: answer.retryAfterSec } : {}) };
  }
  await bestEffort(() => deps.markJournal(entry.opId, { state: 'undone' }), undefined);
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
