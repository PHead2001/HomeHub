import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, mock, test } from 'node:test';
import { FieldValue } from 'firebase-admin/firestore';
import { adminDb } from '../../src/lib/server/firebase-admin';
import { DeviceActionError, authorizeDeviceAction } from '../../src/lib/server/device-gate';
import {
  PinError,
  clearChildPin,
  clearMemberPin,
  clearPinLockout,
  endPinSession,
  pinStatuses,
  setChildPin,
  setMyPin,
  verifyDevicePin,
  type VerifyPinTestHooks,
} from '../../src/lib/server/pins';
import { changeMemberRole, leaveHousehold, removeMember } from '../../src/lib/server/household-membership';
import { createDeviceRepairCode, redeemDeviceCode } from '../../src/lib/server/device-management';
import {
  clearChildPinAction,
  clearMemberPinAction,
  clearPinLockoutAction,
  pinStatusAction,
  setChildPinAction,
  setMyPinAction,
  updatePointsPinAction,
} from '../../src/app/household/pin-actions';
import { endPinSessionAction, verifyDevicePinAction } from '../../src/app/devices/actions';
import { deleteDeviceUsers, nonce, personToken, seedHousehold, signIn, type Person } from './device-test-helpers';
import { TEST_PEPPER_ID, clock, house, opId, pairTablet, seedKid, sessionsOf, installTestPepper, type Tablet } from './device-actor-helpers';


/**
 * The gate with an injected clock: a test's `at` is the server time for authorization and
 * for every precheck (production passes no clock and reads the real time each time).
 */
const authorize = (request: Parameters<typeof authorizeDeviceAction>[0], at?: Date, options: Parameters<typeof authorizeDeviceAction>[1] = {}) =>
  authorizeDeviceAction(request, { ...options, ...(at ? { clock: () => at } : {}) });

// Tablet PINs (docs/modules/devices/README.md, "PINs"; design 7, re-review R2): the
// WT-17 authority matrix (including forbidden known-value resets), format, storage
// (scrypt with the pepper, never returned), fail-closed without a pepper, pepper
// rotation, lockouts per tablet+person and per person with an injected clock,
// pessimistic counting under concurrency, the R2 race (PIN changed between the two
// transactions), settle failure, PIN sessions and what ends them.

const H = 'pins-house';
const owner: Person = { uid: 'p-owner', email: 'p.owner@example.test', displayName: 'Olive', role: 'owner' };
const admin: Person = { uid: 'p-admin', email: 'p.admin@example.test', displayName: 'Ada', role: 'admin' };
const admin2: Person = { uid: 'p-admin2', email: 'p.admin2@example.test', displayName: 'Abe', role: 'admin' };
const member: Person = { uid: 'p-member', email: 'p.member@example.test', displayName: 'Max', role: 'member' };
const member2: Person = { uid: 'p-member2', email: 'p.member2@example.test', displayName: 'Meg', role: 'member' };
const child: Person = { uid: 'p-child', email: 'p.child@example.test', displayName: 'Cleo', role: 'child' };
const guest: Person = { uid: 'p-guest', email: 'p.guest@example.test', displayName: 'Gus', role: 'guest' };
const KID = 'kid_PinsKid0000000000000';
const created = new Set<string>();
let tablet: Tablet;

const pinErr = async (promise: Promise<unknown>, code: string) => {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof PinError, `expected PinError(${code}), got ${String(error)}`);
    assert.equal(error.code, code);
    return true;
  });
};
const deviceErr = async (promise: Promise<unknown>, code: string, check?: (error: DeviceActionError) => void) => {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof DeviceActionError, `expected DeviceActionError(${code}), got ${String(error)}`);
    assert.equal(error.code, code);
    check?.(error);
    return true;
  });
};

const pinDoc = async (uid: string) => (await house(H).collection('members').doc(uid).collection('private').doc('pin').get()).data();
const memberGuard = async (uid: string) => (await house(H).collection('members').doc(uid).collection('private').doc('pinGuard').get()).data();
const verify = (t: Tablet, actorUid: string, pin: string, now: Date, extra: Parameters<typeof verifyDevicePin>[1] = {}) =>
  verifyDevicePin({ idToken: t.idToken, householdId: H, actorUid, pin }, { now, ...extra });

before(async () => {
  installTestPepper();
  await seedHousehold(H, [owner, admin, admin2, member, member2, child, guest]);
  await seedKid(H, KID, 'Mia');
  tablet = await pairTablet(H, owner, created);
});

beforeEach(async () => {
  // The per-person PIN-set budget is about real people at a phone; tests set PINs far more
  // often than that, so each test starts with a fresh budget (the limit has its own test).
  const windows = (globalThis as { __homeHubDeviceWindows?: Map<string, number[]> }).__homeHubDeviceWindows;
  for (const key of [...(windows?.keys() ?? [])]) if (key.startsWith('pin-set:')) windows!.delete(key);
  // Every test starts with no PINs and no lockouts.
  const members = await house(H).collection('members').get();
  for (const m of members.docs) {
    await m.ref.collection('private').doc('pin').delete();
    await m.ref.collection('private').doc('pinGuard').delete();
  }
  await house(H).update({ devicePolicy: { pointsPin: 'off' } });
});

after(async () => {
  await deleteDeviceUsers([...created]);
  await adminDb.recursiveDelete(house(H));
  const codes = await adminDb.collection('deviceCodes').where('householdId', '==', H).get();
  await Promise.all(codes.docs.map(d => d.ref.delete()));
});

