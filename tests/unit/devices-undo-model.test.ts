import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { memoryStore } from '../../src/lib/devices/device-store';
import {
  createQueuedAction,
  enqueue,
  removeIfNeverSent,
  syncQueue,
  withSendFields,
  type QueuedDeviceAction,
  type SendResult,
} from '../../src/lib/devices/offline-queue';
import { performAction, runUndo, type PerformResult, type UndoAnswer, type UndoFlowResult } from '../../src/lib/devices/undo-flow';
import {
  journalStep,
  recordAttempt,
  restoreJournal,
  stepJournal,
  undoOffer,
  undoRefusalEvent,
  type JournalEvent,
  type UndoJournalEntry,
} from '../../src/lib/devices/undo-journal';

// The Undo journal's state machine under random sequences (docs/modules/devices/README.md,
// "Offline queue and Undo journal"; design 10.3, 11, R1). The real action and Undo flows
// (performAction, runUndo), the real queue (enqueue, removeIfNeverSent, syncQueue with the
// journal hooks the tablet uses) and the real journal store, against a model server with an
// op ledger: live sends that succeed, are refused, get no answer (applied or not), a reload
// mid-send, offline saves, reloads, sync results, Undo taps (online, offline, PIN pad
// cancelled, no answer), time passing, face-level and PIN-level actions. Invariants after
// every step:
// 1. Undo is never lost while the server may hold the action applied inside its window: it
//    is offered, or an Undo is on its way.
// 2. Nothing is reported as done (or undone) when it wasn't.
// 3. Nothing is removed locally after it may have been sent.

const SESSION = { householdId: 'H', deviceId: 'D'.repeat(20), generation: 1 };
const T0 = Date.parse('2026-11-14T15:00:00Z');
/** The server's window (10 s); it accepts 5 s more for latency. */
const SERVER_WINDOW_MS = 10_000;
const SERVER_GRACE_MS = 5_000;
const noLock = <R,>(work: () => Promise<R>) => work();

const rng = (seed: number) => () => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

type Mode = 'ok' | 'refuse' | 'noop' | 'unknown-applied' | 'unknown-lost';

