import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { adminDb } from '../../src/lib/server/firebase-admin';
import { DeviceActionError } from '../../src/lib/server/device-gate';
import { exitTablet, updateDeviceSettingsFromTablet } from '../../src/lib/server/device-tablet';
import { createDeviceRepairCode, redeemDeviceCode, recordDeviceHeartbeat } from '../../src/lib/server/device-management';
import { setMyPin, verifyDevicePin } from '../../src/lib/server/pins';
import { QuietHoursError, updateQuietHours } from '../../src/lib/server/quiet-hours';
import { transferOwnership } from '../../src/lib/server/household-membership';
import { exitTabletAction, updateDeviceSettingsFromTabletAction } from '../../src/app/devices/actions';
import { updateQuietHoursAction } from '../../src/app/household/quiet-hours-actions';
import { deleteDeviceUsers, nonce, personToken, seedHousehold, signIn, userState, type Person } from './device-test-helpers';
import { clock, house, pairTablet, type Tablet } from './device-actor-helpers';


/** A clock fixed at `at` (the gate reads it at authorization and again at every precheck). */
const fixedClock = (at: Date) => ({ clock: () => at });

// F3 server actions (docs/modules/devices/README.md, "Protected exit and Tablet
// settings", "Night dimming"): tablet settings and the three protected exits behind a
// fresh owner/admin PIN (WT-16, D-T5, S9), and household quiet hours (D-T1, JC-20).

const H = 'tablet-house';
const HB = 'tablet-house-b';
const owner: Person = { uid: 't-owner', email: 't.owner@example.test', displayName: 'Olive', role: 'owner' };
const admin: Person = { uid: 't-admin', email: 't.admin@example.test', displayName: 'Ada', role: 'admin' };
const member: Person = { uid: 't-member', email: 't.member@example.test', displayName: 'Max', role: 'member' };
const ownerB: Person = { uid: 't-owner-b', email: 't.ownerb@example.test', displayName: 'Bea', role: 'owner' };
const PIN = { owner: '2580', admin: '1357', member: '4826' };
const created = new Set<string>();
const time = clock(Date.parse('2026-11-14T15:00:00Z'));

const refused = async (promise: Promise<unknown>, code: string) => {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof DeviceActionError, `expected DeviceActionError(${code}), got ${String(error)}`);
    assert.equal(error.code, code);
    return true;
  });
};

/** A fresh PIN session on the tablet (each call a minute later, under the rate windows). */
const unlock = async (tablet: Tablet, actorUid: string, pin: string) => {
  const at = time.advance(60_000);
  return { at, session: (await verifyDevicePin({ idToken: tablet.idToken, householdId: H, actorUid, pin }, { now: at })).pinSessionId };
};

const record = async (deviceId: string) => (await house(H).collection('devices').doc(deviceId).get()).data() ?? {};
const audits = async (action: string) => (await house(H).collection('auditLogs').where('action', '==', action).get()).docs.map(d => d.data());

before(async () => {
  await seedHousehold(H, [owner, admin, member]);
  await seedHousehold(HB, [ownerB]);
  await setMyPin(owner, { householdId: H, pin: PIN.owner });
  await setMyPin(admin, { householdId: H, pin: PIN.admin });
  await setMyPin(member, { householdId: H, pin: PIN.member });
});

after(async () => {
  await deleteDeviceUsers([...created]);
  for (const id of [H, HB]) {
    await adminDb.recursiveDelete(house(id));
    const codes = await adminDb.collection('deviceCodes').where('householdId', '==', id).get();
    await Promise.all(codes.docs.map(d => d.ref.delete()));
  }
});