describe('authority matrix (WT-9a/b, WT-17)', () => {
  test('everyone with an account sets their own PIN; guests and kid profiles cannot', async () => {
    for (const person of [owner, admin, member, child]) {
      await setMyPin(person, { householdId: H, pin: '2580' });
      const doc = await pinDoc(person.uid);
      assert.equal(doc?.setHow, 'self');
      assert.equal(doc?.pinVersion, 1);
    }
    await pinErr(setMyPin(guest, { householdId: H, pin: '2580' }), 'forbidden');
    await pinErr(setMyPin({ uid: 'stranger', email: 's@example.test' }, { householdId: H, pin: '2580' }), 'not_member');
    await pinErr(setMyPin(member, { householdId: H, pin: '1234' }), 'invalid_input');
    await pinErr(setMyPin(member, { householdId: H, pin: '0000' }), 'invalid_input');
    await pinErr(setMyPin(member, { householdId: H, pin: '12' }), 'invalid_input');
  });

  test('clearing: yourself, or an owner/admin for a strictly lower role; never set for another account', async () => {
    for (const person of [owner, admin, admin2, member, member2, child]) await setMyPin(person, { householdId: H, pin: '2580' });
    // Admin → member: clear only.
    assert.deepEqual(await clearMemberPin(admin, { householdId: H, targetUid: member.uid }), { cleared: true });
    assert.equal((await pinDoc(member.uid))?.hash, null);
    assert.equal((await pinDoc(member.uid))?.pinVersion, 2);
    // Equal or higher rank: refused (admin → admin, admin → owner, member → child).
    await pinErr(clearMemberPin(admin, { householdId: H, targetUid: admin2.uid }), 'forbidden');
    await pinErr(clearMemberPin(admin, { householdId: H, targetUid: owner.uid }), 'forbidden');
    await pinErr(clearMemberPin(member2, { householdId: H, targetUid: child.uid }), 'forbidden');
    // The owner's PIN changes only by the owner (WT-17c).
    assert.deepEqual(await clearMemberPin(owner, { householdId: H, targetUid: owner.uid }), { cleared: true });
    assert.deepEqual(await clearMemberPin(owner, { householdId: H, targetUid: admin.uid }), { cleared: true });
    // Known-value resets of accounts are impossible: the kid-PIN path refuses accounts.
    await pinErr(setChildPin(admin, { householdId: H, childId: member2.uid, pin: '7391' }), 'forbidden');
    await pinErr(setChildPin(owner, { householdId: H, childId: child.uid, pin: '7391' }), 'forbidden');
    await pinErr(setChildPin(owner, { householdId: H, childId: admin2.uid, pin: '7391' }), 'forbidden');
    assert.equal((await pinDoc(admin2.uid))?.pinVersion, 1);
  });

  test('kid profile PINs: owners and admins set and clear; members cannot', async () => {
    await setChildPin(admin, { householdId: H, childId: KID, pin: '9314' });
    assert.equal((await pinDoc(KID))?.setHow, 'admin-for-child');
    assert.equal((await pinDoc(KID))?.setByUid, admin.uid);
    await pinErr(setChildPin(member, { householdId: H, childId: KID, pin: '9314' }), 'forbidden');
    await pinErr(clearChildPin(member, { householdId: H, childId: KID }), 'forbidden');
    assert.deepEqual(await clearChildPin(owner, { householdId: H, childId: KID }), { cleared: true });
    assert.deepEqual(await clearChildPin(owner, { householdId: H, childId: KID }), { cleared: false });
  });

  test('lockout clearing: yourself or an owner/admin above the person', async () => {
    await pinErr(clearPinLockout(member, { householdId: H, targetUid: child.uid }), 'forbidden');
    await pinErr(clearPinLockout(admin, { householdId: H, targetUid: owner.uid }), 'forbidden');
    assert.deepEqual(await clearPinLockout(member, { householdId: H, targetUid: member.uid }), { cleared: true });
    assert.deepEqual(await clearPinLockout(admin, { householdId: H, targetUid: member.uid }), { cleared: true });
  });

  test('status: owners and admins see everyone, others only themselves; no PIN material', async () => {
    await setMyPin(member, { householdId: H, pin: '2580' });
    const all = await pinStatuses(admin, { householdId: H });
    assert.deepEqual(all[member.uid], { hasPin: true, locked: false });
    assert.deepEqual(all[owner.uid], { hasPin: false, locked: false });
    assert.deepEqual(Object.keys(await pinStatuses(member, { householdId: H })), [member.uid]);
  });

  test('server actions: real ID tokens; a tablet token is refused for every PIN action; results carry no PIN material', async () => {
    const token = await personToken(member);
    const set = await setMyPinAction({ idToken: token, householdId: H, pin: '4826' });
    assert.deepEqual(set, { ok: true, data: { set: true } });
    const status = await pinStatusAction({ idToken: token, householdId: H });
    const stored = await pinDoc(member.uid);
    for (const value of [set, status]) {
      const json = JSON.stringify(value);
      assert.ok(!json.includes('4826') && !json.includes(stored!.hash) && !json.includes(stored!.salt));
    }
    const device = { idToken: tablet.idToken, householdId: H };
    const outcomes = await Promise.all([
      setMyPinAction({ ...device, pin: '7391' }),
      clearMemberPinAction({ ...device, targetUid: member.uid }),
      setChildPinAction({ ...device, childId: KID, pin: '7391' }),
      clearChildPinAction({ ...device, childId: KID }),
      clearPinLockoutAction({ ...device, targetUid: member.uid }),
      pinStatusAction(device),
      updatePointsPinAction({ ...device, pointsPin: 'everyone' }),
    ]);
    for (const outcome of outcomes) assert.equal(outcome.ok ? 'ok' : outcome.code, 'unauthenticated');
    assert.equal((await pinDoc(member.uid))?.pinVersion, stored!.pinVersion);
    // Activity: who, for whom, never the value or hash.
    const entries = (await house(H).collection('auditLogs').where('action', '==', 'pin.set').get()).docs.map(d => JSON.stringify(d.data()));
    assert.ok(entries.length > 0);
    for (const entry of entries) assert.ok(!entry.includes('4826') && !entry.includes(stored!.hash));
  });
});

