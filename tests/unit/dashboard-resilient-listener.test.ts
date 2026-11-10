import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import {
  BACKOFF_CAP_MS,
  backoffDelay,
  resilientListener,
  type ListenerStatus,
} from '../../src/lib/dashboard/resilient-listener';

/** A fake source: each subscribe call is recorded so the test can answer or fail it. */
function fakeSource() {
  const calls: Array<{ next: (value: number) => void; error: (error: unknown) => void; unsubscribed: boolean }> = [];
  const subscribe = (next: (value: number) => void, error: (error: unknown) => void) => {
    const call = { next, error, unsubscribed: false };
    calls.push(call);
    return () => {
      call.unsubscribed = true;
    };
  };
  return { calls, subscribe, last: () => calls[calls.length - 1] };
}

function environment() {
  const window = new EventTarget();
  const document = Object.assign(new EventTarget(), { visibilityState: 'visible' });
  return { window, document, random: () => 0.5 };
}

const unavailable = new Error('unavailable');
const denied = Object.assign(new Error('denied'), { code: 'permission-denied' });

describe('backoffDelay', () => {
  it('doubles from 1 s and caps at 60 s', () => {
    const mid = () => 0.5; // no jitter
    assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 8, 20].map((attempt) => backoffDelay(attempt, mid)), [1000, 2000, 4000, 8000, 16_000, 32_000, 60_000, 60_000, 60_000]);
  });

  it('jitters by ±20% without exceeding the cap', () => {
    assert.equal(backoffDelay(1, () => 0), 800);
    assert.equal(backoffDelay(1, () => 1), 1200);
    assert.equal(backoffDelay(10, () => 1), BACKOFF_CAP_MS);
    assert.equal(backoffDelay(10, () => 0), 48_000);
  });
});

