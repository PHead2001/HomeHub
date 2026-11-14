import assert from 'node:assert/strict';
import { after, beforeEach, describe, test } from 'node:test';
import { Timestamp } from 'firebase-admin/firestore';
import { doc, getDocFromServer } from 'firebase/firestore';
import { adminAuth, adminDb } from '../../src/lib/server/firebase-admin';
import { deleteHousehold } from '../../src/lib/server/household-membership';
import { finishDeviceRevocation, mintDeviceCredential } from '../../src/lib/server/device-identity';
import {
  createDeviceCode,
  createDeviceRepairCode,
  reconcileDeviceSessions,
  recordDeviceHeartbeat,
  redeemDeviceCode,
  removeDevice,
  updateDeviceSettings,
} from '../../src/lib/server/device-management';
import { updateDeviceSettingsAction } from '../../src/app/household/device-actions';
import { DEVICE_SWEEP_UTC_HOUR, sweepDeviceRevocations } from '../../functions/src/reminders';
import {
  clientSession,
  deleteDeviceUsers,
  nonce,
  oldCredentialRefused,
  tokensValidAfter,
  personToken,
  refresh,
  refusedWith,
  seedHousehold,
  signIn,
  userState,
  type Person,
} from './device-test-helpers';

// Device records (docs/modules/devices/README.md, 4): settings edits (validation,
// start page vs sections, field-level concurrency, removed records), the heartbeat,
// removal (status, generation, activity, notifications, Auth user deleted), unpaired
// records and re-pairing them, the daily sweep, and household deletion revoking every
// tablet before any data is deleted.

const H = 'device-mgmt-house';
const owner: Person = { uid: 'dm-owner', email: 'dm.owner@example.test', displayName: 'Olive', role: 'owner' };
const admin: Person = { uid: 'dm-admin', email: 'dm.admin@example.test', displayName: 'Ada', role: 'admin' };
const member: Person = { uid: 'dm-member', email: 'dm.member@example.test', displayName: 'Max', role: 'member' };
const created = new Set<string>();
const BUILD = '20261113T120000000Z';

const house = () => adminDb.collection('households').doc(H);
const record = (deviceId: string) => house().collection('devices').doc(deviceId);

const pair = async (name = 'Kitchen tablet') => {
  const { code } = await createDeviceCode(owner, { householdId: H, name, room: 'Kitchen' });
  const paired = await redeemDeviceCode({ code, nonce: nonce() });
  created.add(paired.deviceId);
  return { ...paired, session: await signIn(paired.customToken) };
};

beforeEach(async () => {
  await seedHousehold(H, [owner, admin, member]);
});

after(async () => {
  await deleteDeviceUsers([...created]);
  await adminDb.recursiveDelete(house());
  const codes = await adminDb.collection('deviceCodes').where('householdId', '==', H).get();
  await Promise.all(codes.docs.map(d => d.ref.delete()));
});