describe('tablet settings behind a fresh owner/admin PIN (WT-16e, S9)', () => {
  let tablet: Tablet;
  before(async () => { tablet = await pairTablet(H, owner, created); });

  test('an owner with a fresh PIN changes room, name, sections and start page; logged as a tablet PIN action', async () => {
    const { at, session } = await unlock(tablet, owner.uid, PIN.owner);
    const result = await updateDeviceSettingsFromTablet({
      idToken: tablet.idToken, householdId: H, actorUid: owner.uid, pinSessionId: session,
      patch: { room: 'Hallway', name: 'Hall tablet', sections: { shopping: false }, startPage: { kind: 'pets' } },
    }, { clock: () => new Date(at.getTime() + 5_000) });
    assert.deepEqual(result.changed.sort(), ['name', 'room', 'sections', 'startPage']);
    const stored = await record(tablet.deviceId);
    assert.equal(stored.room, 'Hallway');
    assert.equal(stored.sections.shopping, false);
    assert.deepEqual(stored.startPage, { kind: 'pets' });
    assert.equal(stored.updatedVia, 'tablet-admin-pin');
    assert.equal(stored.updatedByUid, owner.uid);
    const entry = (await audits('device.settings_changed')).find(a => a.via === 'device');
    assert.ok(entry, 'activity entry written');
    assert.equal(entry!.actorUid, owner.uid);
    assert.equal(entry!.level, 'pin');
    assert.equal(entry!.deviceId, tablet.deviceId);
    assert.equal(JSON.stringify(entry).includes(session), false, 'no session id in the activity log');
  });

  test('an admin works too; a member\'s PIN is never enough', async () => {
    const adminUnlock = await unlock(tablet, admin.uid, PIN.admin);
    await updateDeviceSettingsFromTablet({ idToken: tablet.idToken, householdId: H, actorUid: admin.uid, pinSessionId: adminUnlock.session, patch: { room: 'Kitchen' } }, { clock: () => adminUnlock.at });
    assert.equal((await record(tablet.deviceId)).room, 'Kitchen');
    const memberUnlock = await unlock(tablet, member.uid, PIN.member);
    await refused(updateDeviceSettingsFromTablet({ idToken: tablet.idToken, householdId: H, actorUid: member.uid, pinSessionId: memberUnlock.session, patch: { room: 'Den' } }, { clock: () => memberUnlock.at }), 'admin_pin_required');
  });

  test('without a session, with an old session, or with another person\'s session it is refused', async () => {
    await refused(updateDeviceSettingsFromTablet({ idToken: tablet.idToken, householdId: H, actorUid: owner.uid, pinSessionId: '', patch: { room: 'Den' } }, fixedClock(time.advance(60_000))), 'pin_required');
    const { at, session } = await unlock(tablet, owner.uid, PIN.owner);
    await refused(updateDeviceSettingsFromTablet({ idToken: tablet.idToken, householdId: H, actorUid: owner.uid, pinSessionId: session, patch: { room: 'Den' } }, { clock: () => new Date(at.getTime() + 31_000) }), 'pin_fresh_required');
    await refused(updateDeviceSettingsFromTablet({ idToken: tablet.idToken, householdId: H, actorUid: admin.uid, pinSessionId: session, patch: { room: 'Den' } }, { clock: () => at }), 'pin_session_invalid');
    assert.equal((await record(tablet.deviceId)).room, 'Kitchen');
  });

  test('an invalid patch, a start page in a switched-off section, and a forged updatedVia are refused', async () => {
    const { at, session } = await unlock(tablet, owner.uid, PIN.owner);
    const call = (patch: Record<string, unknown>) => updateDeviceSettingsFromTablet({ idToken: tablet.idToken, householdId: H, actorUid: owner.uid, pinSessionId: session, patch }, { clock: () => at });
    await refused(call({ room: '' }), 'invalid_input');
    await refused(call({ startPage: { kind: 'shopping' } }), 'invalid_input');
    await refused(call({ updatedVia: 'devices-list' }), 'invalid_input');
    await refused(call({ status: 'removed' }), 'invalid_input');
  });

  test('the action maps refusals to codes and never returns PIN material', async () => {
    const result = await updateDeviceSettingsFromTabletAction({ idToken: tablet.idToken, householdId: H, actorUid: owner.uid, pinSessionId: 'x', patch: { room: 'Den' } });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, 'pin_session_invalid');
  });

  test('a personal token is refused', async () => {
    const personal = await personToken(owner);
    await refused(updateDeviceSettingsFromTablet({ idToken: personal, householdId: H, actorUid: owner.uid, pinSessionId: 'x', patch: { room: 'Den' } }, fixedClock(time.advance(60_000))), 'not_a_device');
  });
});

