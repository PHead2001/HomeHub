import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  MAX_PUSH_TOKENS,
  PUSH_DEVICE_KEY,
  PUSH_REFRESH_MS,
  PUSH_UNKNOWN_TOKEN,
  createPushSignOutGate,
  nextPushTokens,
  pushRegistrationStep,
  pushSignInAction,
  runPushSignOut,
  pushSignOutPlan,
  readPushDevice,
  clearPushDevice,
  markPushSignOutUnfinished,
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
    assert.doesNotThrow(() => clearPushDevice(blocked));
    assert.doesNotThrow(() => markPushSignOutUnfinished(blocked));
  });
});

describe('push on sign-out (NO-2)', () => {
  test('without a remembered token it edits no account but still revokes the device registration', () => {
    assert.deepEqual(pushSignOutPlan(null, 'ann@example.com', false), { removeFromAccount: false, revoke: true, deferred: false });
    assert.deepEqual(pushSignOutPlan(null, 'ann@example.com', true), { removeFromAccount: false, revoke: false, deferred: true });
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
    markPushSignOutUnfinished(storage);
    assert.deepEqual(readPushDevice(storage), record(''));
    clearPushDevice(storage);
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
    clearPushDevice(storage);
    assert.equal(action('granted', 'bob@example.com', readPushDevice(storage)), 'register');

    writePushDevice(storage, 'device-token', 'ann@example.com', NOW);
    markPushSignOutUnfinished(storage);
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

describe('a registration still in flight when sign-out begins', () => {
  test('a pass taken before sign-out is never valid again, also after sign-out ended', () => {
    const gate = createPushSignOutGate();
    const pass = gate.pass();
    assert.equal(gate.allows(pass), true);
    gate.begin();
    assert.equal(gate.allows(pass), false, 'during sign-out');
    gate.end();
    assert.equal(gate.allows(pass), false, 'after a sign-out in place, the old registration stays void');
  });

  test('no registration can start during sign-out; a new one can once it is over', () => {
    const gate = createPushSignOutGate();
    gate.begin();
    const during = gate.pass();
    assert.equal(during, null);
    assert.equal(gate.allows(during), false);
    gate.end();
    assert.equal(gate.allows(during), false);
    assert.equal(gate.allows(gate.pass()), true, 'the next sign-in registers normally');
  });

  test('a token that arrives after sign-out began is discarded and revoked, never stored', () => {
    assert.equal(pushRegistrationStep('start', true), 'continue');
    assert.equal(pushRegistrationStep('token', true), 'continue');
    assert.equal(pushRegistrationStep('written', true), 'continue');
    assert.equal(pushRegistrationStep('start', false), 'stop', 'no token requested yet: nothing to clean up');
    assert.equal(pushRegistrationStep('token', false), 'discard', 'token obtained, not stored: revoke the device registration');
    assert.equal(pushRegistrationStep('written', false), 'undo', 'already stored: remove from the account and revoke');
  });

  // The registration's control flow against the gate, with the Firebase calls replaced by
  // promises the test settles: getToken resolves only after sign-out has begun.
  const registration = (gate: ReturnType<typeof createPushSignOutGate>, token: Promise<string>, write: () => Promise<void>, log: string[]) =>
    gate.track((async () => {
      const pass = gate.pass();
      if (pushRegistrationStep('start', gate.allows(pass)) === 'stop') { log.push('stopped'); return; }
      const value = await token;
      if (pushRegistrationStep('token', gate.allows(pass)) === 'discard') { log.push(`revoked ${value}`); return; }
      await write();
      log.push(`stored ${value}`);
      if (pushRegistrationStep('written', gate.allows(pass)) === 'undo') { log.push(`removed ${value}`, `revoked ${value}`); return; }
      log.push(`remembered ${value}`);
    })());

  test('sign-out during getToken: the result is revoked, nothing is written, and sign-out waits for it', async () => {
    const gate = createPushSignOutGate();
    const log: string[] = [];
    let deliver: (token: string) => void = () => {};
    void registration(gate, new Promise<string>(resolve => { deliver = resolve; }), async () => { log.push('write'); }, log);
    assert.equal(gate.busy(), true);

    gate.begin();
    let drained = false;
    const drain = gate.drain().then(() => { drained = true; });
    await Promise.resolve();
    assert.equal(drained, false, 'sign-out cleanup waits for the registration in flight');

    deliver('late-token');
    await drain;
    assert.deepEqual(log, ['revoked late-token']);
    assert.equal(gate.busy(), false);
  });

  test('sign-out during the write: the stored token is removed from the account again and revoked', async () => {
    const gate = createPushSignOutGate();
    const log: string[] = [];
    let finishWrite: () => void = () => {};
    void registration(gate, Promise.resolve('late-token'), () => new Promise<void>(resolve => { finishWrite = resolve; }), log);
    await new Promise(resolve => setTimeout(resolve, 0));
    gate.begin();
    finishWrite();
    await gate.drain();
    assert.deepEqual(log, ['stored late-token', 'removed late-token', 'revoked late-token']);
  });

  test('a registration that fails does not hold up or break the drain', async () => {
    const gate = createPushSignOutGate();
    gate.track(Promise.reject(new Error('getToken failed'))).catch(() => {});
    gate.begin();
    await gate.drain();
    assert.equal(gate.busy(), false);
  });
});

describe('sign-out push cleanup within one time budget', () => {
  const idle = { busy: () => false };
  const never = () => new Promise<boolean>(() => {});
  const neverAsked = async (): Promise<boolean> => { throw new Error('not asked when a token is remembered or a registration is running'); };

  test('loads nothing when there is no token, no registration in flight and no subscription', async () => {
    const storage = memory();
    let loaded = 0;
    const result = await runPushSignOut({ storage, gate: idle, hasSubscription: async () => false, cleanup: async () => { loaded += 1; return true; } });
    assert.equal(result, 'nothing');
    assert.equal(loaded, 0);
    assert.equal(storage.items.size, 0);
  });

  test('cleans up for a remembered token, a registration in flight, or a subscription without a record', async () => {
    const withRecord = memory();
    writePushDevice(withRecord, 'device-token', 'ann@example.com', NOW);
    assert.equal(await runPushSignOut({ storage: withRecord, gate: idle, hasSubscription: neverAsked, cleanup: async () => true }), 'removed');
    assert.equal(await runPushSignOut({ storage: memory(), gate: { busy: () => true }, hasSubscription: neverAsked, cleanup: async () => true }), 'removed');
    assert.equal(await runPushSignOut({ storage: memory(), gate: idle, hasSubscription: async () => true, cleanup: async () => true }), 'removed');
  });

  test('a module load that never finishes does not hold up sign-out, and the token is left marked', async () => {
    const storage = memory();
    writePushDevice(storage, 'device-token', 'ann@example.com', NOW);
    const errors: unknown[] = [];
    const started = Date.now();
    const result = await runPushSignOut({ storage, gate: idle, hasSubscription: async () => true, cleanup: never, ms: 30, onError: error => errors.push(error) });
    assert.equal(result, 'unfinished');
    assert.ok(Date.now() - started < 1000, 'sign-out carries on after the budget');
    assert.match(String(errors[0]), /Timed out after 30 ms/);
    assert.deepEqual(readPushDevice(storage), record(''), 'kept without an account');
    assert.equal(pushSignInAction({ permission: 'granted', email: 'bob@example.com', record: readPushDevice(storage), now: NOW }), 'replace');
  });

  test('a stalled subscription check is inside the same budget', async () => {
    const result = await runPushSignOut({ storage: memory(), gate: idle, hasSubscription: never, cleanup: async () => true, ms: 30 });
    assert.equal(result, 'unfinished');
  });

  test('an unfinished cleanup without a remembered token still makes the next sign-in revoke first', async () => {
    const storage = memory();
    const result = await runPushSignOut({ storage, gate: { busy: () => true }, hasSubscription: async () => true, cleanup: never, ms: 30 });
    assert.equal(result, 'unfinished');
    assert.deepEqual(readPushDevice(storage), { v: 1, token: PUSH_UNKNOWN_TOKEN, email: '', at: 0 });
    assert.equal(pushSignInAction({ permission: 'granted', email: 'bob@example.com', record: readPushDevice(storage), now: NOW }), 'replace');
    assert.deepEqual(pushSignOutPlan(readPushDevice(storage), 'bob@example.com', false), { removeFromAccount: false, revoke: true, deferred: false }, 'the placeholder is never removed from an account');
  });

  test('a failed module load or a cleanup that reports leftovers never rejects and leaves the mark', async () => {
    for (const cleanup of [async () => false, async (): Promise<boolean> => { throw new Error('ChunkLoadError'); }]) {
      const storage = memory();
      writePushDevice(storage, 'device-token', 'ann@example.com', NOW);
      assert.equal(await runPushSignOut({ storage, gate: idle, hasSubscription: async () => true, cleanup }), 'unfinished');
      assert.deepEqual(readPushDevice(storage), record(''));
    }
  });

  test('a token registered while the cleanup was stalled is marked too', async () => {
    const storage = memory();
    const result = runPushSignOut({ storage, gate: { busy: () => true }, hasSubscription: async () => false, cleanup: never, ms: 30 });
    writePushDevice(storage, 'late-token', 'ann@example.com', NOW);
    assert.equal(await result, 'unfinished');
    assert.deepEqual(readPushDevice(storage), record('', NOW, 'late-token'));
  });
});

describe('sign-out order in the auth provider', () => {
  const source = readFileSync(resolve(__dirname, '../../src/contexts/auth-context.tsx'), 'utf8').replace(/\r\n/g, '\n');

  test('registrations are voided first, before sign-out looks for a token', () => {
    const logout = source.slice(source.indexOf('const logout = useCallback'));
    const begin = logout.indexOf('pushSignOutGate.begin()');
    const cleanup = logout.indexOf('runPushSignOut(');
    assert.ok(begin > 0 && begin < cleanup, 'the gate closes before the cleanup decides anything');
    assert.ok(begin < logout.indexOf('await '), 'and before the first await of sign-out');
    assert.equal(/readPushDevice\(/.test(logout.slice(0, cleanup)), false, 'no record check ahead of the cleanup');
  });

  test('the module load is inside the bounded cleanup, not awaited by logout itself', () => {
    assert.match(source, /cleanup: async \(\) => \(await import\('@\/lib\/push-registration'\)\)\.unregisterPushOnThisDevice\(\),/);
    assert.equal(source.match(/import\('@\/lib\/push-registration'\)/g)?.length, 1);
  });

  test('push is removed while still signed in, before the cache flush and Auth sign-out', () => {
    const unregister = source.indexOf('unregisterPushOnThisDevice()');
    const flush = source.indexOf('clearLocalFirestoreCache()', unregister);
    const signOut = source.indexOf('await signOut(auth)', unregister);
    assert.ok(unregister > 0, 'logout unregisters push');
    assert.ok(flush > unregister, 'before the Firestore flush, which terminates Firestore');
    assert.ok(signOut > flush, 'and before Auth sign-out');
  });
});
