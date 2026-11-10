import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  MAX_PUSH_TOKENS,
  PUSH_DEVICE_KEY,
  PUSH_REFRESH_MS,
  nextPushTokens,
  pushSignInAction,
  pushSignOutPlan,
  readPushDevice,
  settlePushSignOut,
  settleWithin,
  withoutPushToken,
  writePushDevice,
  type PushDeviceRecord,
} from '../../src/lib/push-tokens';

const memory = () => {
  const items = new Map<string, string>();
  return {
    items,
    getItem: (k: string) => items.get(k) ?? null,
    setItem: (k: string, v: string) => { items.set(k, v); },
    removeItem: (k: string) => { items.delete(k); },
  };
};

const NOW = 1_800_000_000_000;
const record = (email: string, at = NOW, token = 'device-token'): PushDeviceRecord => ({ v: 1, token, email, at });

describe('push registration remembered on the device (NO-2)', () => {
  test('round-trips the token with the account that holds it', () => {
    const storage = memory();
    assert.equal(readPushDevice(storage), null, 'nothing stored yet');
    writePushDevice(storage, 'device-token', 'ann@example.com', NOW);
    assert.deepEqual(readPushDevice(storage), record('ann@example.com'));
    assert.equal(readPushDevice(null), null, 'no storage');
  });

  test('ignores malformed or foreign values instead of trusting them', () => {
    const storage = memory();
    for (const value of ['not json', '"token"', '{"v":2,"token":"t","email":"a"}', '{"v":1,"token":"","email":"a"}', '{"v":1,"token":"t"}']) {
      storage.setItem(PUSH_DEVICE_KEY, value);
      assert.equal(readPushDevice(storage), null, value);
    }
  });

  test('blocked storage never throws', () => {
    const blocked = {
      getItem: () => { throw new Error('blocked'); },
      setItem: () => { throw new Error('blocked'); },
      removeItem: () => { throw new Error('blocked'); },
    };
    assert.equal(readPushDevice(blocked), null);
    assert.doesNotThrow(() => writePushDevice(blocked, 't', 'a@example.com', NOW));
    assert.doesNotThrow(() => settlePushSignOut(blocked, record('a@example.com'), true));
    assert.doesNotThrow(() => settlePushSignOut(blocked, record('a@example.com'), false));
  });
});

describe('push on sign-out (NO-2)', () => {
  test('does nothing when this device never stored a token', () => {
    assert.deepEqual(pushSignOutPlan(null, 'ann@example.com', false), { removeFromAccount: false, revoke: false, deferred: false });
    assert.deepEqual(pushSignOutPlan(null, 'ann@example.com', true), { removeFromAccount: false, revoke: false, deferred: false });
  });

  test('removes the token from the account that is signing out and revokes it', () => {
    assert.deepEqual(pushSignOutPlan(record('ann@example.com'), 'ann@example.com', false), { removeFromAccount: true, revoke: true, deferred: false });
  });

  test('never edits an account other than the one that holds the token', () => {
    const expected = { removeFromAccount: false, revoke: true, deferred: false };
    assert.deepEqual(pushSignOutPlan(record('ann@example.com'), 'bob@example.com', false), expected);
    assert.deepEqual(pushSignOutPlan(record(''), 'bob@example.com', false), expected, 'left over from an unfinished sign-out');
    assert.deepEqual(pushSignOutPlan(record('ann@example.com'), null, false), expected, 'already signed out');
    assert.deepEqual(pushSignOutPlan(record(''), '', false), expected, 'an empty email never matches the unfinished marker');
  });

  test('offline it skips the network and defers to the next sign-in', () => {
    assert.deepEqual(pushSignOutPlan(record('ann@example.com'), 'ann@example.com', true), { removeFromAccount: false, revoke: false, deferred: true });
  });

  test('a finished removal forgets the token; an unfinished one keeps it without an account', () => {
    const storage = memory();
    writePushDevice(storage, 'device-token', 'ann@example.com', NOW);
    settlePushSignOut(storage, record('ann@example.com'), false);
    assert.deepEqual(readPushDevice(storage), record(''));
    settlePushSignOut(storage, record(''), true);
    assert.equal(storage.items.has(PUSH_DEVICE_KEY), false);
  });
});