describe('storage and pepper', () => {
  test('stored as scrypt with the production parameters and the pepper id; set fails closed without a pepper', async () => {
    await setMyPin(member, { householdId: H, pin: '4826' });
    const doc = await pinDoc(member.uid);
    assert.deepEqual(doc?.params, { alg: 'scrypt', N: 32768, r: 8, p: 1, keyLen: 32, maxmem: 67108864 });
    assert.equal(doc?.pepperId, TEST_PEPPER_ID);
    assert.equal(Buffer.from(doc!.salt, 'base64').length, 16);
    assert.equal(Buffer.from(doc!.hash, 'base64').length, 32);
    // The PIN itself is stored nowhere (random hash, salt and id may contain any digits).
    assert.ok(Object.values(doc!).every(value => value !== '4826'));
    assert.notEqual(Buffer.from(doc!.hash, 'base64').toString('utf8'), '4826');
    const current = process.env.HOMEHUB_PIN_PEPPER_CURRENT;
    delete process.env.HOMEHUB_PIN_PEPPER_CURRENT;
    try {
      await pinErr(setMyPin(member, { householdId: H, pin: '7391' }), 'pin_unavailable');
    } finally {
      process.env.HOMEHUB_PIN_PEPPER_CURRENT = current;
    }
    // A verify whose pepper is gone fails closed too, before counting anything.
    const pepper = process.env[`HOMEHUB_PIN_PEPPER_${TEST_PEPPER_ID}`];
    delete process.env[`HOMEHUB_PIN_PEPPER_${TEST_PEPPER_ID}`];
    try {
      await deviceErr(verify(tablet, member.uid, '4826', clock(Date.parse('2026-11-20T10:00:00Z')).now()), 'pin_unavailable');
    } finally {
      process.env[`HOMEHUB_PIN_PEPPER_${TEST_PEPPER_ID}`] = pepper;
    }
    assert.equal(await memberGuard(member.uid), undefined);
  });

  test('rotation: a verify against an older pepper re-hashes with the current one (same pinVersion)', async () => {
    await setMyPin(member, { householdId: H, pin: '4826' });
    const before = await pinDoc(member.uid);
    installTestPepper('test2');
    try {
      const session = await verify(tablet, member.uid, '4826', clock(Date.parse('2026-11-20T11:00:00Z')).now());
      const after = await pinDoc(member.uid);
      assert.equal(after?.pepperId, 'test2');
      assert.equal(after?.pinVersion, before?.pinVersion);
      assert.notEqual(after?.hash, before?.hash);
      assert.ok(session.pinSessionId);
      await verify(tablet, member.uid, '4826', clock(Date.parse('2026-11-20T11:01:00Z')).now());
    } finally {
      installTestPepper();
    }
  });
});

