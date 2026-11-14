'use client';

// The tablet's path to the server's device actions (docs/modules/devices/README.md,
// "Device actions"; design 10.3, 11, R1). For a capability the tablet can send:
// - the opId is made before the first attempt and reused by every retry (the server's op
//   ledger replays it);
// - every action has one Undo journal entry moving through one state machine
//   (src/lib/devices/undo-journal.ts): written before the first attempt, moved by the live
//   answer, by sync and by Undo, so a reload brings the Undo toast back for the time left;
// - offline (or with no answer), a face-level queueable action waits in the durable queue
//   and syncs later through the same server action, with the original person and intent;
//   a sent action with no answer that can't wait keeps its opId and its Undo;
// - Undo is always sent to the server by opId, except for a queue entry that never left
//   the tablet, which is removed together with its Undo.

import { useCallback, useEffect, useRef } from 'react';
import { ToastAction } from '@/components/ui/toast';
import { toast } from '@/hooks/use-toast';
import type { DeviceCapability, DeviceRefusal, PointsPinPolicy } from '@/lib/devices/action-policy';
import { choreAnswerMeaning, queuedSendResult, UNDO_CAPABILITY_OF } from '@/lib/devices/device-action-answers';
import { createRevertRegistry, performAction, QUEUE_REFUSAL_COPY, queueRefusal, runUndo } from '@/lib/devices/undo-flow';
import { deviceStore } from '@/lib/devices/device-store';
import {
  createQueuedAction,
  dropNotice,
  enqueue,
  queueAllowed,
  removeIfNeverSent,
  syncQueue,
  withSendFields,
  type QueuedDeviceAction,
  type SendResult,
} from '@/lib/devices/offline-queue';
import {
  journalStep,
  recordAttempt,
  restoreJournal,
  stepJournal,
  undoOffer,
  undoRefusalEvent,
  type JournalEvent,
  type UndoJournalEntry,
} from '@/lib/devices/undo-journal';
import type { RosterPerson } from '@/lib/devices/roster';
import {
  completeChoreFromTabletAction,
  takeChoreFromTabletAction,
  undoChoreCompletionFromTabletAction,
  undoTakeChoreFromTabletAction,
} from '@/app/chores/device-actions';
import type { TabletActor } from './tablet-context';

type Answer = { ok: true; data: unknown } | { ok: false; code: DeviceRefusal; retryAfterSec?: number };
type Base = { idToken: string; householdId: string; actorUid: string; pinSessionId?: string; opId: string; queued?: { createdAt: string; generation: number } };

/** The server action for each capability the tablet can send (F4a: chores). */
const SENDERS: Partial<Record<DeviceCapability, (base: Base, intent: Readonly<Record<string, unknown>>) => Promise<Answer>>> = {
  'chores.complete': (base, intent) => completeChoreFromTabletAction({ ...base, choreId: String(intent.choreId ?? '') }),
  'chores.complete.undo': (base) => undoChoreCompletionFromTabletAction(base),
  'chores.take': (base, intent) => takeChoreFromTabletAction({ ...base, choreId: String(intent.choreId ?? '') }),
  'chores.take.undo': (base) => undoTakeChoreFromTabletAction(base),
};

export const canSend = (capability: DeviceCapability): boolean => Boolean(SENDERS[capability]);

const SYNC_EVERY_MS = 30_000;

/** A sent action with no answer, which can't wait in the queue: the server may hold it. */
export const UNKNOWN_OUTCOME_COPY = "No answer from HomeHub. It may have been saved; Undo takes it back if it was.";
const QUEUED_COPY = 'Saved on this tablet. It syncs when the connection is back.';

export type UndoAuthorization = { actorUid: string; capability: DeviceCapability; pinSessionId?: string; forcePin: boolean };

export type DeviceActionRuntime = {
  /**
   * `ok`: applied, or saved on this tablet (`queued`: not applied yet). `uncertain`: sent with
   * no answer; it may have been applied (its Undo is offered). `onReverted` runs if the action
   * is taken back later: its Undo succeeds (also a never-sent queue entry removed locally) or
   * its queued replay is dropped (the dashboard then clears its local "Done").
   */
  perform: (input: { capability: DeviceCapability; label: string; intent: Record<string, unknown>; actor: TabletActor; who: RosterPerson; onReverted?: () => void }) => Promise<{ ok: boolean; queued?: boolean; uncertain?: boolean }>;
};