describe('resilientListener', () => {
  beforeEach(() => mock.timers.enable({ apis: ['setTimeout'] }));
  afterEach(() => mock.timers.reset());

  it('resubscribes on the backoff schedule after each error, and resets after an answer', () => {
    const source = fakeSource();
    const statuses: ListenerStatus[] = [];
    const values: number[] = [];
    resilientListener(source.subscribe, { next: (value) => values.push(value), status: (status) => statuses.push(status) }, environment());
    assert.equal(source.calls.length, 1);

    source.last().error(unavailable);
    assert.equal(source.calls[0].unsubscribed, true);
    assert.deepEqual(statuses.map((status) => status.kind === 'retrying' && status.delayMs), [1000]);
    mock.timers.tick(999);
    assert.equal(source.calls.length, 1, 'not before the delay');
    mock.timers.tick(1);
    assert.equal(source.calls.length, 2);

    source.last().error(unavailable);
    mock.timers.tick(1999);
    assert.equal(source.calls.length, 2);
    mock.timers.tick(1);
    assert.equal(source.calls.length, 3);

    source.last().error(unavailable);
    mock.timers.tick(4000);
    assert.equal(source.calls.length, 4);

    source.last().next(7);
    assert.deepEqual(values, [7]);
    assert.equal(statuses.at(-1)?.kind, 'live');

    // A success resets the schedule: the next failure waits 1 s again.
    source.last().error(unavailable);
    assert.equal((statuses.at(-1) as { delayMs: number }).delayMs, 1000);
  });

  it('keeps retrying at the 60 s cap', () => {
    const source = fakeSource();
    resilientListener(source.subscribe, { next: () => undefined }, environment());
    const delays: number[] = [];
    for (let attempt = 0; attempt < 9; attempt += 1) {
      const before = source.calls.length;
      source.last().error(unavailable);
      let waited = 0;
      while (source.calls.length === before) {
        mock.timers.tick(1000);
        waited += 1000;
      }
      delays.push(waited);
    }
    assert.deepEqual(delays, [1000, 2000, 4000, 8000, 16_000, 32_000, 60_000, 60_000, 60_000]);
  });

  it('retries at once when the browser comes online or the page becomes visible', () => {
    const source = fakeSource();
    const env = environment();
    resilientListener(source.subscribe, { next: () => undefined }, env);
    source.last().error(unavailable);
    env.window.dispatchEvent(new Event('online'));
    assert.equal(source.calls.length, 2, 'online retries now');
    mock.timers.tick(60_000);
    assert.equal(source.calls.length, 2, 'the pending timer was cancelled');

    source.last().error(unavailable);
    env.document.visibilityState = 'hidden';
    env.document.dispatchEvent(new Event('visibilitychange'));
    assert.equal(source.calls.length, 2, 'hidden does not retry');
    env.document.visibilityState = 'visible';
    env.document.dispatchEvent(new Event('visibilitychange'));
    assert.equal(source.calls.length, 3);

    // While live, online and visibility do nothing.
    source.last().next(1);
    env.window.dispatchEvent(new Event('online'));
    assert.equal(source.calls.length, 3);
  });

  it('retryNow resubscribes only while a retry is pending', () => {
    const source = fakeSource();
    const handle = resilientListener(source.subscribe, { next: () => undefined }, environment());
    handle.retryNow();
    assert.equal(source.calls.length, 1);
    source.last().error(unavailable);
    handle.retryNow();
    assert.equal(source.calls.length, 2);
  });

  it('treats permission-denied as unauthorized after two retries and then stays quiet', () => {
    const source = fakeSource();
    const env = environment();
    const statuses: string[] = [];
    resilientListener(source.subscribe, { next: () => undefined, status: (status) => statuses.push(status.kind) }, env);
    source.last().error(denied);
    mock.timers.tick(1000);
    source.last().error(denied);
    mock.timers.tick(2000);
    assert.equal(source.calls.length, 3);
    source.last().error(denied);
    assert.deepEqual(statuses, ['retrying', 'retrying', 'unauthorized']);
    mock.timers.tick(10 * 60_000);
    env.window.dispatchEvent(new Event('online'));
    assert.equal(source.calls.length, 3, 'no further attempts until the listener is recreated');
  });

  it('reaches unauthorized when each attempt answers from cache before the denial', () => {
    // Firestore with a persistent cache: every subscription first delivers a cached
    // snapshot, then the server refuses. Cached answers must not reset the count.
    const source = fakeSource();
    const statuses: string[] = [];
    const values: number[] = [];
    resilientListener(source.subscribe, {
      next: (value) => values.push(value),
      status: (status) => statuses.push(status.kind === 'retrying' ? `retrying:${status.delayMs}` : status.kind),
      confirmed: (value) => value >= 100, // values >= 100 stand for server-confirmed snapshots
    }, environment());
    source.last().next(1); // cached
    source.last().error(denied);
    mock.timers.tick(1000);
    source.last().next(1); // cached again
    source.last().error(denied);
    mock.timers.tick(2000);
    source.last().next(1);
    source.last().error(denied);
    assert.deepEqual(statuses.filter((status) => status !== 'live'), ['retrying:1000', 'retrying:2000', 'unauthorized']);
    mock.timers.tick(10 * 60_000);
    assert.equal(source.calls.length, 3, 'no retry loop at the minimum delay');
  });

  it('a server-confirmed answer still resets the schedule', () => {
    const source = fakeSource();
    const statuses: ListenerStatus[] = [];
    resilientListener(source.subscribe, { next: () => undefined, status: (status) => statuses.push(status), confirmed: (value) => value >= 100 }, environment());
    source.last().error(unavailable);
    mock.timers.tick(1000);
    source.last().error(unavailable);
    mock.timers.tick(2000);
    source.last().next(100);
    source.last().error(unavailable);
    assert.equal((statuses.at(-1) as { delayMs: number }).delayMs, 1000);
  });

  it('stops on unmount: unsubscribes, cancels the timer and ignores late events', () => {
    const source = fakeSource();
    const env = environment();
    const values: number[] = [];
    const handle = resilientListener(source.subscribe, { next: (value) => values.push(value) }, env);
    const first = source.last();
    first.error(unavailable);
    handle.stop();
    mock.timers.tick(60_000);
    env.window.dispatchEvent(new Event('online'));
    assert.equal(source.calls.length, 1);
    first.next(3);
    assert.deepEqual(values, []);

    const live = fakeSource();
    const stopLive = resilientListener(live.subscribe, { next: () => undefined }, env);
    stopLive.stop();
    assert.equal(live.last().unsubscribed, true);
  });
});
