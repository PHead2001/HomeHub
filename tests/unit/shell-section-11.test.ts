import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

import { AUTO_RETRY_DELAYS_MS, autoRetryDelay, retryUntil } from '../../src/lib/shell/auto-retry';
import { membershipPhase, membershipReducer, initialMembershipState } from '../../src/lib/auth/live-membership';

const source = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');

describe('SL-1: section error boundaries', () => {
  it('Maintenance has its own route boundary with the shared crash recovery', () => {
    const boundary = source('src/app/maintenance/error.tsx');
    assert.match(boundary, /^'use client';/);
    assert.match(boundary, /useCrashRecovery\(error\)/);
    assert.match(boundary, /retry\(\)/);
    assert.match(boundary, /Maintenance ran into a problem/);
    assert.match(boundary, /role="alert"/);
    // Never claims an unsaved form was kept.
    assert.match(boundary, /may need to be entered again/);
  });
});

describe('SL-12: loads retry on their own', () => {
  it('backs off 2 s, 5 s, 15 s, 30 s, then every 60 s', () => {
    assert.deepEqual([1, 2, 3, 4, 5, 6, 20].map((n) => autoRetryDelay(n)), [2000, 5000, 15000, 30000, 60000, 60000, 60000]);
    assert.equal(autoRetryDelay(0), AUTO_RETRY_DELAYS_MS[0]);
  });

  const manualTimers = () => {
    const pending = new Map<number, { fn: () => void; ms: number }>();
    let next = 1;
    return {
      pending,
      setTimer: (fn: () => void, ms: number) => { const id = next++; pending.set(id, { fn, ms }); return id; },
      clearTimer: (id: unknown) => { pending.delete(id as number); },
      fireAll: () => { for (const [id, entry] of [...pending]) { pending.delete(id); entry.fn(); } },
    };
  };
  const flush = () => new Promise((resolve) => setImmediate(resolve));

  it('retries a failing read until it answers', async () => {
    const timers = manualTimers();
    let calls = 0;
    const errors: number[] = [];
    const result = retryUntil(async () => {
      calls += 1;
      if (calls < 3) throw new Error('offline');
      return 'profile';
    }, { keepGoing: () => true, onError: (_e, attempt) => errors.push(attempt), onlineTarget: null, ...timers });
    await flush();
    assert.deepEqual([...timers.pending.values()].map((t) => t.ms), [2000]);
    timers.fireAll();
    await flush();
    assert.deepEqual([...timers.pending.values()].map((t) => t.ms), [5000]);
    timers.fireAll();
    assert.deepEqual(await result, { aborted: false, value: 'profile' });
    assert.deepEqual(errors, [1, 2]);
  });

  it('retries at once when the browser comes back online', async () => {
    const timers = manualTimers();
    const target = new EventTarget();
    let calls = 0;
    const result = retryUntil(async () => {
      calls += 1;
      if (calls === 1) throw new Error('offline');
      return 1;
    }, { keepGoing: () => true, onlineTarget: target, ...timers });
    await flush();
    target.dispatchEvent(new Event('online'));
    assert.deepEqual(await result, { aborted: false, value: 1 });
    assert.equal(timers.pending.size, 0, 'the backoff timer is cleared');
  });

  it('stops when another account (or nobody) is signed in, and drops a late answer', async () => {
    const timers = manualTimers();
    let signedIn = true;
    const failing = retryUntil(async () => { throw new Error('offline'); }, { keepGoing: () => signedIn, onlineTarget: null, ...timers });
    await flush();
    signedIn = false;
    timers.fireAll();
    assert.deepEqual(await failing, { aborted: true });

    let current = true;
    const late = retryUntil(async () => { current = false; return 'stale'; }, { keepGoing: () => current, onlineTarget: null, ...timers });
    assert.deepEqual(await late, { aborted: true });
  });

  it('the profile read in AuthProvider uses it', () => {
    const auth = source('src/contexts/auth-context.tsx');
    assert.match(auth, /retryUntil\(\(\) => fetchOrCreateUserProfile\(firebaseUser\)/);
    assert.match(auth, /if \(fetched\.aborted\) return;/);
  });

  it('a household that failed to load opens by itself once the record answers (listeners keep retrying)', () => {
    let state = membershipReducer(initialMembershipState, { type: 'watch', uid: 'u1', householdId: 'h1' });
    state = membershipReducer(state, { type: 'memberError', householdId: 'h1', failure: 'transient' });
    assert.equal(membershipPhase(state), 'failed');
    state = membershipReducer(state, { type: 'member', householdId: 'h1', uid: 'u1', exists: true, data: { role: 'member', status: 'approved' }, fromCache: false, offline: false });
    assert.notEqual(membershipPhase(state), 'failed');
  });
});