describe('settings edits', () => {
  test('owners and admins edit; members and device tokens cannot', async () => {
    const tablet = await pair();
    const result = await updateDeviceSettings(admin, { householdId: H, deviceId: tablet.deviceId, patch: { name: 'Hall tablet', room: 'Hall' } });
    assert.deepEqual(result.changed.sort(), ['name', 'room']);
    const stored = (await record(tablet.deviceId).get()).data()!;
    assert.equal(stored.name, 'Hall tablet');
    assert.equal(stored.updatedByUid, admin.uid);
    assert.equal(stored.updatedVia, 'devices-list');
    await refusedWith(updateDeviceSettings(member, { householdId: H, deviceId: tablet.deviceId, patch: { name: 'Mine' } }), 'forbidden');
    const viaDevice = await updateDeviceSettingsAction({ idToken: tablet.session.idToken, householdId: H, deviceId: tablet.deviceId, patch: { name: 'Mine' } });
    assert.equal(viaDevice.ok ? 'ok' : viaDevice.code, 'unauthenticated');
    assert.equal((await record(tablet.deviceId).get()).get('name'), 'Hall tablet');
  });

  test('validation refuses bad fields and writes nothing', async () => {
    const tablet = await pair();
    const before = (await record(tablet.deviceId).get()).updateTime;
    await refusedWith(updateDeviceSettings(owner, { householdId: H, deviceId: tablet.deviceId, patch: { status: 'removed' } }), 'invalid_input');
    await refusedWith(updateDeviceSettings(owner, { householdId: H, deviceId: tablet.deviceId, patch: { generation: 5 } }), 'invalid_input');
    await refusedWith(updateDeviceSettings(owner, { householdId: H, deviceId: tablet.deviceId, patch: { idle: { homeAfterSec: 5 } } }), 'invalid_input');
    await refusedWith(updateDeviceSettings(owner, { householdId: H, deviceId: 'not-a-device-id', patch: { name: 'x' } }), 'not_found');
    assert.ok((await record(tablet.deviceId).get()).updateTime?.isEqual(before!));
  });

  test('start page and sections: a start page in an off section is refused; switching its section off resets it to Home', async () => {
    const tablet = await pair();
    await updateDeviceSettings(owner, { householdId: H, deviceId: tablet.deviceId, patch: { startPage: { kind: 'shopping-list', listId: 'groceries' } } });
    await updateDeviceSettings(owner, { householdId: H, deviceId: tablet.deviceId, patch: { sections: { shopping: false } } });
    let stored = (await record(tablet.deviceId).get()).data()!;
    assert.equal(stored.sections.shopping, false);
    assert.deepEqual(stored.startPage, { kind: 'home' });
    await refusedWith(updateDeviceSettings(owner, { householdId: H, deviceId: tablet.deviceId, patch: { startPage: { kind: 'shopping' } } }), 'start_page_section_off');
    await updateDeviceSettings(owner, { householdId: H, deviceId: tablet.deviceId, patch: { sections: { shopping: true }, startPage: { kind: 'shopping' } } });
    stored = (await record(tablet.deviceId).get()).data()!;
    assert.deepEqual(stored.startPage, { kind: 'shopping' });
  });

  test('two admins editing different fields at once both keep their change', async () => {
    const tablet = await pair();
    await Promise.all([
      updateDeviceSettings(owner, { householdId: H, deviceId: tablet.deviceId, patch: { name: 'Fridge tablet' } }),
      updateDeviceSettings(admin, { householdId: H, deviceId: tablet.deviceId, patch: { comfort: { textScale: 130 }, display: { weather: true, weatherPlace: 'Austin' } } }),
      updateDeviceSettings(admin, { householdId: H, deviceId: tablet.deviceId, patch: { sections: { pets: false } } }),
    ]);
    const stored = (await record(tablet.deviceId).get()).data()!;
    assert.equal(stored.name, 'Fridge tablet');
    assert.equal(stored.comfort.textScale, 130);
    assert.equal(stored.display.weatherPlace, 'Austin');
    assert.equal(stored.sections.pets, false);
    assert.equal(stored.sections.chores, true);
  });

  test('admin-field edits are logged with the field names; comfort-only edits are not', async () => {
    const tablet = await pair();
    await updateDeviceSettings(owner, { householdId: H, deviceId: tablet.deviceId, patch: { comfort: { theme: 'dark' } } });
    await updateDeviceSettings(owner, { householdId: H, deviceId: tablet.deviceId, patch: { camera: 'rear', comfort: { sound: false } } });
    const audit = await house().collection('auditLogs').where('action', '==', 'device.settings_changed').get();
    assert.equal(audit.size, 1);
    assert.equal(audit.docs[0].get('details').fields, 'camera');
    assert.equal(audit.docs[0].get('deviceId'), tablet.deviceId);
  });

  test('removed and unpaired records refuse every edit', async () => {
    const tablet = await pair();
    await record(tablet.deviceId).update({ status: 'unpaired' });
    await refusedWith(updateDeviceSettings(owner, { householdId: H, deviceId: tablet.deviceId, patch: { name: 'x' } }), 'device_not_active');
    await record(tablet.deviceId).update({ status: 'removed' });
    await refusedWith(updateDeviceSettings(owner, { householdId: H, deviceId: tablet.deviceId, patch: { name: 'x' } }), 'device_not_active');
  });
});

