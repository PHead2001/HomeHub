import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { choreAnswerMeaning, queuedSendResult, SENDABLE_CAPABILITIES } from '../../src/lib/devices/device-action-answers';
import { createRevertRegistry, runUndo, type UndoFlowDeps } from '../../src/lib/devices/undo-flow';
import { createQueuedAction, dropNotice, withSendFields, type QueuedDeviceAction } from '../../src/lib/devices/offline-queue';
import { journalEntry, type UndoJournalEntry } from '../../src/lib/devices/undo-journal';
import { queuedUndoInTime, QUEUED_UNDO_DEVICE_GAP_MS } from '../../src/lib/devices/queued-undo';
import type { DeviceCapability } from '../../src/lib/devices/action-policy';

// PR #181 review (docs/modules/devices/README.md, "Device actions: chores"): the queue never
// treats a domain refusal as applied (E), an Undo works when local storage fails (C) and
// asks for the original actor's PIN when its level needs one, also after a reload (A); the
// dashboard is told when an action is taken back (D); no email reaches the wall screen; a
// queued Undo's longer window needs the device-clock check (JC-17).

const SESSION = { householdId: 'H', deviceId: 'D'.repeat(20), generation: 2 };
const T0 = Date.parse('2026-11-14T15:00:00Z');

describe('queued answers: every capability\'s outcome shapes (E)', () => {
  const ok = (data: unknown) => ({ ok: true as const, data });
  const CASES: Array<[DeviceCapability, unknown, 'applied' | 'dropped', string?]> = [
    ['chores.complete', { outcome: { status: 'completed' } }, 'applied'],
    ['chores.complete', { outcome: { status: 'already', completion: { completedByName: 'Sam' } } }, 'dropped', 'it was already done by Sam.'],
    ['chores.complete', { outcome: { status: 'already', completion: { completedByName: 'sam@example.test' } } }, 'dropped', 'it was already done.'],
    ['chores.complete', { outcome: { status: 'refused', refused: 'early', dueDay: '2026-11-20' } }, 'dropped', "that chore isn't due yet."],
    ['chores.complete', { outcome: { status: 'refused', refused: 'missing' } }, 'dropped', 'that chore is gone.'],
    ['chores.take', { status: 'taken' }, 'applied'],
    ['chores.take', { status: 'already_yours' }, 'applied'],
    ['chores.take', { status: 'surprise' }, 'dropped'],
    ['chores.complete.undo', { status: 'undone' }, 'applied'],
    ['chores.complete.undo', { status: 'already' }, 'applied'],
    ['chores.complete.undo', { status: 'not_applied' }, 'applied'],
    ['chores.complete.undo', { status: 'stale' }, 'dropped'],
    ['chores.take.undo', { status: 'untaken' }, 'applied'],
    ['chores.take.undo', { status: 'already' }, 'applied'],
    ['chores.take.undo', { status: 'not_applied' }, 'applied'],
  ];

  for (const [capability, data, expected, reason] of CASES) {
    it(`${capability} ${JSON.stringify(data)} → ${expected}`, () => {
      const result = queuedSendResult(capability, ok(data));
      assert.equal(result.ok, expected === 'applied');
      if (!result.ok && reason) assert.equal(result.reason, reason);
    });
  }

  it('every capability the tablet sends has a mapping; refusals and unknown capabilities are never "applied"', () => {
    for (const capability of SENDABLE_CAPABILITIES) assert.notEqual(queuedSendResult(capability, ok({})).ok, undefined);
    assert.deepEqual(queuedSendResult('chores.complete', { ok: false, code: 'forbidden' }), { ok: false, code: 'forbidden' });
    assert.equal(queuedSendResult('pets.feed', ok({ anything: true })).ok, false);
  });

  it('the dropped-change notice says why', () => {
    const entry = createQueuedAction({ opId: randomUUID(), kind: 'action', ...SESSION, capability: 'chores.complete', actorUid: 'mia', actorName: 'Mia', intent: { choreId: 'c1' } }, new Date(T0));
    const result = queuedSendResult('chores.complete', ok({ outcome: { status: 'refused', refused: 'early' } }));
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(dropNotice([{ entry, code: result.code, reason: result.reason }]), "1 change from this tablet couldn't be saved: that chore isn't due yet.");
  });

  it('no email on the wall screen: "Already done by" uses the public name', () => {
    assert.equal(choreAnswerMeaning('chores.complete', { outcome: { status: 'already', completion: { completedByName: 'sam@example.test' } } }, 'Dishes').message, 'Already done.');
    assert.equal(choreAnswerMeaning('chores.complete', { outcome: { status: 'already', completion: { completedByName: 'Sam' } } }, 'Dishes').message, 'Already done by Sam.');
  });
});

const entryOf = (over: Partial<UndoJournalEntry> = {}): UndoJournalEntry => ({
  ...journalEntry({ opId: randomUUID(), ...SESSION, capability: 'chores.complete', actorUid: 'mia', label: 'Dishes', sentAt: T0, viaQueue: false }),
  respondedAt: T0, state: 'confirmed', ...over,
});