describe('verification and lockouts (7.3, 7.4)', () => {
  test('the result holds only the session id and expiry; no PIN set → no_pin_set; wrong → attempts left', async () => {
    const t = clock(Date.parse('2026-11-21T09:00:00Z'));
    await deviceErr(verify(tablet, member.uid, '4826', t.now()), 'no_pin_set');
    await setMyPin(member, { householdId: H, pin: '4826' });
    const result = await verify(tablet, member.uid, '4826', t.advance(7000));
    assert.deepEqual(Object.keys(result).sort(), ['expiresAt', 'ok', 'pinSessionId']);
    assert.match(result.pinSessionId, /^[A-Za-z0-9_-]{43}$/);
    const stored = (await sessionsOf(H, tablet.deviceId)).find(d => d.get('memberUid') === member.uid)!;
    assert.notEqual(stored.id, result.pinSessionId);
    assert.equal(stored.get('roleAtUnlock'), 'member');
    await deviceErr(verify(tablet, member.uid, '7391', t.advance(7000)), 'pin_wrong', error => assert.equal(error.attemptsLeft, 4));
    const action = await verifyDevicePinAction({ idToken: tablet.idToken, householdId: H, actorUid: member.uid, pin: '7391' });
    assert.deepEqual(action, { ok: false, code: 'pin_wrong', attemptsLeft: 3 });
    const personal = await verifyDevicePinAction({ idToken: await personToken(member), householdId: H, actorUid: member.uid, pin: '4826' });
    assert.equal(personal.ok ? 'ok' : personal.code, 'not_a_device');
  });

  test('per tablet and person: 5 wrong → 1 min, then 2, 4, 8, 15 (cap); a locked PIN is not evaluated; a correct one resets', async () => {
    await setMyPin(member, { householdId: H, pin: '4826' });
    const t = await pairTablet(H, owner, created, 'Lockout tablet');
    const c = clock(Date.parse('2026-11-22T09:00:00Z'));
    const expected = [60, 120, 240, 480, 900, 900];
    for (const seconds of expected) {
      for (let i = 0; i < 4; i++) await deviceErr(verify(t, member.uid, '7391', c.advance(7000)), 'pin_wrong');
      await deviceErr(verify(t, member.uid, '7391', c.advance(7000)), 'pin_locked', error => assert.equal(error.retryAfterSec, seconds));
      // Even the right PIN is refused while locked, without hashing or counting.
      await deviceErr(verify(t, member.uid, '4826', c.advance(1000)), 'pin_locked');
      c.advance(seconds * 1000);
      // The member-wide guard (20 an hour) is cleared here: this test is about the tablet's schedule.
      await clearPinLockoutMemberOnly(member.uid);
    }
    assert.ok(await verify(t, member.uid, '4826', c.advance(7000)));
    const guard = (await house(H).collection('devices').doc(t.deviceId).collection('pinGuards').doc(member.uid).get()).data()!;
    assert.equal(guard.failures, 0);
    assert.equal(guard.lockouts, 0);
    assert.equal(guard.lockedUntil, null);
    // Every tablet-level lock left an activity entry by the tablet (security review 1).
    const paused = (await house(H).collection('auditLogs').where('action', '==', 'pin.device_locked').get()).docs
      .filter(d => d.get('targetUid') === member.uid && d.get('deviceId') === t.deviceId);
    assert.equal(paused.length, expected.length);
    assert.ok(paused.every(d => String(d.get('actorUid')).startsWith('device_')));
  });

  test('per person across tablets: 20 wrong within an hour hard-locks on every tablet until cleared; owners and admins are told', async () => {
    await setMyPin(member, { householdId: H, pin: '4826' });
    const tablets: Tablet[] = [];
    for (let i = 0; i < 5; i++) tablets.push(await pairTablet(H, owner, created, `Wall ${i}`));
    const c = clock(Date.parse('2026-11-23T09:00:00Z'));
    let last: unknown;
    for (const t of tablets) {
      for (let i = 0; i < 4; i++) {
        last = await verify(t, member.uid, '7391', c.advance(1000)).catch(error => error);
      }
    }
    assert.ok(last instanceof DeviceActionError && last.code === 'pin_locked_member');
    await deviceErr(verify(tablet, member.uid, '4826', c.advance(1000)), 'pin_locked_member');
    assert.ok((await memberGuard(member.uid))?.lockedAt);
    const audit = await house(H).collection('auditLogs').where('action', '==', 'pin.locked').get();
    const entry = audit.docs.find(d => d.get('targetUid') === member.uid);
    assert.ok(entry);
    // Written by the tablet (actor), about the person (target).
    assert.match(entry!.get('actorUid'), /^device_/);
    assert.equal(entry!.get('details')?.reason, 'hour');
    const notices = await house(H).collection('notifications').where('sourceType', '==', 'pin-locked').get();
    const audience = new Set(notices.docs.map(d => d.get('targetUserUid')));
    assert.ok(audience.has(owner.uid) && audience.has(admin.uid) && audience.has(admin2.uid));
    assert.ok(!audience.has(member.uid));
    assert.deepEqual((await pinStatuses(admin, { householdId: H }))[member.uid], { hasPin: true, locked: true });
    await clearPinLockout(admin, { householdId: H, targetUid: member.uid });
    assert.ok(await verify(tablet, member.uid, '4826', c.advance(1000)));
  });

  test('concurrent wrong guesses are all counted (pessimistic counting); the same tablet and person at once → busy', async () => {
    await setMyPin(member, { householdId: H, pin: '4826' });
    const tablets: Tablet[] = [];
    for (let i = 0; i < 6; i++) tablets.push(await pairTablet(H, owner, created, `Parallel ${i}`));
    const at = clock(Date.parse('2026-11-24T09:00:00Z')).now();
    const outcomes = await Promise.all(tablets.map(t => verify(t, member.uid, '7391', at, { limits: { concurrentHashes: 8 } }).catch(error => error)));
    assert.ok(outcomes.every(error => error instanceof DeviceActionError && error.code === 'pin_wrong'));
    assert.equal((await memberGuard(member.uid))?.recentFailures.length, 6);
    // Same tablet, same person, at once: the second is refused before any work and not counted.
    const twin = await Promise.all([0, 1].map(() => verify(tablets[0], member.uid, '7391', new Date(at.getTime() + 60_000)).catch(error => error)));
    const codes = twin.map(error => (error as DeviceActionError).code).sort();
    assert.deepEqual(codes, ['busy', 'pin_wrong']);
    assert.equal((await memberGuard(member.uid))?.recentFailures.length, 7);
    // Admission: twice the hash slots may wait for a slot at once, the rest are busy (never counted).
    const many = await Promise.all(tablets.map(t => verify(t, member.uid, '7391', new Date(at.getTime() + 120_000), { limits: { concurrentHashes: 2 } }).catch(error => error)));
    const busy = many.filter(error => (error as DeviceActionError).code === 'busy').length;
    assert.ok(busy >= 2);
    assert.equal((await memberGuard(member.uid))?.recentFailures.length, 7 + (6 - busy));
  });

  test('R2: a PIN changed between the reserve and the settle opens no session', async () => {
    await setMyPin(member, { householdId: H, pin: '4826' });
    const t = await pairTablet(H, owner, created, 'Race tablet');
    const at = clock(Date.parse('2026-11-25T09:00:00Z')).now();
    await deviceErr(verify(t, member.uid, '4826', at, { testHooks: { afterCompare: () => setMyPin(member, { householdId: H, pin: '7391' }).then(() => undefined) } }), 'pin_session_invalid');
    assert.equal((await sessionsOf(H, t.deviceId)).length, 0);
    // A clear in between likewise.
    await deviceErr(verify(t, member.uid, '7391', new Date(at.getTime() + 7000), { testHooks: { afterCompare: () => clearMemberPin(member, { householdId: H, targetUid: member.uid }).then(() => undefined) } }), 'pin_session_invalid');
    assert.equal((await sessionsOf(H, t.deviceId)).length, 0);
  });

  test('R2: a correct PIN never forgives a failure another tablet recorded meanwhile', async () => {
    await setMyPin(member, { householdId: H, pin: '4826' });
    const t1 = await pairTablet(H, owner, created, 'Left tablet');
    const t2 = await pairTablet(H, owner, created, 'Right tablet');
    const at = clock(Date.parse('2026-11-26T09:00:00Z')).now();
    await deviceErr(verify(t1, member.uid, '7391', at), 'pin_wrong');
    const result = await verify(t1, member.uid, '4826', new Date(at.getTime() + 7000), {
      testHooks: { afterCompare: async () => { await verify(t2, member.uid, '7391', new Date(at.getTime() + 8000)).catch(() => undefined); } },
    });
    assert.ok(result.pinSessionId);
    const failures = (await memberGuard(member.uid))!.recentFailures;
    // t1's earlier wrong guess stays counted per person (it was not this attempt's), t2's too; only the correct attempt's own entry left.
    assert.equal(failures.length, 2);
    const t1Guard = (await house(H).collection('devices').doc(t1.deviceId).collection('pinGuards').doc(member.uid).get()).data()!;
    assert.equal(t1Guard.failures, 0);
    const t2Guard = (await house(H).collection('devices').doc(t2.deviceId).collection('pinGuards').doc(member.uid).get()).data()!;
    assert.equal(t2Guard.failures, 1);
  });

  test('a settle transaction that fails answers failed and leaves no session', async () => {
    await setMyPin(member, { householdId: H, pin: '4826' });
    const t = await pairTablet(H, owner, created, 'Flaky tablet');
    await deviceErr(verify(t, member.uid, '4826', clock(Date.parse('2026-11-27T09:00:00Z')).now(), {
      testHooks: { duringSettle: () => { throw new Error('simulated commit failure'); } },
    }), 'failed');
    assert.equal((await sessionsOf(H, t.deviceId)).length, 0);
  });
});

