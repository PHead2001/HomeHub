import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import {
  RETRY_CAP_MS,
  SEND_FIELDS,
  classifySyncResult,
  createQueuedAction,
  dropNotice,
  enqueue,
  neverSent,
  planUndo,
  queueAllowed,
  removeIfNeverSent,
  retryDelay,
  syncQueue,
  belongsToSession,
  withSendFields,
  type QueuedDeviceAction,
  type SendResult,
} from '../../src/lib/devices/offline-queue';
import { memoryStore, withQueueLock } from '../../src/lib/devices/device-store';
import {
  expiredJournalEntries,
  journalEntry,
  journalRemainingMs,
  markJournal,
  pruneJournal,
  restorableUndos,
  type UndoJournalEntry,
} from '../../src/lib/devices/undo-journal';
import type { DeviceCapability } from '../../src/lib/devices/action-policy';

// The durable face-action queue and the Undo journal (docs/modules/devices/README.md,
// "Offline queue and Undo journal"; design 10.3, 11, re-review R1). Pure reducers and
// the store operations over the in-memory store (same interface as IndexedDB).

const T0 = Date.parse('2026-11-14T15:00:00Z');
const proven = new Set<DeviceCapability>(['pets.feed', 'pets.feed.undo', 'chores.complete', 'chores.complete.undo']);
const noLock = <R,>(work: () => Promise<R>) => work();
const SESSION = { householdId: 'H', deviceId: 'D'.repeat(20), generation: 2 };

const entry = (over: Partial<Parameters<typeof createQueuedAction>[0]> = {}, at = T0): QueuedDeviceAction => createQueuedAction({
  opId: randomUUID(), kind: 'action', householdId: 'H', deviceId: 'D'.repeat(20), generation: 2,
  capability: 'pets.feed', actorUid: 'mia', actorName: 'Mia', intent: { petId: 'maple', portion: { amount: 1, unit: 'cup' } }, ...over,
}, new Date(at));

describe('what may queue (11.1, WT-19f)', () => {
  it('only queueable capabilities that need face level right now', () => {
    const ctx = { pointsPin: 'off' as const, actorRole: 'member' as const };
    assert.equal(queueAllowed('pets.feed', ctx, proven), true);
    assert.equal(queueAllowed('pets.feed', ctx), false, 'not proven yet: PIN, never queued');
    assert.equal(queueAllowed('pets.feed.backdated.old', ctx, proven), false, 'PIN class');
    assert.equal(queueAllowed('device.settings', ctx, proven), false);
    assert.equal(queueAllowed('device.exit.remove', ctx, proven), false);
    assert.equal(queueAllowed('shopping.add', ctx, proven), false);
    assert.equal(queueAllowed('chores.complete', ctx, proven), true);
    assert.equal(queueAllowed('chores.complete', { pointsPin: 'everyone', actorRole: 'member' }, proven), false, 'points PIN on');
    assert.equal(queueAllowed('chores.complete', { pointsPin: 'kids', actorRole: 'child' }, proven), false);
    assert.equal(queueAllowed('chores.complete', { pointsPin: 'kids', actorRole: 'member' }, proven), true);
  });
});

describe('queued entries are immutable intents (WT-19g)', () => {
  it('freezes the intent and keeps the original actor and level', () => {
    const e = entry();
    assert.equal(e.level, 'face');
    assert.equal(e.actorUid, 'mia');
    assert.equal(neverSent(e), true);
    assert.throws(() => { (e.intent as Record<string, unknown>).petId = 'pixel'; });
    assert.throws(() => { ((e.intent as { portion: { amount: number } }).portion).amount = 9; });
  });

  it('send-field updates change nothing else', () => {
    const e = entry();
    const next = withSendFields(e, { attempts: 3, sendState: 'uncertain', lastError: 'failed', nextAttemptAt: 5, ...({ actorUid: 'sam', capability: 'chores.complete' } as object) });
    assert.equal(next.attempts, 3);
    assert.equal(next.actorUid, 'mia');
    assert.equal(next.capability, 'pets.feed');
    assert.deepEqual(Object.keys(e).filter((key) => (e as Record<string, unknown>)[key] !== (next as Record<string, unknown>)[key]).sort(), [...SEND_FIELDS].sort());
  });

  it('refuses malformed entries', () => {
    assert.throws(() => entry({ opId: 'not-a-uuid' }));
    assert.throws(() => entry({ capability: 'nope' as DeviceCapability }));
    assert.throws(() => entry({ kind: 'undo', capability: 'pets.feed.undo' }), /original/);
  });
});