const deps = (over: Partial<UndoFlowDeps> = {}) => {
  const calls: string[] = [];
  const base: UndoFlowDeps = {
    queueGet: async () => undefined,
    removeIfNeverSent: async () => false,
    markJournal: async (_opId, patch) => { calls.push(`journal:${patch.state}`); },
    enqueueUndo: async () => { calls.push('enqueue'); },
    queueRefusal: null,
    authorize: async (forcePin) => { calls.push(`authorize:${forcePin}`); return { actorUid: 'mia' }; },
    send: async (actor) => { calls.push(`send:${actor.pinSessionId ?? 'face'}`); return { ok: true, data: { status: 'undone' } }; },
    online: true,
    now: T0 + 2_000,
  };
  return { calls, deps: { ...base, ...over } };
};

describe('Undo with local storage unavailable (C)', () => {
  it('a queue that cannot be read: the Undo still goes to the server by opId', async () => {
    const { calls, deps: d } = deps({ queueGet: async () => { throw new Error('IndexedDB unavailable'); } });
    assert.deepEqual(await runUndo(entryOf(), d), { kind: 'undone' });
    assert.ok(calls.includes('send:face'));
  });

  it('a journal that cannot be written changes nothing for the server', async () => {
    const { calls, deps: d } = deps({ markJournal: async () => { throw new Error('quota'); } });
    assert.deepEqual(await runUndo(entryOf(), d), { kind: 'undone' });
    assert.ok(calls.includes('send:face'));
  });

  it('offline with a queue that cannot be written: refused as unavailable, never silently lost', async () => {
    const { deps: d } = deps({ online: false, enqueueUndo: async () => { throw new Error('IndexedDB unavailable'); } });
    assert.deepEqual(await runUndo(entryOf(), d), { kind: 'refused', code: 'unavailable' });
  });
});

describe('Undo needing the original actor\'s PIN, also after a reload (A)', () => {
  it('authorizes before sending; a PIN refusal asks once more and retries', async () => {
    let attempt = 0;
    const { calls, deps: d } = deps({
      authorize: async (forcePin) => { calls.push(`authorize:${forcePin}`); return { actorUid: 'mia', pinSessionId: forcePin ? 'fresh' : 'stale' }; },
      send: async (actor) => {
        calls.push(`send:${actor.pinSessionId}`);
        attempt += 1;
        return attempt === 1 ? { ok: false, code: 'pin_session_invalid' } : { ok: true, data: { status: 'undone' } };
      },
    });
    assert.deepEqual(await runUndo(entryOf(), d), { kind: 'undone' });
    assert.deepEqual(calls.filter((c) => !c.startsWith('journal')), ['authorize:false', 'send:stale', 'authorize:true', 'send:fresh']);
  });

  it('PIN pad cancelled: nothing is sent and the entry can still be undone', async () => {
    const { calls, deps: d } = deps({ authorize: async () => null });
    assert.deepEqual(await runUndo(entryOf(), d), { kind: 'cancelled' });
    assert.equal(calls.some((c) => c.startsWith('send')), false);
  });

  it('guard: the shell routes Undo authorization through the PIN pad for the original actor', () => {
    const shell = readFileSync('src/components/devices/tablet-shell.tsx', 'utf8');
    assert.match(shell, /authorizeUndo: async \(\{ actorUid, capability, pinSessionId, forcePin \}\) =>/);
    assert.match(shell, /requiredLevel\(capability, \{ pointsPin: household\.pointsPin, actorRole: who\.role \}\) !== 'pin'/);
  });
});

describe('the dashboard learns when an action is taken back (D)', () => {
  it('a never-sent queued Done undone on the tablet', async () => {
    const queued: QueuedDeviceAction = createQueuedAction({ opId: randomUUID(), kind: 'action', ...SESSION, capability: 'chores.complete', actorUid: 'mia', actorName: 'Mia', intent: { choreId: 'c1' } }, new Date(T0));
    const { calls, deps: d } = deps({ queueGet: async () => queued, removeIfNeverSent: async () => true, online: false });
    assert.deepEqual(await runUndo(entryOf({ opId: queued.opId, viaQueue: true }), d), { kind: 'undone-locally' });
    assert.equal(calls.some((c) => c.startsWith('send') || c === 'enqueue'), false);
    const registry = createRevertRegistry();
    let reverted = 0;
    registry.register(queued.opId, () => { reverted += 1; });
    registry.revert(queued.opId);
    registry.revert(queued.opId);
    assert.equal(reverted, 1, 'once');
  });

  it('a sent entry is never removed locally', async () => {
    const sent = withSendFields(createQueuedAction({ opId: randomUUID(), kind: 'action', ...SESSION, capability: 'chores.complete', actorUid: 'mia', actorName: 'Mia', intent: {} }, new Date(T0)), { attempts: 1, sendState: 'uncertain' });
    const { calls, deps: d } = deps({ queueGet: async () => sent, removeIfNeverSent: async () => { calls.push('remove'); return false; } });
    assert.deepEqual(await runUndo(entryOf({ opId: sent.opId, viaQueue: true }), d), { kind: 'undone' });
    assert.equal(calls.includes('remove'), false);
  });

  it('guard: the dashboard\'s Done clears its local state when the tablet takes it back', () => {
    const oneTap = readFileSync('src/components/dashboard/one-tap.tsx', 'utf8');
    assert.match(oneTap, /onReverted: \(\) => set\(chore\.id, null\)/);
  });
});

