'use client';

// The tablet's path to the server's device actions (docs/modules/devices/README.md,
// "Device actions"; design 10.3, 11, R1). For a capability the tablet can send:
// - the opId is made before the first attempt and reused by every retry (the server's op
//   ledger replays it);
// - the Undo journal entry is written when the action is first attempted, so a reload
//   brings the Undo toast back for the time left;
// - offline (or with no answer), a face-level queueable action waits in the durable queue
//   and syncs later through the same server action, with the original person and intent;
// - Undo is always sent to the server by opId, except for a queue entry that never left
//   the tablet, which is removed together with its Undo.

import { useCallback, useEffect, useRef } from 'react';
import { ToastAction } from '@/components/ui/toast';
import { toast } from '@/hooks/use-toast';
import type { DeviceCapability, DeviceRefusal, PointsPinPolicy } from '@/lib/devices/action-policy';
import { choreAnswerMeaning, queuedSendResult, UNDO_CAPABILITY_OF } from '@/lib/devices/device-action-answers';
import { createRevertRegistry, QUEUE_REFUSAL_COPY, queueRefusal, runUndo } from '@/lib/devices/undo-flow';
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
  journalEntry,
  JOURNAL_UNDO_WINDOW_MS,
  journalRemainingMs,
  markJournal,
  pruneJournal,
  recordAttempt,
  restorableUndos,
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

export type UndoAuthorization = { actorUid: string; capability: DeviceCapability; pinSessionId?: string; forcePin: boolean };