describe('sync results (11.3)', () => {
  it('classifies every answer', () => {
    assert.equal(classifySyncResult({ ok: true }), 'delete');
    assert.equal(classifySyncResult({ ok: false, code: 'already_undone' }), 'delete');
    for (const code of ['device_revoked', 'wrong_household', 'household_deleting', 'unauthenticated', 'not_a_device'] as const) assert.equal(classifySyncResult({ ok: false, code }), 'revoked', code);
    for (const code of ['actor_not_member', 'actor_inactive', 'actor_guest', 'forbidden', 'section_off', 'pin_required', 'stale_intent', 'not_on_tablets', 'unclassified', 'changed_since', 'undo_expired', 'conflict', 'invalid_input'] as const) assert.equal(classifySyncResult({ ok: false, code }), 'drop', code);
    for (const code of ['unavailable', 'rate_limited', 'busy', 'failed'] as const) assert.equal(classifySyncResult({ ok: false, code }), 'retry', code);
  });

  it('backs off 5 s doubling to 5 min', () => {
    assert.deepEqual([1, 2, 3, 4].map(retryDelay), [5_000, 10_000, 20_000, 40_000]);
    assert.equal(retryDelay(30), RETRY_CAP_MS);
  });

  it('one plain notice for dropped entries', () => {
    const e = entry();
    assert.equal(dropNotice([{ entry: e, code: 'actor_not_member' }]), "1 change from this tablet couldn't be saved: Mia can no longer feed pets here.");
    assert.match(dropNotice([{ entry: e, code: 'pin_required' }, { entry: e, code: 'section_off' }])!, /^2 changes .* now needs a PIN\.$/);
    assert.equal(dropNotice([]), null);
  });
});