export function useDeviceActions(deps: {
  householdId: string;
  deviceId: string;
  generation: number;
  pointsPin: PointsPinPolicy;
  idToken: () => Promise<string>;
  /** Shows a refusal (8.5 copy) and runs the revocation flow when needed. */
  refuse: (code: DeviceRefusal, who?: RosterPerson | null, retryAfterSec?: number) => void;
  onRevoked: () => void;
  /**
   * The person for an Undo: the original actor, through the shell's authorization (their PIN
   * pad when the Undo's level needs a PIN, also for an Undo restored after a reload).
   * `pinSessionId` is a session already held; `forcePin` asks again after a PIN refusal.
   */
  authorizeUndo: (input: UndoAuthorization) => Promise<TabletActor | null>;
  /** A person on the live roster (an Undo restored after a reload knows only the uid). */
  personOf: (uid: string) => RosterPerson | null;
}): DeviceActionRuntime {
  const { householdId, deviceId, generation, pointsPin, idToken } = deps;
  // The callbacks below stay stable across renders (the sync and restore effects run once).
  const latest = useRef(deps);
  useEffect(() => { latest.current = deps; });
  const refuse = useCallback((code: DeviceRefusal, who?: RosterPerson | null, retryAfterSec?: number) => latest.current.refuse(code, who, retryAfterSec), []);
  const onRevoked = useCallback(() => latest.current.onRevoked(), []);
  const authorizeUndo = useCallback((input: UndoAuthorization) => latest.current.authorizeUndo(input), []);
  const personOf = useCallback((uid: string) => latest.current.personOf(uid), []);
  const reverts = useRef(createRevertRegistry());
  const session = useRef({ householdId, deviceId, generation });
  useEffect(() => { session.current = { householdId, deviceId, generation }; }, [householdId, deviceId, generation]);
  const stores = useRef<{ queue: ReturnType<typeof deviceStore<QueuedDeviceAction>>; journal: ReturnType<typeof deviceStore<UndoJournalEntry>> } | null>(null);
  const storesOf = useCallback(() => {
    stores.current ??= { queue: deviceStore<QueuedDeviceAction>('queue'), journal: deviceStore<UndoJournalEntry>('undo') };
    return stores.current;
  }, []);

  // --- The journal: stored (best effort) and mirrored in memory, so an Undo works even when
  // storage fails. Every change is one state-machine event.
  const mirror = useRef(new Map<string, UndoJournalEntry>());
  const recordEntry = useCallback(async (entry: UndoJournalEntry) => {
    mirror.current.set(entry.opId, entry);
    await recordAttempt(storesOf().journal, entry);
  }, [storesOf]);
  const step = useCallback(async (opId: string, event: JournalEvent) => {
    const key = opId.toLowerCase();
    const known = mirror.current.get(key);
    if (known) mirror.current.set(key, journalStep(known, event));
    const stored = await stepJournal(storesOf().journal, key, event);
    if (!known && stored) mirror.current.set(key, stored);
  }, [storesOf]);
  const currentEntry = useCallback(async (entry: UndoJournalEntry): Promise<UndoJournalEntry> => {
    const key = entry.opId.toLowerCase();
    const known = mirror.current.get(key);
    if (known) return known;
    const stored = await storesOf().journal.get(key).catch(() => undefined);
    return stored ?? entry;
  }, [storesOf]);

  const send = useCallback(async (capability: DeviceCapability, base: Omit<Base, 'idToken' | 'householdId'>, intent: Readonly<Record<string, unknown>>): Promise<Answer> => {
    const sender = SENDERS[capability];
    if (!sender) return { ok: false, code: 'not_on_tablets' };
    return sender({ ...base, idToken: await idToken(), householdId }, intent);
  }, [householdId, idToken]);

  // --- Sync of the durable queue (11.3) -------------------------------------
  const syncing = useRef(false);
  const sync = useCallback(async () => {
    if (syncing.current || (typeof navigator !== 'undefined' && navigator.onLine === false)) return;
    syncing.current = true;
    try {
      const { queue } = storesOf();
      const report = await syncQueue({
        store: queue,
        session: session.current,
        now: () => Date.now(),
        send: async (entry): Promise<SendResult> => {
          const answer = await send(entry.capability, {
            actorUid: entry.actorUid,
            // An Undo intent is sent by the original action's opId.
            opId: entry.kind === 'undo' && entry.original ? entry.original.opId : entry.opId,
            queued: { createdAt: entry.createdAt, generation: entry.generation },
          }, entry.intent);
          // Domain refusals answered "ok" (not due yet, gone, already done by someone) are dropped with a notice.
          return queuedSendResult(entry.capability, answer);
        },
        // The journal follows the queue: sent, confirmed (the server's window starts now), refused, or sent without an answer.
        onSending: (entry) => (entry.kind === 'action' ? step(entry.opId, { type: 'sync-sending', at: Date.now() }) : undefined),
        onResult: (entry, outcome, result) => {
          const at = Date.now();
          if (entry.kind === 'action') {
            if (outcome === 'delete') return step(entry.opId, result.ok ? { type: 'sync-confirmed', at } : { type: 'undone', at });
            if (outcome === 'drop') return step(entry.opId, { type: 'refused', at });
            if (outcome === 'retry') return step(entry.opId, { type: 'sync-retry', at });
            return undefined;
          }
          if (!entry.original) return undefined;
          if (outcome === 'delete') return step(entry.original.opId, { type: 'undone', at });
          if (outcome === 'drop' && !result.ok) return step(entry.original.opId, undoRefusalEvent(result.code, at));
          return undefined;
        },
      });
      if (report.revoked) return onRevoked();
      for (const { entry } of report.dropped) reverts.current.revert(entry.kind === 'action' ? entry.opId : '');
      const notice = dropNotice(report.dropped);
      if (notice) toast({ description: notice });
    } catch {
      // The queue tries again on the next connection or tick.
    } finally {
      syncing.current = false;
    }
  }, [onRevoked, send, step, storesOf]);

  useEffect(() => {
    void sync();
    const id = window.setInterval(() => void sync(), SYNC_EVERY_MS);
    const online = () => void sync();
    window.addEventListener('online', online);
    return () => {
      window.clearInterval(id);
      window.removeEventListener('online', online);
    };
  }, [sync]);

  // --- Undo -------------------------------------------------------------------
  // The toast that offers an Undo (set below once `offerUndo` exists): an Undo that didn't go through is offered again.
  const offerUndoRef = useRef<((entry: UndoJournalEntry, actor: TabletActor, who: RosterPerson | null, message: string, remainingMs: number) => void) | null>(null);
  const undoOf = useCallback(async (shown: UndoJournalEntry, actor: TabletActor, who: RosterPerson | null) => {
    const undoCapability = UNDO_CAPABILITY_OF[shown.capability];
    if (!undoCapability) return;
    const { queue } = storesOf();
    // The entry as it is now (sync may have moved it since the toast appeared).
    const entry = await currentEntry(shown);
    const role = (who ?? personOf(entry.actorUid))?.role ?? null;
    const result = await runUndo(entry, {
      // A PIN-level Undo (points PIN) is never queued: queued sends carry no PIN session.
      queueRefusal: queueRefusal({ queueable: queueAllowed(undoCapability, { pointsPin: latest.current.pointsPin, actorRole: role }), durable: queue.durable }),
      removeIfNeverSent: (opId) => removeIfNeverSent(queue, opId),
      step: (event) => step(entry.opId, event),
      enqueueUndo: async () => {
        await enqueue(queue, createQueuedAction({
          opId: crypto.randomUUID(), kind: 'undo', ...session.current, capability: undoCapability,
          actorUid: entry.actorUid, actorName: who?.name ?? '', intent: {}, original: { opId: entry.opId, queued: entry.viaQueue },
        }, new Date()));
      },
      authorize: (forcePin) => authorizeUndo({ actorUid: entry.actorUid, capability: undoCapability, pinSessionId: forcePin ? undefined : actor.pinSessionId, forcePin }),
      send: (undoActor) => send(undoCapability, { actorUid: undoActor.actorUid, opId: entry.opId, ...(undoActor.pinSessionId ? { pinSessionId: undoActor.pinSessionId } : {}) }, {}),
      online: typeof navigator === 'undefined' || navigator.onLine !== false,
      now: Date.now(),
    });
    const offerAgain = async (message: string) => {
      const now = await currentEntry(entry);
      const { remainingMs } = undoOffer(now, Date.now());
      if (remainingMs > 0) offerUndoRef.current?.(now, actor, who, message, remainingMs);
      else toast({ description: message });
    };
    switch (result.kind) {
      case 'undone':
      case 'undone-locally':
        reverts.current.revert(entry.opId);
        toast({ description: 'Undone.' });
        return;
      case 'queued':
        // Never promises more than the server will do: a late Undo is refused, and the queue then says so.
        toast({ description: "Undo saved on this tablet. It's sent when the connection is back, if it's still in time." });
        return;
      case 'needs-connection':
        // The Undo stays offered for the time left; tapping it again (online) re-runs the PIN flow.
        return offerAgain(QUEUE_REFUSAL_COPY[result.reason]);
      case 'cancelled':
        return;
      default:
        refuse(result.code, who, result.retryAfterSec);
        // A passing refusal (an outage) leaves the Undo offered for the time left.
        if ((await currentEntry(entry)).state !== 'expired') await offerAgain(entry.label);
    }
  }, [authorizeUndo, currentEntry, personOf, refuse, send, step, storesOf]);

  const offerUndo = useCallback((entry: UndoJournalEntry, actor: TabletActor, who: RosterPerson | null, message: string, remainingMs: number) => {
    const handle = toast({
      group: 'device-action',
      description: message,
      duration: Math.max(1000, remainingMs),
      action: (
        <ToastAction altText={`Undo: ${entry.label}`} onClick={() => { handle.dismiss(); void undoOf(entry, actor, who); }} data-testid="tablet-undo">
          Undo
        </ToastAction>
      ),
    });
  }, [undoOf]);
  useEffect(() => { offerUndoRef.current = offerUndo; }, [offerUndo]);

  // After a reload: Undo toasts come back for the time that is left (the server's window decides).
  useEffect(() => {
    let stopped = false;
    void (async () => {
      try {
        // Stored as restored (a send the page lost is now an unknown outcome), then offered for the time left.
        const entries = await restoreJournal(storesOf().journal, Date.now(), session.current);
        if (stopped) return;
        for (const { entry, remainingMs } of entries) {
          mirror.current.set(entry.opId, entry);
          offerUndo(entry, { actorUid: entry.actorUid }, null, entry.label, remainingMs);
        }
      } catch {
        // No journal (storage blocked): nothing to restore.
      }
    })();
    return () => { stopped = true; };
  }, [offerUndo, storesOf]);

  // --- Actions ------------------------------------------------------------------
  const perform = useCallback<DeviceActionRuntime['perform']>(async ({ capability, label, intent, actor, who, onReverted }) => {
    const opId = crypto.randomUUID();
    reverts.current.register(opId, onReverted);
    const { queue } = storesOf();
    const undoCapability = UNDO_CAPABILITY_OF[capability];
    // Saved for later only when it can wait (face level, no PIN) and the queue is durable here.
    const canQueue = !actor.pinSessionId && queueAllowed(capability, { pointsPin, actorRole: who.role });
    const entry = { opId: opId.toLowerCase(), ...session.current, capability, actorUid: actor.actorUid, label };
    let meaning = { undoable: false, message: label } as ReturnType<typeof choreAnswerMeaning>;
    const result = await performAction({
      entry,
      undoable: Boolean(undoCapability),
      record: recordEntry,
      step: (event) => step(opId, event),
      queueRefusal: queueRefusal({ queueable: canQueue, durable: queue.durable }),
      enqueue: async (sent) => {
        const queued = createQueuedAction({ opId, kind: 'action', ...session.current, capability, actorUid: actor.actorUid, actorName: who.name, intent }, new Date());
        // An attempt that got no answer may have reached the server: it resends with the same opId.
        await enqueue(queue, sent ? withSendFields(queued, { attempts: 1, sendState: 'uncertain' }) : queued);
      },
      send: () => send(capability, { actorUid: actor.actorUid, opId, ...(actor.pinSessionId ? { pinSessionId: actor.pinSessionId } : {}) }, intent),
      undoableAnswer: (data) => {
        meaning = choreAnswerMeaning(capability, data, label);
        return meaning.undoable;
      },
      online: typeof navigator === 'undefined' || navigator.onLine !== false,
      now: () => Date.now(),
    });
    const offer = async (message: string) => {
      const current = mirror.current.get(opId.toLowerCase());
      const remainingMs = current ? undoOffer(current, Date.now()).remainingMs : 0;
      if (undoCapability && current && remainingMs > 0) offerUndo(current, actor, who, message, remainingMs);
      else toast({ description: message });
    };
    switch (result.kind) {
      case 'applied':
        await offer(meaning.message);
        return { ok: true };
      case 'queued':
        await offer(QUEUED_COPY);
        return { ok: true, queued: true };
      case 'unknown':
        // The opId is kept: the server may hold it, so its Undo is offered for the window left.
        reverts.current.forget(opId);
        await offer(UNKNOWN_OUTCOME_COPY);
        return { ok: false, uncertain: true };
      case 'noop':
        reverts.current.forget(opId);
        toast({ description: meaning.message });
        return { ok: !meaning.notice };
      case 'not-queued':
        reverts.current.forget(opId);
        toast({ variant: 'destructive', description: QUEUE_REFUSAL_COPY[result.reason] });
        return { ok: false };
      default:
        reverts.current.forget(opId);
        refuse(result.code, who, result.retryAfterSec);
        return { ok: false };
    }
  }, [offerUndo, pointsPin, recordEntry, refuse, send, step, storesOf]);

  return { perform };
}