describe('heartbeat', () => {
  test('stores the server time and the build; skips a write within 60 s unless the version changed', async () => {
    const tablet = await pair();
    const t0 = new Date(Date.now() + 3_600_000);
    assert.deepEqual(await recordDeviceHeartbeat({ idToken: tablet.session.idToken, householdId: H, appVersion: BUILD }, t0), { written: true });
    let stored = (await record(tablet.deviceId).get()).data()!;
    assert.equal((stored.lastSeenAt as Timestamp).toMillis(), t0.getTime());
    assert.equal(stored.appVersion, BUILD);
    assert.deepEqual(await recordDeviceHeartbeat({ idToken: tablet.session.idToken, householdId: H, appVersion: BUILD }, new Date(t0.getTime() + 30_000)), { written: false });
    assert.deepEqual(await recordDeviceHeartbeat({ idToken: tablet.session.idToken, householdId: H, appVersion: '20261114T000000000Z' }, new Date(t0.getTime() + 31_000)), { written: true });
    assert.deepEqual(await recordDeviceHeartbeat({ idToken: tablet.session.idToken, householdId: H, appVersion: '<script>' }, new Date(t0.getTime() + 95_000)), { written: true });
    stored = (await record(tablet.deviceId).get()).data()!;
    assert.equal(stored.appVersion, 'unknown');
  });

  test('at most 6 a minute per tablet', async () => {
    const tablet = await pair();
    const t0 = new Date(Date.now() + 7_200_000);
    for (let index = 0; index < 6; index += 1) {
      await recordDeviceHeartbeat({ idToken: tablet.session.idToken, householdId: H, appVersion: BUILD }, new Date(t0.getTime() + index));
    }
    await refusedWith(recordDeviceHeartbeat({ idToken: tablet.session.idToken, householdId: H, appVersion: BUILD }, new Date(t0.getTime() + 10)), 'rate_limited');
  });

  test('refused for a personal token, another household, a removed tablet or an old generation', async () => {
    const tablet = await pair();
    await refusedWith(recordDeviceHeartbeat({ idToken: await personToken(owner), householdId: H, appVersion: BUILD }), 'unauthenticated');
    await refusedWith(recordDeviceHeartbeat({ idToken: tablet.session.idToken, householdId: 'other-house', appVersion: BUILD }), 'unauthenticated');
    await record(tablet.deviceId).update({ generation: 2 });
    await refusedWith(recordDeviceHeartbeat({ idToken: tablet.session.idToken, householdId: H, appVersion: BUILD }), 'device_revoked');
  });
});