async function runSequence(seed: number, length: number) {
  const random = rng(seed);
  const pick = <T,>(items: readonly T[]): T => items[Math.floor(random() * items.length)];
  let now = T0;
  let online = true;
  const pinLevel = random() < 0.3;
  const opId = `00000000-0000-4000-8000-${String(seed).padStart(12, '0')}`;
  const queue = memoryStore<QueuedDeviceAction>();
  const journal = memoryStore<UndoJournalEntry>();
  const server = { applied: false, appliedAt: 0, undone: false, tombstone: false, received: false };
  const log: string[] = [];
  let performed = false;

  const actionCall = (mode: Mode): { ok: true } | { ok: false; code: 'forbidden' | 'already_undone' } | 'throw' | { noop: true } => {
    if (mode === 'unknown-lost') return 'throw';
    server.received = true;
    if (server.tombstone || server.undone) return { ok: false, code: 'already_undone' };
    if (server.applied) return mode === 'unknown-applied' ? 'throw' : { ok: true };
    if (mode === 'refuse') return { ok: false, code: 'forbidden' };
    if (mode === 'noop') return { noop: true };
    server.applied = true;
    server.appliedAt = now;
    return mode === 'unknown-applied' ? 'throw' : { ok: true };
  };
  const undoCall = (): UndoAnswer => {
    if (!server.applied && !server.undone) {
      server.tombstone = true;
      return { ok: true, data: { status: 'not_applied' } };
    }
    if (server.undone) return { ok: true, data: { status: 'already' } };
    if (now > server.appliedAt + SERVER_WINDOW_MS + SERVER_GRACE_MS) return { ok: false, code: 'undo_expired' };
    server.undone = true;
    return { ok: true, data: { status: 'undone' } };
  };
  const step = (id: string, event: JournalEvent) => stepJournal(journal, id, event).then(() => undefined);
  const current = async () => (await journal.get(opId)) ?? null;
  const removeWatched = async (id: string) => {
    const removed = await removeIfNeverSent(queue, id, noLock);
    // 3. Removed locally only when it never left the tablet.
    if (removed) assert.equal(server.received, false, `seed ${seed}: removed locally after it may have been sent (${log.join(' → ')})`);
    return removed;
  };

  const check = async (lastPerform: PerformResult | null, lastUndo: UndoFlowResult | null) => {
    const entry = await current();
    const trail = `seed ${seed}: ${log.join(' → ')}`;
    // 1. Never lost while the server may hold it applied in its window.
    if (server.applied && !server.undone && now < server.appliedAt + SERVER_WINDOW_MS) {
      assert.ok(entry, `${trail}: no journal entry`);
      const offered = undoOffer(entry!, now).offered;
      assert.ok(offered || entry!.state === 'undo-pending', `${trail}: Undo lost in state ${entry!.state}`);
    }
    // 2. Nothing reported done or undone when it wasn't.
    if (entry?.state === 'applied') assert.ok(server.applied, `${trail}: applied without the server`);
    if (entry?.state === 'undone') assert.ok(!server.applied || server.undone, `${trail}: undone while the server holds it`);
    if (lastPerform?.kind === 'applied') assert.ok(server.applied, `${trail}: reported applied`);
    if (lastUndo?.kind === 'undone') assert.ok(server.undone || server.tombstone || !server.applied, `${trail}: reported undone`);
    if (lastUndo?.kind === 'undone-locally') assert.equal(server.received, false, `${trail}: undone locally after sending`);
  };

  const sync = async () => {
    if (!online) return;
    await syncQueue({
      store: queue,
      session: SESSION,
      now: () => now,
      lock: noLock,
      send: async (entry): Promise<SendResult> => {
        if (entry.kind === 'undo') {
          if (random() < 0.2) {
            if (random() < 0.5) undoCall();
            throw new Error('network');
          }
          const answer = undoCall();
          return answer.ok ? { ok: true } : { ok: false, code: answer.code };
        }
        const result = actionCall(pick(['ok', 'ok', 'refuse', 'unknown-applied', 'unknown-lost'] as const));
        if (result === 'throw') throw new Error('network');
        if ('noop' in result) return { ok: false, code: 'invalid_input' };
        return result;
      },
      onSending: (entry) => (entry.kind === 'action' ? step(entry.opId, { type: 'sync-sending', at: now }) : undefined),
      onResult: (entry, outcome, result) => {
        if (entry.kind === 'action') {
          if (outcome === 'delete') return step(entry.opId, result.ok ? { type: 'sync-confirmed', at: now } : { type: 'undone', at: now });
          if (outcome === 'drop') return step(entry.opId, { type: 'refused', at: now });
          if (outcome === 'retry') return step(entry.opId, { type: 'sync-retry', at: now });
          return undefined;
        }
        if (!entry.original) return undefined;
        if (outcome === 'delete') return step(entry.original.opId, { type: 'undone', at: now });
        if (outcome === 'drop' && !result.ok) return step(entry.original.opId, undoRefusalEvent(result.code, now));
        return undefined;
      },
    });
  };

  const perform = async (mode: Mode | 'reload-mid-send') => {
    performed = true;
    const deps = {
      entry: { opId, ...SESSION, capability: 'chores.complete' as const, actorUid: 'mia', label: 'Dishes' },
      undoable: true,
      record: (e: UndoJournalEntry) => recordAttempt(journal, e),
      step: (event: JournalEvent) => step(opId, event),
      queueRefusal: pinLevel ? 'needs-pin' as const : null,
      enqueue: async (sent: boolean) => {
        const entry = createQueuedAction({ opId, kind: 'action', ...SESSION, capability: 'chores.complete', actorUid: 'mia', actorName: 'Mia', intent: {} }, new Date(now));
        await enqueue(queue, sent ? withSendFields(entry, { attempts: 1, sendState: 'uncertain' }) : entry, noLock);
      },
      send: async (): Promise<UndoAnswer> => {
        if (mode === 'reload-mid-send') {
          if (random() < 0.5) actionCall('ok');
          // The page goes away: this promise never settles.
          return new Promise<UndoAnswer>(() => undefined);
        }
        const result = actionCall(mode);
        if (result === 'throw') throw new Error('network');
        if ('noop' in result) return { ok: true, data: { noop: true } };
        return result.ok ? { ok: true, data: {} } : result;
      },
      undoableAnswer: (data: unknown) => !(data as { noop?: boolean }).noop,
      online,
      now: () => now,
    };
    if (mode === 'reload-mid-send') {
      void performAction(deps);
      await new Promise((resolve) => setImmediate(resolve));
      await restoreJournal(journal, now, SESSION);
      return null;
    }
    return performAction(deps);
  };

  const undo = async (): Promise<UndoFlowResult | null> => {
    const entry = await current();
    // The button is there only while it is offered.
    if (!entry || !undoOffer(entry, now).offered) return null;
    return runUndo(entry, {
      removeIfNeverSent: removeWatched,
      step: (event) => step(opId, event),
      enqueueUndo: async () => {
        await enqueue(queue, createQueuedAction({ opId: `u-${opId}-${now}`, kind: 'undo', ...SESSION, capability: 'chores.complete.undo', actorUid: 'mia', actorName: 'Mia', intent: {}, original: { opId, queued: entry.viaQueue } }, new Date(now)), noLock);
      },
      queueRefusal: pinLevel ? 'needs-pin' : null,
      authorize: async () => (random() < 0.1 ? null : { actorUid: 'mia', ...(pinLevel ? { pinSessionId: 'session' } : {}) }),
      send: async () => {
        const roll = random();
        if (roll < 0.15) {
          if (random() < 0.5) undoCall();
          throw new Error('network');
        }
        return undoCall();
      },
      online,
      now,
    });
  };

  for (let i = 0; i < length; i += 1) {
    let lastPerform: PerformResult | null = null;
    let lastUndo: UndoFlowResult | null = null;
    const move = performed
      ? pick(['undo', 'undo', 'time', 'time', 'offline', 'online', 'sync', 'sync', 'reload'] as const)
      : pick(['perform', 'perform', 'offline', 'online'] as const);
    switch (move) {
      case 'perform': {
        const mode = pick(['ok', 'ok', 'refuse', 'noop', 'unknown-applied', 'unknown-lost', 'reload-mid-send'] as const);
        log.push(`perform:${mode}${online ? '' : ':offline'}${pinLevel ? ':pin' : ''}`);
        lastPerform = await perform(online ? mode : 'ok');
        break;
      }
      case 'undo':
        log.push(`undo${online ? '' : ':offline'}`);
        lastUndo = await undo();
        if (lastUndo) log.push(lastUndo.kind);
        break;
      case 'time': {
        const ms = pick([500, 1_000, 2_000, 4_000, 8_000]);
        now += ms;
        log.push(`+${ms}`);
        break;
      }
      case 'offline':
        online = false;
        log.push('offline');
        break;
      case 'online':
        online = true;
        log.push('online');
        break;
      case 'sync':
        log.push('sync');
        await sync();
        break;
      case 'reload':
        log.push('reload');
        await restoreJournal(journal, now, SESSION);
        break;
    }
    await check(lastPerform, lastUndo);
  }
}