describe('syncQueue (11.3)', () => {
  const sender = (answers: Record<string, SendResult | 'throw'>) => {
    const sent: QueuedDeviceAction[] = [];
    return {
      sent,
      send: async (e: QueuedDeviceAction) => {
        sent.push(e);
        const answer = answers[e.opId] ?? { ok: true };
        if (answer === 'throw') throw new Error('network');
        return answer;
      },
    };
  };

  it('sends oldest first through the same action, marking each in flight durably first', async () => {
    const store = memoryStore<QueuedDeviceAction>();
    const a = entry({}, T0);
    const b = entry({ actorUid: 'sam', actorName: 'Sam' }, T0 + 1000);
    await enqueue(store, b, noLock);
    await enqueue(store, a, noLock);
    const states: string[] = [];
    const { send } = sender({});
    const report = await syncQueue({
      store, session: SESSION, now: () => T0 + 60_000, lock: noLock,
      send: async (e) => { states.push(`${e.actorUid}:${(await store.get(e.opId))?.sendState}:${e.attempts}`); return send(e); },
    });
    assert.deepEqual(states, ['mia:inflight:1', 'sam:inflight:1']);
    assert.equal(report.deleted, 2);
    assert.deepEqual(await store.all(), []);
  });

  it('keeps the original actor and intent even when face memory has long expired', async () => {
    const store = memoryStore<QueuedDeviceAction>();
    const a = entry({}, T0);
    await enqueue(store, a, noLock);
    const { send, sent } = sender({});
    await syncQueue({ store, session: SESSION, now: () => T0 + 3 * 60 * 60_000, lock: noLock, send });
    assert.equal(sent[0].actorUid, 'mia');
    assert.deepEqual(sent[0].intent, a.intent);
    assert.equal(sent[0].opId, a.opId);
  });

  it('discards entries of another credential generation unsent', async () => {
    const store = memoryStore<QueuedDeviceAction>();
    await enqueue(store, entry({ generation: 1 }), noLock);
    const { send, sent } = sender({});
    const report = await syncQueue({ store, session: SESSION, now: () => T0, lock: noLock, send });
    assert.equal(report.discarded, 1);
    assert.equal(sent.length, 0);
    assert.deepEqual(await store.all(), []);
  });

  it('discards entries of another device record or household, even at the same generation (pairings restart at 1)', async () => {
    const store = memoryStore<QueuedDeviceAction>();
    const mine = entry({}, T0);
    await enqueue(store, entry({ deviceId: 'E'.repeat(20) }, T0 + 1), noLock);
    await enqueue(store, entry({ householdId: 'H2' }, T0 + 2), noLock);
    await enqueue(store, mine, noLock);
    const { send, sent } = sender({});
    const report = await syncQueue({ store, session: SESSION, now: () => T0 + 10, lock: noLock, send });
    assert.equal(report.discarded, 2);
    assert.deepEqual(sent.map((e) => e.opId), [mine.opId], 'only this session\'s entry is sent');
    assert.equal(belongsToSession(mine, SESSION), true);
    assert.equal(belongsToSession(mine, { ...SESSION, deviceId: 'E'.repeat(20) }), false);
  });

  it('drops refused entries with a notice, keeps transient ones for a retry and stops there (order kept)', async () => {
    const store = memoryStore<QueuedDeviceAction>();
    const dropped = entry({}, T0);
    const transient = entry({}, T0 + 1);
    const later = entry({}, T0 + 2);
    for (const e of [dropped, transient, later]) await enqueue(store, e, noLock);
    const { send, sent } = sender({ [dropped.opId]: { ok: false, code: 'actor_not_member' }, [transient.opId]: 'throw' });
    const report = await syncQueue({ store, session: SESSION, now: () => T0 + 10, lock: noLock, send });
    assert.deepEqual(sent.map((e) => e.opId), [dropped.opId, transient.opId], 'later entries never overtake a failing one');
    assert.equal(report.dropped.length, 1);
    assert.equal(report.dropped[0].code, 'actor_not_member');
    const kept = await store.get(transient.opId);
    assert.equal(kept?.sendState, 'uncertain');
    assert.equal(kept?.attempts, 1);
    assert.equal(kept?.nextAttemptAt, T0 + 10 + 5_000);
    assert.equal(report.waiting, 2);
    // In backoff: nothing is sent.
    const again = sender({});
    await syncQueue({ store, session: SESSION, now: () => T0 + 4_000, lock: noLock, send: again.send });
    assert.equal(again.sent.length, 0);
    // After the backoff the same opId is resent (the server replays it if it had arrived).
    await syncQueue({ store, session: SESSION, now: () => T0 + 6_000, lock: noLock, send: again.send });
    assert.deepEqual(again.sent.map((e) => e.opId), [transient.opId, later.opId]);
    assert.equal(again.sent[0].attempts, 2);
    assert.deepEqual(await store.all(), []);
  });

  it('stops at a revocation code and reports it (the caller clears everything)', async () => {
    const store = memoryStore<QueuedDeviceAction>();
    const a = entry({}, T0);
    const b = entry({}, T0 + 1);
    await enqueue(store, a, noLock);
    await enqueue(store, b, noLock);
    const { send, sent } = sender({ [a.opId]: { ok: false, code: 'device_revoked' } });
    const report = await syncQueue({ store, session: SESSION, now: () => T0, lock: noLock, send });
    assert.equal(report.revoked, true);
    assert.equal(sent.length, 1);
  });

  it('never replays UI callbacks: the sender receives data only', async () => {
    const store = memoryStore<QueuedDeviceAction>();
    await enqueue(store, entry(), noLock);
    const { send, sent } = sender({});
    await syncQueue({ store, session: SESSION, now: () => T0, lock: noLock, send });
    const values: unknown[] = [...Object.values(sent[0]), ...Object.values(sent[0].intent)];
    assert.ok(values.every((value) => typeof value !== 'function'));
    assert.doesNotThrow(() => structuredClone(sent[0]));
  });

  it('refuses a duplicate opId', async () => {
    const store = memoryStore<QueuedDeviceAction>();
    const a = entry();
    await enqueue(store, a, noLock);
    await assert.rejects(enqueue(store, a, noLock), /already queued/);
  });

  it('one sync owner at a time (the queue lock serializes overlapping syncs)', async () => {
    const store = memoryStore<QueuedDeviceAction>();
    const a = entry();
    await enqueue(store, a, noLock);
    let inFlight = 0;
    let maxInFlight = 0;
    const send = async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return { ok: true } as const;
    };
    const lock = <R,>(work: () => Promise<R>) => withQueueLock(work, null);
    const [first, second] = await Promise.all([
      syncQueue({ store, session: SESSION, now: () => T0, lock, send }),
      syncQueue({ store, session: SESSION, now: () => T0, lock, send }),
    ]);
    assert.equal(maxInFlight, 1);
    assert.equal(first.sent + second.sent, 1, 'the entry is sent once');
  });
});