describe('PIN sessions (7.5): what ends them', () => {
  const pinAction = (t: Tablet, actorUid: string, pinSessionId: string, now: Date) =>
    authorize({ idToken: t.idToken, householdId: H, capability: 'pets.pet.delete', actorUid, pinSessionId, opId: opId() }, now);

  test('PIN change, PIN clear, role change, Done, idle expiry, removal and re-pairing', async () => {
    await setMyPin(admin, { householdId: H, pin: '1357' });
    await setMyPin(member, { householdId: H, pin: '4826' });
    const t = await pairTablet(H, owner, created, 'Session tablet');
    const c = clock(Date.parse('2026-11-28T09:00:00Z'));
    const open = async (uid: string, pin: string) => (await verify(t, uid, pin, c.advance(7000))).pinSessionId;

    let session = await open(admin.uid, '1357');
    assert.equal((await pinAction(t, admin.uid, session, c.now())).level, 'pin');
    await setMyPin(admin, { householdId: H, pin: '7391' });
    await deviceErr(pinAction(t, admin.uid, session, c.now()), 'pin_session_invalid');

    session = await open(admin.uid, '7391');
    await clearMemberPin(owner, { householdId: H, targetUid: admin.uid });
    await deviceErr(pinAction(t, admin.uid, session, c.now()), 'no_pin_set');
    await setMyPin(admin, { householdId: H, pin: '1357' });
    await deviceErr(pinAction(t, admin.uid, session, c.now()), 'pin_session_invalid');

    // A role change: the session was opened as a member; as a child it no longer counts.
    session = await open(member.uid, '4826');
    const feed = (at: Date) => authorize({ idToken: t.idToken, householdId: H, capability: 'pets.feed', actorUid: member.uid, pinSessionId: session, opId: opId() }, at);
    assert.equal((await feed(c.now())).level, 'pin');
    await changeMemberRole(owner, H, member.uid, 'child');
    await deviceErr(feed(c.now()), 'pin_session_invalid');
    await changeMemberRole(owner, H, member.uid, 'member');

    session = await open(admin.uid, '1357');
    assert.deepEqual(await endPinSession({ idToken: t.idToken, householdId: H, pinSessionId: session }, c.now()), { ended: true });
    await deviceErr(pinAction(t, admin.uid, session, c.now()), 'pin_session_invalid');
    const ended = await endPinSessionAction({ idToken: t.idToken, householdId: H, pinSessionId: session });
    assert.deepEqual(ended, { ok: true, data: { ended: false } });

    session = await open(admin.uid, '1357');
    await deviceErr(pinAction(t, admin.uid, session, new Date(c.now().getTime() + 121_000)), 'pin_session_invalid');

    // Re-pairing moves the generation: the old session is invalid with the new credential.
    session = await open(admin.uid, '1357');
    const { code } = await createDeviceRepairCode(owner, { householdId: H, deviceId: t.deviceId });
    const repaired = await redeemDeviceCode({ code, nonce: nonce() });
    const fresh = await signIn(repaired.customToken);
    await deviceErr(pinAction({ ...t, idToken: fresh.idToken }, admin.uid, session, c.now()), 'pin_session_invalid');
  });

  test('removal and leaving delete PIN documents: rejoining with the same uid has no PIN', async () => {
    await setMyPin(member2, { householdId: H, pin: '4826' });
    await setMyPin(child, { householdId: H, pin: '4826' });
    await removeMember(owner, H, member2.uid);
    assert.equal(await pinDoc(member2.uid), undefined);
    await leaveHousehold(child, H);
    assert.equal(await pinDoc(child.uid), undefined);
    assert.equal(await memberGuard(child.uid), undefined);
  });
});

