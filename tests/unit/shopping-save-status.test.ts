import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  classifySettled,
  classifyUnsettled,
  createSubmissionGuard,
  isPendingState,
  isSettledForInput,
  offlineTickNote,
  once,
  settledTickFollowUp,
  tickFollowUp,
  saveStateLabel,
  summarizeStates,
  trackWrite,
  type LocalPersistence,
  type TrackWriteDeps,
} from '../../src/lib/shopping/save-status';

/** A manual timer: `fire()` runs every scheduled callback, as if the timeout passed. */
function manualTimer() {
  const callbacks: Array<() => void> = [];
  return {
    setTimer: (callback: () => void) => {
      callbacks.push(callback);
      return callbacks.length;
    },
    clearTimer: () => undefined,
    fire: () => callbacks.splice(0).forEach((callback) => callback()),
    get scheduled() {
      return callbacks.length;
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

type DepsOverrides = Partial<Omit<TrackWriteDeps, 'persistence' | 'offline'>> & { persistence?: LocalPersistence; offline?: boolean };
const deps = (overrides: DepsOverrides = {}) => {
  const timer = manualTimer();
  const { persistence = 'durable', offline = false, ...rest } = overrides;
  return {
    timer,
    deps: {
      kind: 'write',
      persistence: () => persistence,
      offline: () => offline,
      setTimer: timer.setTimer,
      clearTimer: timer.clearTimer,
      ...rest,
    } as TrackWriteDeps,
  };
};

describe('save-status classification (SH-4)', () => {
  test('a queued write is stored-locally only with a durable cache that shows it', () => {
    assert.equal(classifyUnsettled({ kind: 'write', persistence: 'durable', cacheReflectsWrite: true }), 'stored-locally');
    assert.equal(classifyUnsettled({ kind: 'write', persistence: 'durable', cacheReflectsWrite: false }), 'sending');
    assert.equal(classifyUnsettled({ kind: 'write', persistence: 'durable', cacheReflectsWrite: null }), 'sending');
    assert.equal(classifyUnsettled({ kind: 'write', persistence: 'memory', cacheReflectsWrite: true }), 'sending');
    assert.equal(classifyUnsettled({ kind: 'write', persistence: 'unknown', cacheReflectsWrite: true }), 'sending');
  });

  test('an unanswered transaction is uncertain, never saved', () => {
    for (const persistence of ['durable', 'memory', 'unknown'] as const) {
      assert.equal(classifyUnsettled({ kind: 'transaction', persistence, cacheReflectsWrite: true }), 'uncertain');
    }
  });

  test('settled writes, labels and helpers', () => {
    assert.equal(classifySettled({ ok: true }), 'saved');
    assert.equal(classifySettled({ ok: false }), 'failed');
    assert.equal(saveStateLabel('stored-locally'), 'Saved, will sync');
    assert.equal(saveStateLabel('sending'), 'Still sending…');
    assert.equal(isSettledForInput('saved'), true);
    assert.equal(isSettledForInput('stored-locally'), true);
    assert.equal(isSettledForInput('sending'), false);
    assert.equal(isPendingState('uncertain'), true);
    assert.equal(isPendingState('failed'), false);
    assert.equal(summarizeStates(['saved', 'sending', 'stored-locally']), 'sending');
    assert.equal(summarizeStates(['saved', 'uncertain', 'failed']), 'failed');
    assert.equal(summarizeStates([]), null);
    assert.match(offlineTickNote(true), /saved on this device/);
    assert.doesNotMatch(offlineTickNote(false), /saved on this device/);
  });
});

describe('trackWrite with injected persistence and timings', () => {
  test('a write answered before the timeout is saved', async () => {
    const { deps: d, timer } = deps();
    const tracked = await trackWrite(Promise.resolve('ok'), d);
    assert.equal(tracked.state, 'saved');
    assert.equal(tracked.value, 'ok');
    assert.deepEqual(await tracked.settled, { state: 'saved', value: 'ok' });
    assert.equal(timer.scheduled <= 1, true);
  });

  test('a rejected write is failed', async () => {
    const { deps: d } = deps();
    const error = new Error('permission-denied');
    const tracked = await trackWrite(Promise.reject(error), d);
    assert.equal(tracked.state, 'failed');
    assert.equal(tracked.error, error);
  });

  test('a timeout alone is not proof: without a cache check the write is still sending', async () => {
    const write = deferred<void>();
    const { deps: d, timer } = deps({ persistence: 'durable' });
    const pending = trackWrite(write.promise, d);
    await flush();
    timer.fire();
    const tracked = await pending;
    assert.equal(tracked.state, 'sending');
    write.resolve();
    assert.equal((await tracked.settled).state, 'saved');
  });

  test('after the timeout, a durable cache that shows the write means stored-locally', async () => {
    const write = deferred<void>();
    let checks = 0;
    const { deps: d, timer } = deps({ persistence: 'durable', cacheReflectsWrite: async () => { checks += 1; return true; } });
    const pending = trackWrite(write.promise, d);
    await flush();
    assert.equal(checks, 0, 'the cache is only checked once the wait is over');
    timer.fire();
    assert.equal((await pending).state, 'stored-locally');
    assert.equal(checks, 1);
  });

  test('a memory cache is never stored-locally, even when the cache shows the write', async () => {
    const write = deferred<void>();
    const { deps: d, timer } = deps({ persistence: 'memory', cacheReflectsWrite: async () => true });
    const pending = trackWrite(write.promise, d);
    await flush();
    timer.fire();
    assert.equal((await pending).state, 'sending');
  });

  test('unknown persistence or a failing cache read stays sending', async () => {
    for (const setup of [
      { persistence: 'unknown' as const, cacheReflectsWrite: async () => true },
      { persistence: 'durable' as const, cacheReflectsWrite: async () => { throw new Error('not cached'); } },
      { persistence: 'durable' as const, cacheReflectsWrite: async () => false },
    ]) {
      const write = deferred<void>();
      const { deps: d, timer } = deps(setup);
      const pending = trackWrite(write.promise, d);
      await flush();
      timer.fire();
      assert.equal((await pending).state, 'sending');
    }
  });

  test('offline, a queued write is classified at once without waiting for the timer', async () => {
    const write = deferred<void>();
    const { deps: d, timer } = deps({ offline: true, persistence: 'durable', cacheReflectsWrite: async () => true });
    const tracked = await trackWrite(write.promise, d);
    assert.equal(tracked.state, 'stored-locally');
    assert.equal(timer.scheduled, 0);
  });

  test('a transaction past the timeout is uncertain and resolves when it settles', async () => {
    const write = deferred<boolean>();
    const { deps: d, timer } = deps({ kind: 'transaction', cacheReflectsWrite: async () => true });
    const pending = trackWrite(write.promise, d);
    await flush();
    timer.fire();
    const tracked = await pending;
    assert.equal(tracked.state, 'uncertain');
    write.resolve(true);
    assert.deepEqual(await tracked.settled, { state: 'saved', value: true });
  });

  test('a write that is still sending can fail later', async () => {
    const write = deferred<void>();
    const { deps: d, timer } = deps({ persistence: 'memory' });
    const pending = trackWrite(write.promise, d);
    await flush();
    timer.fire();
    const tracked = await pending;
    assert.equal(tracked.state, 'sending');
    write.reject(new Error('denied'));
    assert.equal((await tracked.settled).state, 'failed');
  });
});

describe('submission guard (SH-4c)', () => {
  test('a second submit while one is sending is ignored, and an id is accepted once', () => {
    const guard = createSubmissionGuard();
    assert.equal(guard.begin('a'), true);
    assert.equal(guard.busy, true);
    assert.equal(guard.begin('b'), false, 'second Enter while sending');
    guard.end('a');
    assert.equal(guard.busy, false);
    assert.equal(guard.begin('a'), false, 'the same submission is never sent twice');
    assert.equal(guard.begin('b'), true);
  });
});

describe('tick follow-up on a weak connection', () => {
  test('a tick acknowledged in time checks trip completion now; a late one checks after it settles', () => {
    assert.equal(tickFollowUp('saved'), 'check-now');
    assert.equal(tickFollowUp('failed'), 'fail');
    for (const state of ['sending', 'stored-locally', 'uncertain'] as const) assert.equal(tickFollowUp(state), 'check-after-settle');
    assert.equal(settledTickFollowUp('saved'), 'check', 'a late success still opens the receipt');
    assert.equal(settledTickFollowUp('failed'), 'fail');
  });

  test('the completion check runs once, however often it is asked for', async () => {
    let runs = 0;
    const check = once(async () => { runs += 1; return runs; });
    const [a, b] = await Promise.all([check(), check()]);
    assert.equal(await check(), 1);
    assert.deepEqual([a, b, runs], [1, 1, 1]);
  });

  test('a tick that exceeds the timeout and then succeeds leads to exactly one completion check', async () => {
    const write = deferred<void>();
    const { deps: d, timer } = deps({ persistence: 'memory' });
    let checks = 0;
    const check = once(async () => { checks += 1; });
    const pending = trackWrite(write.promise, d);
    await flush();
    timer.fire();
    const tracked = await pending;
    assert.equal(tickFollowUp(tracked.state), 'check-after-settle');
    const late = tracked.settled.then((final) => (settledTickFollowUp(final.state) === 'check' ? check() : undefined));
    assert.equal(checks, 0, 'nothing is decided before the answer');
    write.resolve();
    await late;
    await check();
    assert.equal(checks, 1);
  });
});