describe('silent push registration after sign-in (NO-2)', () => {
  const action = (permission: NotificationPermission | 'unsupported', email: string | null, stored: PushDeviceRecord | null, now = NOW) =>
    pushSignInAction({ permission, email, record: stored, now });

  test('never registers without granted permission or without a signed-in account', () => {
    for (const permission of ['default', 'denied', 'unsupported'] as const) {
      assert.equal(action(permission, 'ann@example.com', null), 'none', permission);
      assert.equal(action(permission, 'ann@example.com', record('bob@example.com')), 'none', permission);
    }
    assert.equal(action('granted', null, null), 'none');
    assert.equal(action('granted', '', record('')), 'none', 'signed out with an unfinished marker');
  });

  test('registers when permission is granted and no token is remembered', () => {
    assert.equal(action('granted', 'ann@example.com', null), 'register');
  });

  test('leaves a current registration of the same account alone, and confirms it weekly', () => {
    assert.equal(action('granted', 'ann@example.com', record('ann@example.com')), 'none');
    assert.equal(action('granted', 'ann@example.com', record('ann@example.com', NOW - PUSH_REFRESH_MS + 1)), 'none');
    assert.equal(action('granted', 'ann@example.com', record('ann@example.com', NOW - PUSH_REFRESH_MS)), 'register');
  });

  test("replaces a token left by another account or by an unfinished sign-out", () => {
    assert.equal(action('granted', 'bob@example.com', record('ann@example.com')), 'replace');
    assert.equal(action('granted', 'ann@example.com', record('')), 'replace');
  });

  test('sign-out then sign-in on a shared device: the next account registers afresh', () => {
    const storage = memory();
    writePushDevice(storage, 'device-token', 'ann@example.com', NOW);
    settlePushSignOut(storage, readPushDevice(storage)!, true);
    assert.equal(action('granted', 'bob@example.com', readPushDevice(storage)), 'register');

    writePushDevice(storage, 'device-token', 'ann@example.com', NOW);
    settlePushSignOut(storage, readPushDevice(storage)!, false);
    assert.equal(action('granted', 'bob@example.com', readPushDevice(storage)), 'replace');
    assert.equal(action('granted', 'ann@example.com', readPushDevice(storage)), 'replace', 'even the same account does not trust it');
  });

  test('a refreshed token replaces the old one and the cap of 20 still holds', () => {
    const full = Array.from({ length: MAX_PUSH_TOKENS }, (_, i) => `t${i}`);
    const next = nextPushTokens(withoutPushToken(full, 't5'), withoutPushToken(undefined, 't5'), 'new');
    assert.equal(next.length, MAX_PUSH_TOKENS);
    assert.equal(next.includes('t5'), false);
    assert.equal(next[0], 't0', 'no other device lost its place');
    assert.equal(next[next.length - 1], 'new');
    assert.deepEqual(withoutPushToken(['a', 'b'], null), ['a', 'b']);
    assert.deepEqual(withoutPushToken('not-a-list', 'a'), []);
  });
});

describe('bounded sign-out work', () => {
  test('returns the result when the work finishes in time', async () => {
    assert.equal(await settleWithin(async () => true, 1000, false), true);
  });

  test('gives up after the timeout and reports it, without rejecting', async () => {
    const errors: unknown[] = [];
    const started = Date.now();
    const result = await settleWithin(() => new Promise<boolean>(() => {}), 30, false, error => errors.push(error));
    assert.equal(result, false);
    assert.ok(Date.now() - started < 1000);
    assert.equal(errors.length, 1);
    assert.match(String(errors[0]), /Timed out after 30 ms/);
  });

  test('a failure, thrown or rejected, becomes the fallback', async () => {
    const errors: unknown[] = [];
    assert.equal(await settleWithin(() => Promise.reject(new Error('denied')), 1000, false, error => errors.push(error)), false);
    assert.equal(await settleWithin(() => { throw new Error('sync'); }, 1000, false, error => errors.push(error)), false);
    assert.deepEqual(errors.map(String), ['Error: denied', 'Error: sync']);
  });

  test('work that settles after the timeout cannot change the answer', async () => {
    let finish: (value: boolean) => void = () => {};
    const result = await settleWithin(() => new Promise<boolean>(resolve => { finish = resolve; }), 20, false);
    finish(true);
    assert.equal(result, false);
  });
});

describe('sign-out order in the auth provider', () => {
  const source = readFileSync(resolve(__dirname, '../../src/contexts/auth-context.tsx'), 'utf8');

  test('push is removed while still signed in, before the cache flush and Auth sign-out', () => {
    const unregister = source.indexOf('unregisterPushOnThisDevice()');
    const flush = source.indexOf('clearLocalFirestoreCache()', unregister);
    const signOut = source.indexOf('await signOut(auth)', unregister);
    assert.ok(unregister > 0, 'logout unregisters push');
    assert.ok(flush > unregister, 'before the Firestore flush, which terminates Firestore');
    assert.ok(signOut > flush, 'and before Auth sign-out');
  });
});