export type DeviceActionRuntime = {
  /**
   * `queued`: saved on this tablet, not applied yet. `onReverted` runs if the action is taken
   * back later: its Undo succeeds (also a never-sent queue entry removed locally) or its
   * queued replay is dropped (the dashboard then clears its local "Done").
   */
  perform: (input: { capability: DeviceCapability; label: string; intent: Record<string, unknown>; actor: TabletActor; who: RosterPerson; onReverted?: () => void }) => Promise<{ ok: boolean; queued?: boolean }>;
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
      });
      if (report.revoked) return onRevoked();
      for (const { entry } of report.dropped) if (entry.kind === 'action') reverts.current.revert(entry.opId);
      const notice = dropNotice(report.dropped);
      if (notice) toast({ description: notice });
    } catch {
      // The queue tries again on the next connection or tick.
    } finally {
      syncing.current = false;
    }
  }, [onRevoked, send, storesOf]);

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
  // The toast that offers an Undo (set below once `offerUndo` exists): a needs-connection Undo is offered again.
  const offerUndoRef = useRef<((entry: UndoJournalEntry, actor: TabletActor, who: RosterPerson | null, message: string, remainingMs: number) => void) | null>(null);
  const undoOf = useCallback(async (entry: UndoJournalEntry, actor: TabletActor, who: RosterPerson | null) => {
    const undoCapability = UNDO_CAPABILITY_OF[entry.capability];
    if (!undoCapability) return;
    const { queue, journal } = storesOf();
    const role = (who ?? personOf(entry.actorUid))?.role ?? null;
    const result = await runUndo(entry, {
      // A PIN-level Undo (points PIN) is never queued: queued sends carry no PIN session.
      queueRefusal: queueRefusal({ queueable: queueAllowed(undoCapability, { pointsPin: latest.current.pointsPin, actorRole: role }), durable: queue.durable }),
      queueGet: (opId) => queue.get(opId),
      removeIfNeverSent: (opId) => removeIfNeverSent(queue, opId),
      markJournal: (opId, patch) => markJournal(journal, opId, patch),
      enqueueUndo: async () => {
        await enqueue(queue, createQueuedAction({
          opId: crypto.randomUUID(), kind: 'undo', ...session.current, capability: undoCapability,
          actorUid: entry.actorUid, actorName: who?.name ?? '', intent: {}, original: { opId: entry.opId, queued: true },
        }, new Date()));
      },
      authorize: (forcePin) => authorizeUndo({ actorUid: entry.actorUid, capability: undoCapability, pinSessionId: forcePin ? undefined : actor.pinSessionId, forcePin }),
      send: (undoActor) => send(undoCapability, { actorUid: undoActor.actorUid, opId: entry.opId, ...(undoActor.pinSessionId ? { pinSessionId: undoActor.pinSessionId } : {}) }, {}),
      online: typeof navigator === 'undefined' || navigator.onLine !== false,
      now: Date.now(),
    });
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
      case 'needs-connection': {
        // The Undo stays offered for the time left; tapping it again (online) re-runs the PIN flow.
        toast({ description: QUEUE_REFUSAL_COPY[result.reason] });
        const remainingMs = journalRemainingMs({ ...entry, state: 'confirmed' }, Date.now());
        if (remainingMs > 0) offerUndoRef.current?.(entry, actor, who, entry.label, remainingMs);
        return;
      }
      case 'cancelled':
        return;
      default:
        refuse(result.code, who, result.retryAfterSec);
    }
  }, [authorizeUndo, personOf, refuse, send, storesOf]);

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
        const { journal } = storesOf();
        await pruneJournal(journal, Date.now(), session.current);
        const entries = restorableUndos(await journal.all(), Date.now(), session.current);
        if (stopped) return;
        for (const { entry, remainingMs } of entries) offerUndo(entry, { actorUid: entry.actorUid }, null, entry.label, remainingMs);
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
    const { queue, journal } = storesOf();
    const undoCapability = UNDO_CAPABILITY_OF[capability];
    const canQueue = !actor.pinSessionId && queueAllowed(capability, { pointsPin, actorRole: who.role });
    const journalFor = (viaQueue: boolean) => journalEntry({ opId, ...session.current, capability, actorUid: actor.actorUid, label, sentAt: Date.now(), viaQueue });
    const queueIt = async (alreadySent: boolean) => {
      const entry = createQueuedAction({ opId, kind: 'action', ...session.current, capability, actorUid: actor.actorUid, actorName: who.name, intent }, new Date());
      // An attempt that got no answer may have reached the server: it resends with the same opId.
      await enqueue(queue, alreadySent ? withSendFields(entry, { attempts: 1, sendState: 'uncertain' }) : entry);
      const journalItem = journalFor(true);
      if (undoCapability) await recordAttempt(journal, journalItem).catch(() => undefined);
      if (undoCapability) offerUndo(journalItem, actor, who, 'Saved on this tablet. It syncs when the connection is back.', JOURNAL_UNDO_WINDOW_MS);
      else toast({ description: 'Saved on this tablet. It syncs when the connection is back.' });
    };
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      // Saved for later only when it can wait (face level, no PIN) and the queue is durable here.
      const refusal = queueRefusal({ queueable: canQueue, durable: queue.durable });
      if (refusal) {
        reverts.current.forget(opId);
        toast({ variant: 'destructive', description: QUEUE_REFUSAL_COPY[refusal] });
        return { ok: false };
      }
      try {
        await queueIt(false);
      } catch {
        reverts.current.forget(opId);
        refuse('failed', who);
        return { ok: false };
      }
      return { ok: true, queued: true };
    }
    const journalItem = journalFor(false);
    if (undoCapability) await recordAttempt(journal, journalItem).catch(() => undefined);
    let answer: Answer;
    try {
      answer = await send(capability, { actorUid: actor.actorUid, opId, ...(actor.pinSessionId ? { pinSessionId: actor.pinSessionId } : {}) }, intent);
    } catch {
      if (canQueue && queue.durable) {
        try {
          await queueIt(true);
          return { ok: true, queued: true };
        } catch {
          // Nothing could be stored: say so (the server may still have it; the opId replays).
        }
      }
      answer = { ok: false, code: 'unavailable' };
    }
    if (!answer.ok) {
      reverts.current.forget(opId);
      if (undoCapability) await markJournal(journal, opId, { state: 'undone' }).catch(() => undefined);
      refuse(answer.code, who, answer.retryAfterSec);
      return { ok: false };
    }
    const meaning = choreAnswerMeaning(capability, answer.data, label);
    const respondedAt = Date.now();
    if (undoCapability) await markJournal(journal, opId, meaning.undoable ? { state: 'confirmed', respondedAt } : { state: 'undone' }).catch(() => undefined);
    if (meaning.undoable && undoCapability) {
      offerUndo({ ...journalItem, state: 'confirmed', respondedAt }, actor, who, meaning.message, JOURNAL_UNDO_WINDOW_MS);
    } else {
      reverts.current.forget(opId);
      toast({ description: meaning.message });
    }
    return { ok: meaning.undoable || !meaning.notice };
  }, [offerUndo, pointsPin, refuse, send, storesOf]);

  return { perform };
}