describe('the protected exits (WT-16a-c, WT-16f, D-T5)', () => {
  test('"Remove this tablet": removed for good, credential deleted, owners and admins notified, logged', async () => {
    const tablet = await pairTablet(H, owner, created, 'Remove me');
    const before = (await record(tablet.deviceId)).generation as number;
    const { at, session } = await unlock(tablet, admin.uid, PIN.admin);
    const result = await exitTablet({ idToken: tablet.idToken, householdId: H, actorUid: admin.uid, pinSessionId: session, exit: 'remove' }, { clock: () => at });
    assert.deepEqual(result, { status: 'removed', authCleanup: 'done' });
    const stored = await record(tablet.deviceId);
    assert.equal(stored.status, 'removed');
    assert.equal(stored.generation, before + 1);
    assert.equal(stored.endedReason, 'removed');
    assert.equal(stored.removedByUid, admin.uid);
    assert.equal(await userState(`device_${tablet.deviceId}`), 'missing');
    const notices = await house(H).collection('notifications').where('sourceType', '==', 'device-removed').where('sourceId', '==', tablet.deviceId).get();
    assert.deepEqual(notices.docs.map(d => d.get('targetUserUid')).sort(), [admin.uid, owner.uid].sort());
    assert.ok(notices.docs.every(d => d.get('category') === 'system' && d.get('title') === 'Wall tablet removed'));
    const entry = (await audits('device.removed')).find(a => a.deviceId === tablet.deviceId);
    assert.equal(entry?.via, 'device');
    assert.equal(entry?.actorUid, admin.uid);
    // The old credential is refused at once.
    await assert.rejects(recordDeviceHeartbeat({ idToken: tablet.idToken, householdId: H, appVersion: 'x' }, time.advance(60_000)));
  });

  test('"Sign in with a personal account": unpaired, record kept, credential disabled, needs a re-pair', async () => {
    const tablet = await pairTablet(H, owner, created, 'Personal');
    const { at, session } = await unlock(tablet, owner.uid, PIN.owner);
    const result = await exitTablet({ idToken: tablet.idToken, householdId: H, actorUid: owner.uid, pinSessionId: session, exit: 'personal-sign-in' }, { clock: () => at });
    assert.equal(result.status, 'unpaired');
    const stored = await record(tablet.deviceId);
    assert.equal(stored.status, 'unpaired');
    assert.equal(stored.endedReason, 'personal-sign-in');
    assert.equal(stored.name, 'Personal', 'settings kept');
    assert.equal(await userState(`device_${tablet.deviceId}`), 'disabled');
    const entry = (await audits('device.exited')).find(a => a.deviceId === tablet.deviceId);
    assert.equal(entry?.details?.reason, 'personal-sign-in');
    // A re-pair of the same record works and keeps the settings.
    const { code } = await createDeviceRepairCode(owner, { householdId: H, deviceId: tablet.deviceId });
    const again = await redeemDeviceCode({ code, nonce: nonce() });
    assert.equal(again.deviceId, tablet.deviceId);
    assert.equal((await record(tablet.deviceId)).status, 'active');
    await signIn(again.customToken);
  });

  test('"Use a different code": unpaired with its own reason; the tablet\'s unused re-pair code is cancelled', async () => {
    const tablet = await pairTablet(H, owner, created, 'New code');
    const repair = await createDeviceRepairCode(owner, { householdId: H, deviceId: tablet.deviceId });
    // The real clock: the code's 15 minutes count from when Firestore stored it.
    const at = new Date();
    const session = (await verifyDevicePin({ idToken: tablet.idToken, householdId: H, actorUid: owner.uid, pin: PIN.owner }, { now: at })).pinSessionId;
    await exitTablet({ idToken: tablet.idToken, householdId: H, actorUid: owner.uid, pinSessionId: session, exit: 'new-code' }, { clock: () => at });
    const stored = await record(tablet.deviceId);
    assert.equal(stored.status, 'unpaired');
    assert.equal(stored.endedReason, 'new-code');
    assert.equal((await adminDb.collection('deviceCodes').doc(repair.code).get()).get('revokedReason'), 'superseded');
  });

  test('every exit needs a fresh owner/admin PIN', async () => {
    const tablet = await pairTablet(H, owner, created, 'Guarded');
    const memberUnlock = await unlock(tablet, member.uid, PIN.member);
    for (const exit of ['remove', 'personal-sign-in', 'new-code'] as const) {
      await refused(exitTablet({ idToken: tablet.idToken, householdId: H, actorUid: member.uid, pinSessionId: memberUnlock.session, exit }, { clock: () => memberUnlock.at }), 'admin_pin_required');
      await refused(exitTablet({ idToken: tablet.idToken, householdId: H, actorUid: owner.uid, exit, pinSessionId: '' }, { clock: () => memberUnlock.at }), 'pin_required');
    }
    const { at, session } = await unlock(tablet, owner.uid, PIN.owner);
    await refused(exitTablet({ idToken: tablet.idToken, householdId: H, actorUid: owner.uid, pinSessionId: session, exit: 'remove' }, { clock: () => new Date(at.getTime() + 31_000) }), 'pin_fresh_required');
    await refused(exitTablet({ idToken: tablet.idToken, householdId: H, actorUid: owner.uid, pinSessionId: session, exit: 'somewhere' }, { clock: () => at }), 'invalid_input');
    assert.equal((await record(tablet.deviceId)).status, 'active');
    const viaAction = await exitTabletAction({ idToken: tablet.idToken, householdId: H, actorUid: owner.uid, pinSessionId: 'nope', exit: 'remove' });
    assert.equal(viaAction.ok, false);
  });

  test('two exits racing: one wins, the other is refused (the generation moved on)', async () => {
    const tablet = await pairTablet(H, owner, created, 'Race');
    const a = await unlock(tablet, owner.uid, PIN.owner);
    // Both sessions fresh (at most 30 s old) when the exits race.
    const bAt = new Date(a.at.getTime() + 1_000);
    const b = { at: bAt, session: (await verifyDevicePin({ idToken: tablet.idToken, householdId: H, actorUid: admin.uid, pin: PIN.admin }, { now: bAt })).pinSessionId };
    const results = await Promise.allSettled([
      exitTablet({ idToken: tablet.idToken, householdId: H, actorUid: owner.uid, pinSessionId: a.session, exit: 'remove' }, { clock: () => b.at }),
      exitTablet({ idToken: tablet.idToken, householdId: H, actorUid: admin.uid, pinSessionId: b.session, exit: 'new-code' }, { clock: () => b.at }),
    ]);
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
    const loser = results.find(r => r.status === 'rejected') as PromiseRejectedResult;
    assert.ok(loser.reason instanceof DeviceActionError);
    assert.ok(['device_revoked', 'pin_session_invalid'].includes(loser.reason.code), loser.reason.code);
    const stored = await record(tablet.deviceId);
    const audit = (await adminDb.collection('households').doc(H).collection('auditLogs').where('deviceId', '==', tablet.deviceId).get()).docs
      .filter(d => d.get('action') === 'device.removed' || d.get('action') === 'device.exited');
    assert.equal(audit.length, 1, 'exactly one exit logged');
    assert.ok(stored.status === 'removed' || stored.status === 'unpaired');
  });
});