describe('Undo of queued and live actions (10.3, R1)', () => {
  it('a never-sent entry is removed locally, together with its Undo', async () => {
    const store = memoryStore<QueuedDeviceAction>();
    const a = entry();
    await enqueue(store, a, noLock);
    assert.deepEqual(planUndo({ queued: a, originalViaQueue: true, sentAt: null, online: false, now: T0 + 60_000 }), { kind: 'remove-locally' });
    assert.equal(await removeIfNeverSent(store, a.opId, noLock), true);
    assert.deepEqual(await store.all(), []);
  });

  it('an entry that may have been sent is never removed locally: the Undo is sent or queued by opId', async () => {
    const store = memoryStore<QueuedDeviceAction>();
    const sentOnce = withSendFields(entry(), { attempts: 1, sendState: 'uncertain' });
    await store.put(sentOnce);
    assert.equal(await removeIfNeverSent(store, sentOnce.opId, noLock), false);
    assert.equal((await store.all()).length, 1);
    assert.deepEqual(planUndo({ queued: sentOnce, originalViaQueue: true, sentAt: null, online: true, now: T0 + 3_600_000 }), { kind: 'send', originalQueued: true });
    assert.deepEqual(planUndo({ queued: sentOnce, originalViaQueue: true, sentAt: null, online: false, now: T0 }), { kind: 'queue', originalQueued: true });
    const inflight = withSendFields(entry(), { attempts: 1, sendState: 'inflight' });
    assert.equal(planUndo({ queued: inflight, originalViaQueue: true, sentAt: null, online: true, now: T0 }).kind, 'send');
  });

  it('R1: a live action\'s Undo is never extended by the device clock', () => {
    assert.deepEqual(planUndo({ queued: undefined, originalViaQueue: false, sentAt: T0, online: true, now: T0 + 9_000 }), { kind: 'send', originalQueued: false });
    assert.deepEqual(planUndo({ queued: undefined, originalViaQueue: false, sentAt: T0, online: false, now: T0 + 9_000 }), { kind: 'queue', originalQueued: false });
    assert.deepEqual(planUndo({ queued: undefined, originalViaQueue: false, sentAt: T0, online: true, now: T0 + 10_001 }), { kind: 'refuse', code: 'undo_expired' });
    // A queued original that already synced: the server bounds it against its stored appliedAt.
    assert.deepEqual(planUndo({ queued: undefined, originalViaQueue: true, sentAt: T0, online: true, now: T0 + 60_000 }), { kind: 'send', originalQueued: true });
  });

  it('an Undo intent records its original and whether that was queued', () => {
    const original = entry();
    const undo = entry({ kind: 'undo', capability: 'pets.feed.undo', intent: {}, original: { opId: original.opId, queued: true } });
    assert.deepEqual(undo.original, { opId: original.opId, queued: true });
    assert.throws(() => { (undo.original as { queued: boolean }).queued = false; });
  });
});