describe('round 2: lock announcements, slow guessing, set limits, cleared guards', () => {
  test('a reserved attempt that reaches the person-wide limit but is right announces nothing (Codex A)', async () => {
    await setMyPin(member, { householdId: H, pin: '4826' });
    const tablets: Tablet[] = [];
    for (let i = 0; i < 5; i++) tablets.push(await pairTablet(H, owner, created, `Announce ${i}`));
    const c = clock(Date.parse('2026-12-01T09:00:00Z'));
    const auditBefore = (await house(H).collection('auditLogs').where('action', '==', 'pin.locked').get()).size;
    const noticesBefore = (await house(H).collection('notifications').where('sourceType', '==', 'pin-locked').get()).size;
    // 19 wrong (4 + 4 + 4 + 4 + 3), then the 20th attempt is the right PIN.
    let n = 0;
    for (const t of tablets) {
      for (let i = 0; i < 4 && n < 19; i++, n++) await deviceErr(verify(t, member.uid, '7391', c.advance(1000)), 'pin_wrong');
    }
    const result = await verify(tablets[4], member.uid, '4826', c.advance(1000));
    assert.ok(result.pinSessionId);
    assert.equal((await memberGuard(member.uid))?.lockedAt, null);
    assert.equal((await house(H).collection('auditLogs').where('action', '==', 'pin.locked').get()).size, auditBefore);
    assert.equal((await house(H).collection('notifications').where('sourceType', '==', 'pin-locked').get()).size, noticesBefore);
  });

  test('50 failures since the last correct PIN lock every tablet, reported with that reason (security review 1)', async () => {
    await setMyPin(member, { householdId: H, pin: '4826' });
    const t = await pairTablet(H, owner, created, 'Slow tablet');
    // 49 earlier failures since the last correct PIN, spread over days (none in the last hour).
    await house(H).collection('members').doc(member.uid).collection('private').doc('pinGuard').set({
      recentFailures: [], sinceSuccess: Array.from({ length: 49 }, (_, i) => ({ id: `old${i}`, seq: i + 1 })), seq: 49,
      lockedAt: null, lockedByAttempt: null, lockedReason: null,
    });
    const at = clock(Date.parse('2026-12-02T09:00:00Z')).now();
    await deviceErr(verify(t, member.uid, '7391', at), 'pin_locked_member');
    assert.equal((await memberGuard(member.uid))?.lockedReason, 'total');
    const entries = (await house(H).collection('auditLogs').where('action', '==', 'pin.locked').get()).docs
      .filter(d => d.get('details')?.reason === 'total' && d.get('targetUid') === member.uid);
    assert.equal(entries.length, 1);
    await clearPinLockout(admin, { householdId: H, targetUid: member.uid });
    assert.ok(await verify(t, member.uid, '4826', new Date(at.getTime() + 7000)));
  });

  test('clearing a lockout keeps each guard\'s sequence number (security review 4)', async () => {
    await setMyPin(member, { householdId: H, pin: '4826' });
    const t = await pairTablet(H, owner, created, 'Clear tablet');
    const at = clock(Date.parse('2026-12-03T09:00:00Z')).now();
    await deviceErr(verify(t, member.uid, '7391', at), 'pin_wrong');
    await deviceErr(verify(t, member.uid, '7391', new Date(at.getTime() + 7000)), 'pin_wrong');
    const guardRef = house(H).collection('devices').doc(t.deviceId).collection('pinGuards').doc(member.uid);
    const before = (await guardRef.get()).get('seq');
    const memberSeq = (await memberGuard(member.uid))?.seq;
    assert.equal(before, 2);
    await clearPinLockout(admin, { householdId: H, targetUid: member.uid });
    const after = (await guardRef.get()).data()!;
    assert.equal(after.seq, before);
    assert.equal(after.failures, 0);
    assert.equal((await memberGuard(member.uid))?.seq, memberSeq);
  });

  test('PIN sets are limited per person (security review 3)', async () => {
    const at = new Date('2026-12-04T09:00:00Z');
    for (let i = 0; i < 10; i++) await setMyPin(admin2, { householdId: H, pin: '2580' }, at);
    await pinErr(setMyPin(admin2, { householdId: H, pin: '2580' }, at), 'busy');
    await pinErr(setChildPin(admin2, { householdId: H, childId: KID, pin: '9314' }, at), 'busy');
    assert.ok(await setMyPin(admin2, { householdId: H, pin: '2580' }, new Date(at.getTime() + 61_000)));
  });
});