describe('removal', () => {
  test('one transaction: removed, generation bumped, activity, one notice per owner and admin; then the Auth user is deleted', async () => {
    const tablet = await pair('Hall tablet');
    const repair = await createDeviceRepairCode(owner, { householdId: H, deviceId: tablet.deviceId });
    const result = await removeDevice(admin, { householdId: H, deviceId: tablet.deviceId });
    assert.deepEqual(result, { authCleanup: 'done', alreadyRemoved: false });
    const stored = (await record(tablet.deviceId).get()).data()!;
    assert.equal(stored.status, 'removed');
    assert.equal(stored.generation, 2);
    assert.equal(stored.endedReason, 'removed');
    assert.equal(stored.removedByUid, admin.uid);
    assert.equal(stored.name, 'Hall tablet', 'the record stays for history');
    assert.equal((await adminDb.collection('deviceCodes').doc(repair.code).get()).get('revokedReason'), 'superseded');
    const audit = await house().collection('auditLogs').where('action', '==', 'device.removed').get();
    assert.equal(audit.size, 1);
    assert.equal(audit.docs[0].get('actorUid'), admin.uid);
    const notices = await house().collection('notifications').where('sourceType', '==', 'device-removed').get();
    assert.deepEqual(notices.docs.map(d => d.get('targetUserUid')).sort(), [admin.uid, owner.uid].sort());
    for (const notice of notices.docs) {
      assert.deepEqual(notice.get('audience'), [notice.get('targetUserUid')]);
      assert.equal(notice.id, `device-removed-${tablet.deviceId}-2-${notice.get('targetUserUid')}`);
    }
    assert.equal(await userState(`device_${tablet.deviceId}`), 'missing');
    assert.equal(await refresh(tablet.session.refreshToken), null);
    await refusedWith(recordDeviceHeartbeat({ idToken: tablet.session.idToken, householdId: H, appVersion: BUILD }), 'device_revoked');
    // Nobody's account is touched.
    assert.equal((await house().collection('members').get()).size, 3);
  });

  test('a retry of Remove is idempotent and finishes a pending sign-out', async () => {
    const tablet = await pair();
    // As if the post-commit Auth calls had failed: the record is removed, the user still exists.
    await record(tablet.deviceId).update({ status: 'removed', generation: 2 });
    assert.equal(await userState(`device_${tablet.deviceId}`), 'enabled');
    const retry = await removeDevice(owner, { householdId: H, deviceId: tablet.deviceId });
    assert.deepEqual(retry, { authCleanup: 'done', alreadyRemoved: true });
    assert.equal(await userState(`device_${tablet.deviceId}`), 'missing');
    assert.equal((await record(tablet.deviceId).get()).get('generation'), 2);
    await refusedWith(removeDevice(member, { householdId: H, deviceId: tablet.deviceId }), 'forbidden');
  });

  test('removal racing a re-pair resolves to one generation; the loser is refused', async () => {
    const tablet = await pair();
    const repair = await createDeviceRepairCode(owner, { householdId: H, deviceId: tablet.deviceId });
    const [removal, repaired] = await Promise.allSettled([
      removeDevice(owner, { householdId: H, deviceId: tablet.deviceId }),
      redeemDeviceCode({ code: repair.code, nonce: nonce() }),
    ]);
    assert.equal(removal.status, 'fulfilled');
    const stored = (await record(tablet.deviceId).get()).data()!;
    if (repaired.status === 'fulfilled') {
      // The re-pair committed first: removal then bumped past it.
      assert.equal(stored.generation, 3);
    } else {
      // Removal first (the code is revoked with it), or removal right after the re-pair
      // committed (the redemption sees it after minting and ends that credential).
      assert.ok(['revoked', 'not_repairable'].includes((repaired.reason as { code: string }).code));
      assert.ok([2, 3].includes(stored.generation));
    }
    assert.equal(stored.status, 'removed');
    assert.equal(await userState(`device_${tablet.deviceId}`), 'missing');
  });
});