describe('household quiet hours (D-T1, JC-20)', () => {
  test('owners and admins set and clear them; logged; unchanged is a no-op', async () => {
    const set = await updateQuietHours(owner, { householdId: H, quietHours: { start: '22:00', end: '07:00' } });
    assert.deepEqual(set, { quietHours: { start: '22:00', end: '07:00' }, changed: true });
    const stored = (await house(H).get()).get('quietHours');
    assert.equal(stored.start, '22:00');
    assert.equal(stored.end, '07:00');
    assert.equal(stored.updatedByUid, owner.uid);
    assert.equal((await updateQuietHours(admin, { householdId: H, quietHours: { start: '22:00', end: '07:00' } })).changed, false);
    await updateQuietHours(admin, { householdId: H, quietHours: { start: '21:30', end: '06:45' } });
    assert.equal((await house(H).get()).get('quietHours').start, '21:30');
    await updateQuietHours(admin, { householdId: H, quietHours: null });
    assert.equal((await house(H).get()).get('quietHours'), null);
    const logged = await audits('device.quiet_hours_changed');
    assert.ok(logged.length >= 3);
    assert.ok(logged.some(entry => entry.details?.quietHours === '22:00 to 07:00'));
  });

  test('members, other households, bad times and a deleting household are refused', async () => {
    const refusedQuiet = (promise: Promise<unknown>, code: string) => assert.rejects(promise, (error: unknown) => error instanceof QuietHoursError && error.code === code);
    await refusedQuiet(updateQuietHours(member, { householdId: H, quietHours: { start: '22:00', end: '07:00' } }), 'forbidden');
    await refusedQuiet(updateQuietHours(ownerB, { householdId: H, quietHours: { start: '22:00', end: '07:00' } }), 'not_member');
    await refusedQuiet(updateQuietHours(owner, { householdId: H, quietHours: { start: '22:00', end: '22:00' } }), 'invalid_input');
    await refusedQuiet(updateQuietHours(owner, { householdId: H, quietHours: { start: '25:00', end: '07:00' } }), 'invalid_input');
    await refusedQuiet(updateQuietHours(owner, { householdId: H, quietHours: { start: '22:00', end: '07:00', extra: true } }), 'invalid_input');
    await refusedQuiet(updateQuietHours(owner, { householdId: 'a/b', quietHours: null }), 'not_found');
    await house(HB).update({ deletingAt: new Date() });
    await refusedQuiet(updateQuietHours(ownerB, { householdId: HB, quietHours: null }), 'household_deleting');
  });

  test('the action authenticates a person; a tablet token is refused; the flag off refuses', async () => {
    const tablet = await pairTablet(H, owner, created, 'Quiet');
    const viaTablet = await updateQuietHoursAction({ idToken: tablet.idToken, householdId: H, quietHours: null });
    assert.equal(viaTablet.ok, false);
    if (!viaTablet.ok) assert.equal(viaTablet.code, 'unauthenticated');
    const viaOwner = await updateQuietHoursAction({ idToken: await personToken(owner), householdId: H, quietHours: { start: '23:00', end: '06:00' } });
    assert.equal(viaOwner.ok, true);
    process.env.HOMEHUB_DEVICES_ENABLED = 'false';
    try {
      await assert.rejects(updateQuietHours(owner, { householdId: H, quietHours: null }), (error: unknown) => error instanceof QuietHoursError && error.code === 'unavailable');
    } finally {
      process.env.HOMEHUB_DEVICES_ENABLED = 'true';
    }
  });
});

describe('household-wide notices carry no email (review 6)', () => {
  test('the ownership-transfer notice uses the public name, never an email-valued display name', async () => {
    const HT = 'tablet-house-transfer';
    const emailNamed: Person = { uid: 't-email-named', email: 't.email@example.test', displayName: 't.email@example.test', role: 'member' };
    await seedHousehold(HT, [owner, emailNamed]);
    try {
      await transferOwnership(owner, HT, emailNamed.uid);
      const notices = await house(HT).collection('notifications').where('sourceType', '==', 'household-ownership-transfer').get();
      assert.equal(notices.size, 1);
      const message = String(notices.docs[0].get('message'));
      assert.equal(message.includes('@'), false, message);
      assert.match(message, /^A member is now the owner of /);
    } finally {
      await adminDb.recursiveDelete(house(HT));
    }
  });
});