describe('Undo journal (10.3)', () => {
  const live = (over: Partial<UndoJournalEntry> = {}): UndoJournalEntry => ({
    ...journalEntry({ opId: randomUUID(), ...SESSION, capability: 'pets.feed', actorUid: 'mia', label: 'Fed Maple', sentAt: T0, viaQueue: false }),
    ...over,
  });

  it('counts the window from the server answer, on the device clock', () => {
    assert.equal(journalRemainingMs(live(), T0 + 4_000), 6_000, 'unanswered: from the send');
    assert.equal(journalRemainingMs(live({ respondedAt: T0 + 2_000, state: 'confirmed' }), T0 + 4_000), 8_000);
    assert.equal(journalRemainingMs(live({ respondedAt: T0, state: 'confirmed' }), T0 + 11_000), 0);
    assert.equal(journalRemainingMs(live({ viaQueue: true }), T0 + 1), 0, 'a queued action has no window until it syncs');
    assert.equal(journalRemainingMs(live({ state: 'undone', respondedAt: T0 }), T0 + 1), 0);
  });

  it('a reload restores the toasts that still have time, and prunes the rest', async () => {
    const store = memoryStore<UndoJournalEntry>();
    const fresh = live({ respondedAt: T0 + 5_000, state: 'confirmed' });
    const old = live({ respondedAt: T0 - 120_000, state: 'confirmed' });
    const undone = live({ state: 'undone', respondedAt: T0 });
    for (const e of [fresh, old, undone]) await store.put(e);
    const restored = restorableUndos(await store.all(), T0 + 6_000, SESSION);
    assert.deepEqual(restored.map((r) => [r.entry.opId, r.remainingMs]), [[fresh.opId, 9_000]]);
    assert.deepEqual(expiredJournalEntries(await store.all(), T0 + 6_000, SESSION).map((e) => e.opId).sort(), [old.opId, undone.opId].sort());
    assert.equal(await pruneJournal(store, T0 + 6_000, SESSION), 2);
    await markJournal(store, fresh.opId, { state: 'undone' });
    assert.equal((await store.get(fresh.opId))?.state, 'undone');
  });
});

describe('Undo journal entries belong to one tablet session', () => {
  it('another device record\'s or household\'s entries are never restored and are pruned', async () => {
    const store = memoryStore<UndoJournalEntry>();
    const base = { capability: 'pets.feed' as const, actorUid: 'mia', label: 'Fed Maple', sentAt: T0, viaQueue: false };
    const mine = { ...journalEntry({ opId: randomUUID(), ...SESSION, ...base }), respondedAt: T0, state: 'confirmed' as const };
    const otherDevice = { ...journalEntry({ opId: randomUUID(), ...SESSION, deviceId: 'E'.repeat(20), ...base }), respondedAt: T0, state: 'confirmed' as const };
    const otherHousehold = { ...journalEntry({ opId: randomUUID(), ...SESSION, householdId: 'H2', ...base }), respondedAt: T0, state: 'confirmed' as const };
    for (const e of [mine, otherDevice, otherHousehold]) await store.put(e);
    assert.deepEqual(restorableUndos(await store.all(), T0 + 1_000, SESSION).map((r) => r.entry.opId), [mine.opId]);
    assert.equal(await pruneJournal(store, T0 + 1_000, SESSION), 2);
    assert.deepEqual((await store.all()).map((e) => e.opId), [mine.opId]);
  });
});