describe('hardening: daily count, repeat tablet locks, set admission, announcements', () => {
  test('30 failures within 24 hours lock the PIN even when correct PINs come in between (reason day)', async () => {
    await setMyPin(member, { householdId: H, pin: '4826' });
    const tablets: Tablet[] = [];
    for (let i = 0; i < 8; i++) tablets.push(await pairTablet(H, owner, created, `Daily ${i}`));
    const c = clock(Date.parse('2026-12-10T06:00:00Z'));
    let last: unknown;
    // 29 wrong spread over the day (under 20 an hour, 4 per tablet visit), a correct one after every 4.
    for (let i = 0; i < 29; i++) {
      const t = tablets[i % tablets.length];
      c.advance(20 * 60_000);
      last = await verify(t, member.uid, '7391', c.now()).catch(error => error);
      assert.equal((last as DeviceActionError).code, 'pin_wrong', `attempt ${i}`);
      if (i % 4 === 3) assert.ok(await verify(t, member.uid, '4826', c.advance(7000)));
    }
    c.advance(20 * 60_000);
    await deviceErr(verify(tablets[0], member.uid, '7391', c.now()), 'pin_locked_member');
    assert.equal((await memberGuard(member.uid))?.lockedReason, 'day');
    await deviceErr(verify(tablets[1], member.uid, '4826', c.advance(7000)), 'pin_locked_member');
  });

  test('owners and admins are told once when one person locks 3 tablets within 24 hours', async () => {
    await setMyPin(member, { householdId: H, pin: '4826' });
    const tablets: Tablet[] = [];
    for (let i = 0; i < 4; i++) tablets.push(await pairTablet(H, owner, created, `Repeat ${i}`));
    const c = clock(Date.parse('2026-12-11T06:00:00Z'));
    const notices = async () => (await house(H).collection('notifications').where('sourceType', '==', 'pin-tablet-locks').get()).docs
      .filter(d => d.get('sourceId') === member.uid);
    for (const [index, t] of tablets.entries()) {
      for (let i = 0; i < 4; i++) await deviceErr(verify(t, member.uid, '7391', c.advance(1000)), 'pin_wrong');
      await deviceErr(verify(t, member.uid, '7391', c.advance(1000)), 'pin_locked');
      // The person-wide hourly count would lock first; keep only it out of the way.
      await house(H).collection('members').doc(member.uid).collection('private').doc('pinGuard').update({ recentFailures: [] });
      const recipients = new Set((await notices()).map(d => d.get('targetUserUid')));
      if (index < 2) assert.equal(recipients.size, 0, `after ${index + 1} tablet locks`);
      else assert.ok(recipients.has(owner.uid) && recipients.has(admin.uid) && !recipients.has(member.uid));
    }
    // The 4th lock in the same day sends no second notice.
    assert.equal((await notices()).length, new Set((await notices()).map(d => d.get('targetUserUid'))).size);
  });

  test('concurrent fifth attempts: only a lock whose attempt proved wrong counts toward the repeated-lock notice', async () => {
    await setMyPin(member, { householdId: H, pin: '4826' });
    const tablets: Tablet[] = [];
    for (let i = 0; i < 3; i++) tablets.push(await pairTablet(H, owner, created, `Concurrent lock ${i}`));
    const c = clock(Date.parse('2026-12-13T06:00:00Z'));
    // Earlier tests in this file may have left such notices: count only new ones.
    const allNotices = async () => (await house(H).collection('notifications').where('sourceType', '==', 'pin-tablet-locks').get()).docs
      .filter(d => d.get('sourceId') === member.uid);
    const before = new Set((await allNotices()).map(d => d.id));
    const fresh = async () => (await allNotices()).filter(d => !before.has(d.id));
    const notices = async () => (await fresh()).length;
    const keepHourlyCountLow = () => house(H).collection('members').doc(member.uid).collection('private').doc('pinGuard').update({ recentFailures: [] });
    for (const t of tablets) {
      for (let i = 0; i < 4; i++) await deviceErr(verify(t, member.uid, '7391', c.advance(1000)), 'pin_wrong');
    }
    await keepHourlyCountLow();
    // Three fifth attempts at once: two are right, one is wrong and is announced first.
    let reached = 0;
    let bothReached!: () => void;
    const reservedBoth = new Promise<void>(resolve => { bothReached = resolve; });
    let wrongDone!: () => void;
    const announced = new Promise<void>(resolve => { wrongDone = resolve; });
    const at = c.advance(7000);
    const rightHooks = { afterCompare: async () => { reached += 1; if (reached === 2) bothReached(); await announced; } };
    const outcomes = await Promise.all([
      verify(tablets[0], member.uid, '4826', at, { testHooks: rightHooks }),
      verify(tablets[1], member.uid, '7391', at, { testHooks: { afterCompare: () => reservedBoth } })
        .catch(error => error).finally(() => wrongDone()),
      verify(tablets[2], member.uid, '4826', at, { testHooks: rightHooks }),
    ]);
    assert.ok((outcomes[0] as { pinSessionId?: string }).pinSessionId);
    assert.equal((outcomes[1] as DeviceActionError).code, 'pin_locked');
    assert.ok((outcomes[2] as { pinSessionId?: string }).pinSessionId);
    assert.equal(await notices(), 0, 'one confirmed lock is not three');
    assert.equal((await memberGuard(member.uid))?.repeatAlertAt, null);
    // Two genuine locks later the notice goes out once.
    for (const t of [tablets[0], tablets[2]]) {
      await keepHourlyCountLow();
      for (let i = 0; i < 4; i++) await deviceErr(verify(t, member.uid, '7391', c.advance(7000)), 'pin_wrong');
      await deviceErr(verify(t, member.uid, '7391', c.advance(7000)), 'pin_locked');
    }
    const recipients = new Set((await fresh()).map(d => d.get('targetUserUid')));
    assert.ok(recipients.has(owner.uid) && recipients.has(admin.uid));
  });

  test('three locks of the same tablet give no notice; locks on three different tablets give one', async () => {
    await setMyPin(member, { householdId: H, pin: '4826' });
    const tablets: Tablet[] = [];
    for (let i = 0; i < 3; i++) tablets.push(await pairTablet(H, owner, created, `Distinct ${i}`));
    const c = clock(Date.parse('2026-12-14T06:00:00Z'));
    const allNotices = async () => (await house(H).collection('notifications').where('sourceType', '==', 'pin-tablet-locks').get()).docs
      .filter(d => d.get('sourceId') === member.uid);
    const before = new Set((await allNotices()).map(d => d.id));
    const fresh = async () => (await allNotices()).filter(d => !before.has(d.id));
    const keepHourlyCountLow = () => house(H).collection('members').doc(member.uid).collection('private').doc('pinGuard').set({ recentFailures: [], dayFailures: [] }, { merge: true });
    const lock = async (t: Tablet) => {
      await keepHourlyCountLow();
      for (let i = 0; i < 4; i++) await deviceErr(verify(t, member.uid, '7391', c.advance(7000)), 'pin_wrong');
      await deviceErr(verify(t, member.uid, '7391', c.advance(7000)), 'pin_locked');
    };
    // The same tablet locks three times in a day (waiting out each lock).
    for (let round = 0; round < 3; round++) {
      await lock(tablets[0]);
      c.advance(20 * 60_000);
    }
    assert.equal((await fresh()).length, 0, 'one tablet is not three tablets');
    assert.equal((await memberGuard(member.uid))?.repeatAlertAt, null);
    // Two more tablets lock: three distinct tablets now, one notice.
    await lock(tablets[1]);
    assert.equal((await fresh()).length, 0);
    await lock(tablets[2]);
    const recipients = new Set((await fresh()).map(d => d.get('targetUserUid')));
    assert.ok(recipients.has(owner.uid) && recipients.has(admin.uid));
  });

  test('PIN sets beyond the admission bound are refused busy instead of queueing without limit', async () => {
    const people = Array.from({ length: 12 }, (_, i) => ({ uid: `p-setter-${i}`, email: `p.setter${i}@example.test` }));
    for (const person of people) {
      await house(H).collection('members').doc(person.uid).set({ uid: person.uid, role: 'member', status: 'active', displayName: 'Setter', permissions: {} });
    }
    const outcomes = await Promise.all(people.map(person => setMyPin(person, { householdId: H, pin: '2580' }).then(() => 'ok', (error: unknown) => (error as PinError).code)));
    assert.ok(outcomes.includes('busy'), JSON.stringify(outcomes));
    assert.ok(outcomes.every(code => code === 'ok' || code === 'busy'));
  });

  test('no lock announcement for a household being deleted; a failed announcement is retried once, then logged without names', async () => {
    await setMyPin(member, { householdId: H, pin: '4826' });
    const lockOnFifth = async (t: Tablet, at: number, hooks: VerifyPinTestHooks) => {
      for (let i = 0; i < 4; i++) await deviceErr(verify(t, member.uid, '7391', new Date(at + i * 1000)), 'pin_wrong');
      await deviceErr(verify(t, member.uid, '7391', new Date(at + 5000), { testHooks: hooks }), 'pin_locked');
    };
    const entriesFor = async (t: Tablet) => (await house(H).collection('auditLogs').where('action', '==', 'pin.device_locked').get()).docs
      .filter(d => d.get('deviceId') === t.deviceId).length;

    const deleting = await pairTablet(H, owner, created, 'Deleting tablet');
    await lockOnFifth(deleting, Date.parse('2026-12-12T06:00:00Z'), {
      afterCompare: async () => { await house(H).update({ deletingAt: FieldValue.serverTimestamp() }); },
    });
    await house(H).update({ deletingAt: FieldValue.delete() });
    assert.equal(await entriesFor(deleting), 0);

    const flaky = await pairTablet(H, owner, created, 'Flaky announce tablet');
    let throws = 1;
    await lockOnFifth(flaky, Date.parse('2026-12-12T07:00:00Z'), { duringAnnounce: () => { if (throws-- > 0) throw new Error('simulated'); } });
    assert.equal(await entriesFor(flaky), 1);

    const broken = await pairTablet(H, owner, created, 'Broken announce tablet');
    const errors = mock.method(console, 'error', () => undefined);
    try {
      await lockOnFifth(broken, Date.parse('2026-12-12T08:00:00Z'), { duringAnnounce: () => { throw new Error('simulated'); } });
    } finally {
      errors.mock.restore();
    }
    assert.equal(await entriesFor(broken), 0);
    const logged = errors.mock.calls.map(call => String(call.arguments[0])).find(line => line.includes('pin_lock_announcement_failed'));
    assert.ok(logged);
    const parsed = JSON.parse(logged!);
    assert.equal(parsed.deviceId, broken.deviceId);
    assert.ok(!logged!.includes('Max') && !logged!.includes(member.uid));
  });
});

