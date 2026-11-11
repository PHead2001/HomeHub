import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { CHANGED_ELSEWHERE_TITLE } from '../../src/lib/shopping/undo';
import { notUndoneNotice, planTick, reportFailure, tickShoppingItem, undoShoppingTick, type ItemPath, type TickIO } from '../../src/lib/shopping/tick';

const path: ItemPath = { householdId: 'h1', listId: 'weekly', itemId: 'milk' };

type Call = { path: ItemPath; data: Record<string, unknown> };

/** A fake Firestore side: records writes; each write settles as the test says. */
function fakeIO(options: {
  offline?: boolean;
  persistence?: 'durable' | 'memory' | 'unknown';
  cached?: boolean;
  /** How each write settles: resolved, rejected with an error, or left pending. */
  settle?: 'ok' | { error: unknown } | 'pending';
} = {}) {
  const calls: Call[] = [];
  const io: TickIO = {
    update: (p, data) => {
      calls.push({ path: p, data });
      const settle = options.settle ?? 'ok';
      if (settle === 'ok') return Promise.resolve();
      if (settle === 'pending') return new Promise<void>(() => {});
      return Promise.reject(settle.error);
    },
    persistence: () => options.persistence ?? 'memory',
    offline: () => options.offline ?? false,
    cachedStatusIs: async () => options.cached ?? false,
    opId: () => 'op-1',
  };
  return { io, calls };
}

const deniedError = Object.assign(new Error('denied'), { code: 'permission-denied' });

describe('shared Shopping tick (HP-33c)', () => {
  test('ticks a needed item with the buyer, the server time and a fresh purchaseOpId', async () => {
    const { io, calls } = fakeIO();
    const started = tickShoppingItem(io, { path, uid: 'u1', current: { status: 'needed' } });
    assert.equal(started.status, 'ticked');
    if (started.status !== 'ticked') return;
    assert.equal(started.opId, 'op-1');
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].path, path);
    assert.equal(calls[0].data.status, 'purchased');
    assert.equal(calls[0].data.purchasedByUid, 'u1');
    assert.equal(calls[0].data.purchaseOpId, 'op-1');
    assert.ok(calls[0].data.purchasedAt, 'server timestamp sentinel');
    assert.ok('undoOpId' in calls[0].data, 'undoOpId is removed by the tick');
    assert.equal((await started.track()).state, 'saved');
  });

  test("every tick (the list's, the overview's, the dashboard tile's) is recorded as this device's own (SH-28c)", () => {
    const recorded: Array<[ItemPath, string]> = [];
    const { io } = fakeIO();
    const withRecord: TickIO = { ...io, recordLocal: (p, opId) => void recorded.push([p, opId]) };
    tickShoppingItem(withRecord, { path, uid: 'u1', current: { status: 'needed' } });
    assert.deepEqual(recorded, [[path, 'op-1']]);
    // Nothing is recorded when no tick is written.
    tickShoppingItem(withRecord, { path, uid: 'u1', current: { status: 'purchased' } });
    tickShoppingItem(withRecord, { path, uid: 'u1', current: null });
    assert.equal(recorded.length, 1);
  });

  test('never re-ticks an item the live list shows as purchased, and never writes for a gone item', () => {
    const { io, calls } = fakeIO();
    assert.deepEqual(tickShoppingItem(io, { path, uid: 'u1', current: { status: 'purchased' } }), { status: 'already-purchased' });
    assert.deepEqual(tickShoppingItem(io, { path, uid: 'u1', current: null }), { status: 'gone' });
    assert.equal(calls.length, 0);
    assert.equal(planTick({ status: 'needed' }), 'tick');
    assert.equal(planTick({}), 'tick');
  });

  test('offline: the write is queued, classified at once, and "stored locally" only on a durable cache that shows it', async () => {
    const queued = fakeIO({ offline: true, settle: 'pending', persistence: 'durable', cached: true });
    const started = tickShoppingItem(queued.io, { path, uid: 'u1', current: { status: 'needed' } });
    assert.equal(started.status, 'ticked');
    if (started.status !== 'ticked') return;
    assert.equal(started.offline, true);
    assert.equal(await started.storedLocally(), true);
    assert.equal((await started.track()).state, 'stored-locally');

    const memory = fakeIO({ offline: true, settle: 'pending', persistence: 'memory', cached: true });
    const onMemory = tickShoppingItem(memory.io, { path, uid: 'u1', current: { status: 'needed' } });
    if (onMemory.status !== 'ticked') return assert.fail('ticked');
    assert.equal(await onMemory.storedLocally(), false);
    assert.equal((await onMemory.track()).state, 'sending');
  });

  test('a refused tick is reported as failed, and track runs once', async () => {
    const { io } = fakeIO({ settle: { error: deniedError } });
    const started = tickShoppingItem(io, { path, uid: 'u1', current: { status: 'needed' } });
    if (started.status !== 'ticked') return assert.fail('ticked');
    const first = started.track();
    assert.equal(started.track(), first);
    const errors: unknown[] = [];
    assert.equal(await reportFailure(first, (error) => errors.push(error)), 'failed');
    assert.deepEqual(errors, [deniedError]);
  });

  test('reportFailure reports a late rejection of a write that was still pending', async () => {
    let reject: (error: unknown) => void = () => {};
    const write = new Promise<void>((_, r) => { reject = r; });
    const errors: unknown[] = [];
    const settled = write.then(() => ({ state: 'saved' as const, value: undefined }), (error: unknown) => ({ state: 'failed' as const, error }));
    const state = await reportFailure(Promise.resolve({ state: 'sending' as const, settled }), (error) => errors.push(error));
    assert.equal(state, 'sending');
    reject(deniedError);
    await settled;
    await Promise.resolve();
    assert.deepEqual(errors, [deniedError]);
  });
});

describe('shared Shopping tick Undo', () => {
  test('writes only the status and purchase stamps with the tick op id when the item is unknown (the rules decide)', () => {
    const { io, calls } = fakeIO();
    const started = undoShoppingTick(io, { path, opId: 'op-1', known: undefined });
    assert.equal(started.status, 'written');
    assert.deepEqual(calls[0].data, { status: 'needed', undoOpId: 'op-1', purchasedByUid: null, purchasedAt: null });
  });

  test('refuses without writing when the live list shows a newer purchase or no item; nothing to do when already undone', () => {
    const { io, calls } = fakeIO();
    assert.equal(undoShoppingTick(io, { path, opId: 'op-1', known: { status: 'purchased', purchaseOpId: 'op-2' } }).status, 'refused');
    assert.equal(undoShoppingTick(io, { path, opId: 'op-1', known: null }).status, 'refused');
    assert.equal(undoShoppingTick(io, { path, opId: 'op-1', known: { status: 'needed', purchaseOpId: 'op-1' } }).status, 'already');
    assert.equal(calls.length, 0);
    assert.equal(undoShoppingTick(io, { path, opId: 'op-1', known: { status: 'purchased', purchaseOpId: 'op-1' } }).status, 'written');
  });

  test('a rules refusal reads "Changed by someone else — not undone"; other errors are left to the caller', () => {
    assert.equal(notUndoneNotice('Milk')?.title, CHANGED_ELSEWHERE_TITLE);
    assert.equal(notUndoneNotice('Milk', deniedError)?.title, CHANGED_ELSEWHERE_TITLE);
    assert.match(notUndoneNotice('Milk', { code: 'not-found' })!.description, /Milk was changed on another device/);
    assert.equal(notUndoneNotice('Milk', new Error('network')), null);
  });
});