describe('the longer window for a queued Undo needs the device-clock check (JC-17)', () => {
  it('within 15 s of the queued action, on the same device clock', () => {
    const action = '2026-11-14T15:00:00.000Z';
    assert.equal(queuedUndoInTime(action, '2026-11-14T15:00:10.000Z'), true);
    assert.equal(queuedUndoInTime(action, new Date(Date.parse(action) + QUEUED_UNDO_DEVICE_GAP_MS).toISOString()), true);
    assert.equal(queuedUndoInTime(action, '2026-11-14T15:00:16.000Z'), false);
    assert.equal(queuedUndoInTime(action, '2026-11-14T14:59:59.000Z'), false, 'never before the action');
    assert.equal(queuedUndoInTime(null, action), false);
    assert.equal(queuedUndoInTime(action, null), false);
    assert.equal(queuedUndoInTime(action, 'garbage'), false);
  });
});

describe('round 2: nothing that needs a PIN or a durable queue is ever queued (A, B)', () => {
  it('queueRefusal: a PIN-level item needs a connection; a non-durable queue promises nothing', async () => {
    const { queueRefusal, QUEUE_REFUSAL_COPY } = await import('../../src/lib/devices/undo-flow');
    const { memoryStore } = await import('../../src/lib/devices/device-store');
    assert.equal(queueRefusal({ queueable: true, durable: true }), null);
    assert.equal(queueRefusal({ queueable: false, durable: true }), 'needs-pin');
    assert.equal(queueRefusal({ queueable: true, durable: false }), 'not-durable');
    assert.equal(memoryStore().durable, false, 'the IndexedDB fallback is not durable');
    assert.match(QUEUE_REFUSAL_COPY['not-durable'], /Couldn't save offline on this tablet/);
  });

  it('a PIN-level original action is never queueable (points PIN Everyone, or Kids only with a child)', async () => {
    const { queueAllowed } = await import('../../src/lib/devices/offline-queue');
    assert.equal(queueAllowed('chores.complete', { pointsPin: 'everyone', actorRole: 'member' }), false);
    assert.equal(queueAllowed('chores.complete', { pointsPin: 'kids', actorRole: 'child' }), false);
    assert.equal(queueAllowed('chores.complete.undo', { pointsPin: 'everyone', actorRole: 'member' }), false);
    assert.equal(queueAllowed('chores.complete', { pointsPin: 'off', actorRole: 'member' }), true);
  });

  it('a PIN-level Undo offline: not queued, the entry stays undoable, "needs a connection"', async () => {
    const { calls, deps: d } = deps({ online: false, queueRefusal: 'needs-pin' });
    assert.deepEqual(await runUndo(entryOf(), d), { kind: 'needs-connection', reason: 'needs-pin' });
    assert.equal(calls.includes('enqueue'), false);
    assert.equal(calls.some((c) => c.startsWith('send')), false);
    assert.ok(calls.includes('journal:confirmed'));
  });

  it('a PIN-level Undo whose send gets no answer is not queued either', async () => {
    const { calls, deps: d } = deps({ queueRefusal: 'needs-pin', send: async () => { throw new Error('network'); } });
    assert.deepEqual(await runUndo(entryOf(), d), { kind: 'needs-connection', reason: 'needs-pin' });
    assert.equal(calls.includes('enqueue'), false);
  });

  it('a non-durable queue: an offline Undo is not "saved", it needs a connection', async () => {
    const { calls, deps: d } = deps({ online: false, queueRefusal: 'not-durable' });
    assert.deepEqual(await runUndo(entryOf(), d), { kind: 'needs-connection', reason: 'not-durable' });
    assert.equal(calls.includes('enqueue'), false);
  });

  it('guards: actions are saved offline only when queueable and durable; a refused save returns not-ok', () => {
    const runtime = readFileSync('src/components/devices/use-device-actions.tsx', 'utf8');
    assert.match(runtime, /const canQueue = !actor\.pinSessionId && queueAllowed\(capability, \{ pointsPin, actorRole: who\.role \}\);/);
    assert.match(runtime, /const refusal = queueRefusal\(\{ queueable: canQueue, durable: queue\.durable \}\);\s*if \(refusal\) \{\s*reverts\.current\.forget\(opId\);\s*toast\(\{ variant: 'destructive', description: QUEUE_REFUSAL_COPY\[refusal\] \}\);\s*return \{ ok: false \};/);
    assert.match(runtime, /if \(canQueue && queue\.durable\) \{/);
    assert.match(runtime, /queueRefusal: queueRefusal\(\{ queueable: queueAllowed\(undoCapability,/);
  });
});