describe('sessions never outlive a membership (Codex P2: PIN identity reuse)', () => {
  const rejoin = (person: Person) => house(H).collection('members').doc(person.uid).set({
    uid: person.uid, role: person.role, status: 'active', displayName: person.displayName, permissions: {},
  });
  const feed = (t: Tablet, actorUid: string, pinSessionId: string, at: Date) =>
    authorize({ idToken: t.idToken, householdId: H, capability: 'pets.feed', actorUid, pinSessionId, opId: opId() }, at);

  for (const how of ['leave', 'remove'] as const) {
    test(`${how}, rejoin with the same role and set a new PIN: the old session is refused and gone`, async () => {
      const person = how === 'leave' ? member : member2;
      await rejoin(person);
      await setMyPin(person, { householdId: H, pin: '4826' });
      const t = await pairTablet(H, owner, created, `Rejoin ${how} tablet`);
      const c = clock(Date.parse(how === 'leave' ? '2026-11-29T09:00:00Z' : '2026-11-29T10:00:00Z'));
      const old = (await verify(t, person.uid, '4826', c.now())).pinSessionId;
      assert.equal((await feed(t, person.uid, old, c.now())).level, 'pin');
      await deviceErr(verify(t, person.uid, '7391', c.advance(7000)), 'pin_wrong');
      if (how === 'leave') await leaveHousehold(person, H);
      else await removeMember(owner, H, person.uid);
      // Their sessions and lockout state on every tablet are gone with the membership.
      assert.equal((await sessionsOf(H, t.deviceId)).filter(d => d.get('memberUid') === person.uid).length, 0);
      assert.equal((await house(H).collection('devices').doc(t.deviceId).collection('pinGuards').doc(person.uid).get()).exists, false);
      await rejoin(person);
      await setMyPin(person, { householdId: H, pin: '4826' });
      assert.equal((await pinDoc(person.uid))?.pinVersion, 1);
      await deviceErr(feed(t, person.uid, old, c.advance(1000)), 'pin_session_invalid');
    });
  }

  test('a session from before the PIN document was recreated is refused even if its record survived', async () => {
    await setMyPin(member, { householdId: H, pin: '4826' });
    const t = await pairTablet(H, owner, created, 'Recreated tablet');
    const at = clock(Date.parse('2026-11-29T11:00:00Z')).now();
    const old = (await verify(t, member.uid, '4826', at)).pinSessionId;
    // The PIN document vanishes and is recreated at the same pinVersion (as after a rejoin).
    await house(H).collection('members').doc(member.uid).collection('private').doc('pin').delete();
    await setMyPin(member, { householdId: H, pin: '4826' });
    assert.equal((await pinDoc(member.uid))?.pinVersion, 1);
    await deviceErr(feed(t, member.uid, old, at), 'pin_session_invalid');
  });
});

describe('verification budget (Codex P2: pre-auth limiter)', () => {
  test('forged tokens naming a real tablet never spend its PIN budget; its own verify still succeeds', async () => {
    await setMyPin(member, { householdId: H, pin: '4826' });
    const victim = await pairTablet(H, owner, created, 'PIN victim tablet');
    const forged = `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from(JSON.stringify({ hh_device: victim.deviceId, hh_household: H, hh_kind: 'device', hh_gen: 1 })).toString('base64url')}.x`;
    const at = clock(Date.parse('2026-11-30T09:00:00Z')).now();
    for (let i = 0; i < 15; i++) {
      await deviceErr(verifyDevicePin({ idToken: forged, householdId: H, actorUid: member.uid, pin: '4826' }, { now: at, clientAddress: '203.0.113.9' }), 'unauthenticated');
    }
    const result = await verifyDevicePin({ idToken: victim.idToken, householdId: H, actorUid: member.uid, pin: '4826' }, { now: at, clientAddress: '198.51.100.7' });
    assert.ok(result.pinSessionId);
  });
});

/** Clears only the member-wide guard (keeps a tablet's own lockout schedule). */
async function clearPinLockoutMemberOnly(uid: string) {
  await house(H).collection('members').doc(uid).collection('private').doc('pinGuard').delete();
}