describe('unpaired records, the Devices list and the daily sweep', () => {
  test('unpaired: the Auth user is disabled (refresh refused); re-pairing re-enables it with a new generation', async () => {
    const tablet = await pair();
    await record(tablet.deviceId).update({ status: 'unpaired', generation: 2, endedReason: 'personal-sign-in' });
    const cleanup = await finishDeviceRevocation(tablet.deviceId, { status: 'unpaired', generation: 2 });
    assert.deepEqual(cleanup, { ok: true, outcome: 'disabled' });
    assert.equal(await userState(`device_${tablet.deviceId}`), 'disabled');
    assert.equal(await refresh(tablet.session.refreshToken), null);
    const repair = await createDeviceRepairCode(owner, { householdId: H, deviceId: tablet.deviceId });
    const repaired = await redeemDeviceCode({ code: repair.code, nonce: nonce() });
    assert.equal(await userState(`device_${tablet.deviceId}`), 'enabled');
    const session = await signIn(repaired.customToken);
    assert.ok(await recordDeviceHeartbeat({ idToken: session.idToken, householdId: H, appVersion: BUILD }, new Date(Date.now() + 10_800_000)));
    const stored = (await record(tablet.deviceId).get()).data()!;
    assert.equal(stored.status, 'active');
    assert.equal(stored.generation, 3);
    assert.equal(stored.endedReason, undefined);
  });

  test('opening the Devices list finishes pending sign-outs and reports server time', async () => {
    const tablet = await pair();
    await record(tablet.deviceId).update({ status: 'removed', generation: 2 });
    const result = await reconcileDeviceSessions(owner, H);
    assert.equal(result.pending, 0);
    assert.ok(Math.abs(new Date(result.serverNow).getTime() - Date.now()) < 60_000);
    assert.equal(await userState(`device_${tablet.deviceId}`), 'missing');
    await refusedWith(reconcileDeviceSessions(member, H), 'forbidden');
  });

  test('the daily sweep deletes, disables and revokes as the records say, and removes orphaned tablet users', async () => {
    const removed = await pair('Removed');
    const unpaired = await pair('Unpaired');
    const repaired = await pair('Re-paired');
    const active = await pair('Active');
    await record(removed.deviceId).update({ status: 'removed', generation: 2 });
    await record(unpaired.deviceId).update({ status: 'unpaired', generation: 2 });
    // A re-pair whose post-commit revocation failed: the record moved on, the Auth user's claims did not.
    await record(repaired.deviceId).update({ generation: 2 });
    // A tablet user whose household is gone.
    const orphanId = 'OrphanDevice00000000';
    created.add(orphanId);
    await mintDeviceCredential(orphanId, 'household-that-is-gone', 1);

    const skipped = await sweepDeviceRevocations(adminDb, adminAuth, new Date(Date.UTC(2026, 10, 13, DEVICE_SWEEP_UTC_HOUR + 1)));
    assert.equal(skipped.ran, false, 'only once a day');

    const revokedBefore = await tokensValidAfter(`device_${repaired.deviceId}`);
    await new Promise(resolve => setTimeout(resolve, 1100));
    const result = await sweepDeviceRevocations(adminDb, adminAuth, new Date(Date.UTC(2026, 10, 13, DEVICE_SWEEP_UTC_HOUR)));
    assert.equal(result.ran, true);
    assert.ok(result.orphans >= 1);
    assert.equal(await userState(`device_${removed.deviceId}`), 'missing');
    assert.equal(await userState(`device_${unpaired.deviceId}`), 'disabled');
    assert.ok(await tokensValidAfter(`device_${repaired.deviceId}`) > revokedBefore, 'old credential of the re-paired record revoked');
    assert.ok(['refused', 'old-generation'].includes(await oldCredentialRefused(repaired.session.refreshToken, H, 1)));
    assert.equal(await userState(`device_${orphanId}`), 'missing');
    assert.equal(await userState(`device_${active.deviceId}`), 'enabled');
    assert.ok(await refresh(active.session.refreshToken), 'an active tablet keeps its session');
  });
});

describe('household deletion', () => {
  test('tablets are removed and signed out at step 1, before any data deletion (forced failure afterwards)', async () => {
    const tablet = await pair();
    const other = await pair('Second');
    await house().collection('chores').doc('c1').set({ task: 'Dishes', isCompleted: false });
    const unused = await createDeviceCode(owner, { householdId: H, name: 'Unused', room: 'R' });
    const client = await clientSession(tablet.customToken);
    try {
      await getDocFromServer(doc(client.db, 'households', H, 'chores', 'c1'));
      await assert.rejects(deleteHousehold(owner, H, `House ${H}`, new Date(), {
        deleteFiles: async () => { throw new Error('forced failure after the tablet step'); },
      }), /forced failure/);
      // Data is still there (deletion stopped), but every tablet is removed and signed out.
      assert.equal((await house().collection('chores').doc('c1').get()).exists, true);
      for (const device of [tablet, other]) {
        const stored = (await record(device.deviceId).get()).data()!;
        assert.equal(stored.status, 'removed');
        assert.equal(stored.endedReason, 'household-deleted');
        assert.equal(stored.generation, 2);
        assert.equal(await userState(`device_${device.deviceId}`), 'missing');
        assert.equal(await refresh(device.session.refreshToken), null);
      }
      assert.equal((await adminDb.collection('deviceCodes').doc(unused.code).get()).get('revokedReason'), 'household-deleted');
      await assert.rejects(getDocFromServer(doc(client.db, 'households', H, 'chores', 'c1')), /permission/i);
      await refusedWith(recordDeviceHeartbeat({ idToken: tablet.session.idToken, householdId: H, appVersion: BUILD }), 'device_revoked');

      // Finishing the deletion removes the device records and codes too.
      await deleteHousehold(owner, H, `House ${H}`, new Date(), { deleteFiles: async () => undefined });
      assert.equal((await record(tablet.deviceId).get()).exists, false);
      assert.equal((await adminDb.collection('deviceCodes').doc(unused.code).get()).exists, false);
    } finally {
      await client.close();
    }
  });
});