describe('the Undo journal under random sequences (model)', () => {
  it('600 sequences of 30 steps keep every invariant', async () => {
    for (let seed = 1; seed <= 600; seed += 1) await runSequence(seed, 30);
  });
});

describe('the journal state machine, case by case', () => {
  const fresh = (queued = false) => ({
    opId: 'op', ...SESSION, capability: 'chores.complete' as const, actorUid: 'mia', label: 'Dishes',
    state: queued ? 'queued-unsent' as const : 'attempting' as const, createdAt: T0, windowFrom: queued ? T0 : null, viaQueue: queued, undo: null,
  });

  it('an unknown transport outcome keeps the opId and offers Undo for the window left', () => {
    const unknown = journalStep(fresh(), { type: 'no-answer', at: T0 + 3_000, queued: false });
    assert.equal(unknown.state, 'unknown-outcome');
    assert.deepEqual(undoOffer(unknown, T0 + 5_000), { offered: true, remainingMs: 8_000 });
  });

  it('an explicit refusal ends it, and a late event never revives a final state', () => {
    const refused = journalStep(fresh(), { type: 'refused', at: T0 });
    assert.equal(refused.state, 'refused');
    assert.equal(journalStep(refused, { type: 'answered', at: T0, undoable: true }).state, 'refused');
    assert.equal(undoOffer(refused, T0).offered, false);
  });

  it('a queued action: a local window while unsent, then the server window once sync confirms it', () => {
    const queued = fresh(true);
    assert.equal(undoOffer(queued, T0 + 11_000).offered, false, 'the local window ended');
    const confirmed = journalStep(journalStep(queued, { type: 'sync-sending', at: T0 + 60_000 }), { type: 'sync-confirmed', at: T0 + 61_000 });
    assert.equal(confirmed.state, 'applied');
    assert.deepEqual(undoOffer(confirmed, T0 + 62_000), { offered: true, remainingMs: 9_000 });
  });

  it('a page lost mid-send restores as an unknown outcome; a live Undo lost mid-send is offered again', async () => {
    const store = memoryStore<UndoJournalEntry>();
    await store.put(fresh());
    const [restored] = await restoreJournal(store, T0 + 2_000, SESSION);
    assert.equal(restored.entry.state, 'unknown-outcome');
    assert.equal((await store.get('op'))?.state, 'unknown-outcome', 'stored as restored');
    const applied = journalStep(fresh(), { type: 'answered', at: T0, undoable: true });
    await store.put(journalStep(applied, { type: 'undo-sent', at: T0 + 1_000, queued: false }));
    const [again] = await restoreJournal(store, T0 + 2_000, SESSION);
    assert.equal(again.entry.state, 'applied');
  });

  it('an Undo that fails for a passing reason goes back; a final refusal expires it', () => {
    const applied = journalStep(fresh(), { type: 'answered', at: T0, undoable: true });
    const pending = journalStep(applied, { type: 'undo-sent', at: T0 + 1, queued: false });
    assert.equal(journalStep(pending, undoRefusalEvent('unavailable', T0 + 2)).state, 'applied');
    assert.equal(journalStep(pending, undoRefusalEvent('undo_expired', T0 + 2)).state, 'expired');
  });
});
