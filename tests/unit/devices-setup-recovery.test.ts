import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { RETRYABLE_REDEEM_REFUSALS, keepPendingAfter, pendingFor } from '../../src/lib/devices/setup-pending';
import { devicePrincipalOf, retryDeviceClaims, type ClaimRetryTrigger, type Principal } from '../../src/lib/devices/principal';
import type { RedeemRefusal } from '../../src/lib/devices/types';
import { classifyVerifyError, endsTabletSession } from '../../src/lib/devices/verify-errors';

// PR #176 review: the setup screen keeps its redemption nonce for every outcome a retry
// can still recover, and a tablet whose claims were unreadable at start (offline restore)
// keeps retrying them instead of settling with an empty household.

describe('setup screen: pending code and nonce', () => {
  it('the same code keeps its nonce; another code gets a new one', () => {
    let made = 0;
    const make = () => `nonce-${made += 1}`;
    const first = pendingFor(null, 'ABCD-EFGH-JK', make);
    assert.deepEqual(first, { code: 'ABCD-EFGH-JK', nonce: 'nonce-1' });
    assert.equal(pendingFor(first, 'ABCD-EFGH-JK', make), first);
    assert.deepEqual(pendingFor(first, 'ZZZZ-ZZZZ-ZZ', make), { code: 'ZZZZ-ZZZZ-ZZ', nonce: 'nonce-2' });
  });

  it('kept after a committed-but-not-issued redemption (failed), temporary guards and uncertain answers', () => {
    for (const code of ['failed', 'rate_limited', 'app_check_failed', 'unavailable'] as RedeemRefusal[]) {
      assert.equal(keepPendingAfter({ kind: 'refused', code }), true, code);
    }
    assert.equal(keepPendingAfter({ kind: 'uncertain' }), true);
  });

  it('dropped after the sign-in and after a refusal no retry can change', () => {
    assert.equal(keepPendingAfter({ kind: 'signed-in' }), false);
    const terminal: RedeemRefusal[] = ['not_found', 'wrong_kind', 'expired', 'used', 'revoked', 'creator_lost_access',
      'superseded', 'not_repairable', 'household_deleting', 'household_needs_upkeep', 'invalid_input'];
    for (const code of terminal) assert.equal(keepPendingAfter({ kind: 'refused', code }), false, code);
    assert.equal(RETRYABLE_REDEEM_REFUSALS.has('used'), false);
  });

  it('the committed-then-mint-failed sequence reuses the nonce on the retry', () => {
    let stored = pendingFor(null, 'ABCD-EFGH-JK', () => 'n1');
    // First attempt: the server committed, then answered `failed`.
    if (!keepPendingAfter({ kind: 'refused', code: 'failed' })) stored = null as never;
    // Retry with the same code.
    const retry = pendingFor(stored, 'ABCD-EFGH-JK', () => 'n2');
    assert.equal(retry.nonce, 'n1');
  });
});

describe('unresolved tablet claims', () => {
  const D = 'abcdefghij0123456789';
  const resolved: Principal = { kind: 'device', deviceId: D, householdId: 'h1', generation: 2 };

  /** A trigger the test fires by hand, recording subscriptions. */
  const manualTrigger = () => {
    const listeners = new Set<() => void>();
    const trigger: ClaimRetryTrigger = (retry) => {
      listeners.add(retry);
      return () => listeners.delete(retry);
    };
    return { trigger, fire: () => [...listeners].forEach(listener => listener()), count: () => listeners.size };
  };
  const settle = () => new Promise(resolve => setTimeout(resolve, 0));

  it('an unreadable token never yields a settled device with an empty household', async () => {
    const principal = await devicePrincipalOf({
      uid: `device_${D}`, email: null, getIdTokenResult: async () => { throw new Error('network'); },
    });
    assert.deepEqual(principal, { kind: 'device-unresolved', deviceId: D });
  });

  it('retries on reconnect and token change until the claims resolve, then stops every trigger', async () => {
    const online = manualTrigger();
    const token = manualTrigger();
    const answers: Array<Principal | null> = [{ kind: 'device-unresolved', deviceId: D }, resolved];
    const handed: Principal[] = [];
    let reads = 0;
    retryDeviceClaims({
      resolve: async () => { reads += 1; return answers.shift() ?? resolved; },
      onResolved: (principal) => handed.push(principal),
      triggers: [online.trigger, token.trigger],
    });
    assert.equal(reads, 0, 'nothing is read before a trigger');
    online.fire();
    await settle();
    assert.equal(reads, 1);
    assert.deepEqual(handed, [], 'still unresolved: nothing published');
    token.fire();
    await settle();
    assert.deepEqual(handed, [resolved]);
    assert.equal(online.count(), 0);
    assert.equal(token.count(), 0);
    online.fire();
    await settle();
    assert.equal(reads, 2, 'no reads after it resolved');
  });

  it('one read at a time; a trigger during a read runs exactly one more; a failing read is retried later', async () => {
    const online = manualTrigger();
    let release: (value: Principal | null) => void = () => undefined;
    let reads = 0;
    const handed: Principal[] = [];
    retryDeviceClaims({
      resolve: () => {
        reads += 1;
        if (reads === 1) return new Promise(resolve => { release = resolve; });
        if (reads === 2) return Promise.reject(new Error('still offline'));
        return Promise.resolve(resolved);
      },
      onResolved: (principal) => handed.push(principal),
      triggers: [online.trigger],
    });
    online.fire();
    online.fire();
    online.fire();
    assert.equal(reads, 1);
    release(null);
    await settle();
    await settle();
    assert.equal(reads, 2, 'one follow-up read for the triggers during the first');
    assert.deepEqual(handed, []);
    online.fire();
    await settle();
    assert.deepEqual(handed, [resolved]);
  });

  it('stopping ends every trigger and publishes nothing afterwards', async () => {
    const online = manualTrigger();
    const handed: Principal[] = [];
    const stop = retryDeviceClaims({ resolve: async () => resolved, onResolved: (principal) => handed.push(principal), triggers: [online.trigger] });
    stop();
    assert.equal(online.count(), 0);
    online.fire();
    await settle();
    assert.deepEqual(handed, []);
  });
});

describe('verifier failures: only a verdict on the credential ends a tablet session (PR #176 review)', () => {
  it('revoked, disabled or deleted credentials are revoked; invalid or expired tokens are invalid', () => {
    for (const code of ['auth/id-token-revoked', 'auth/user-disabled', 'auth/user-not-found']) assert.equal(classifyVerifyError({ code }), 'revoked', code);
    for (const code of ['auth/argument-error', 'auth/invalid-id-token', 'auth/id-token-expired', 'auth/invalid-argument']) assert.equal(classifyVerifyError({ code }), 'invalid', code);
  });

  it('outages are transient: internal errors, network, quota, timeouts, unknown or missing codes', () => {
    for (const error of [
      { code: 'auth/internal-error' }, { code: 'app/network-error' }, { code: 'auth/quota-exceeded' },
      { code: 'app/network-timeout' }, { code: 'auth/something-new' }, new Error('ECONNRESET'), null, 'boom',
    ]) assert.equal(classifyVerifyError(error), 'transient', JSON.stringify(error));
  });

  it('the tablet ends its session only for revoked, deleting or invalid; never for unavailable or failed', () => {
    for (const code of ['device_revoked', 'household_deleting', 'unauthenticated']) assert.equal(endsTabletSession(code), true, code);
    for (const code of ['unavailable', 'failed', 'rate_limited', 'invalid_input', 'conflict']) assert.equal(endsTabletSession(code), false, code);
  });
});
