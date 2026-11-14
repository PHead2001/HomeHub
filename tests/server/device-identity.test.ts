import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { doc, getDoc, getDocFromServer, onSnapshot } from 'firebase/firestore';
import { adminAuth, adminDb } from '../../src/lib/server/firebase-admin';
import { authorizeHouseholdAction } from '../../src/ai/action-auth';
import { verifyCaller } from '../../src/lib/server/household-membership';
import { DeviceAuthError, verifyDevice } from '../../src/lib/server/device-identity';
import {
  createDeviceCode,
  createDeviceRepairCode,
  redeemDeviceCode,
  removeDevice,
} from '../../src/lib/server/device-management';
import * as householdActions from '../../src/app/household/actions';
import * as deviceActions from '../../src/app/household/device-actions';
import * as choreActions from '../../src/app/chores/actions';
import * as shoppingActions from '../../src/app/shopping/actions';
import * as automationActions from '../../src/app/automation/actions';
import {
  clientSession,
  decodeJwt,
  deleteDeviceUsers,
  nonce,
  oldCredentialRefused,
  tokensValidAfter,
  personToken,
  refresh,
  seedHousehold,
  signIn,
  userState,
  type Person,
} from './device-test-helpers';

// Device identity (docs/modules/devices/README.md, 2.1): real ID tokens from the Auth
// emulator. Claims after a refresh-token exchange, the old refresh token refused after
// a re-pair and after removal, removal ending reads (new requests) and what an
// already-open listener does (recorded, JC-25), and device tokens refused by every
// personal server action (8.2 inventory).

const H = 'device-identity-house';
const owner: Person = { uid: 'di-owner', email: 'di.owner@example.test', displayName: 'Olive', role: 'owner' };
const created: string[] = [];

const pair = async (name = 'Kitchen tablet') => {
  const { code } = await createDeviceCode(owner, { householdId: H, name, room: 'Kitchen' });
  const result = await redeemDeviceCode({ code, nonce: nonce() });
  created.push(result.deviceId);
  return result;
};

before(async () => {
  await seedHousehold(H, [owner]);
  await adminDb.collection('households').doc(H).collection('chores').doc('c1').set({ task: 'Dishes', isCompleted: false });
});

after(async () => {
  await deleteDeviceUsers(created);
  await adminDb.recursiveDelete(adminDb.collection('households').doc(H));
});

describe('device credentials', () => {
  test('claims are in the ID token and survive a refresh-token exchange; no email, custom provider', async () => {
    const paired = await pair();
    const session = await signIn(paired.customToken);
    const first = decodeJwt(session.idToken);
    assert.equal(first.user_id, `device_${paired.deviceId}`);
    const refreshed = await refresh(session.refreshToken);
    assert.ok(refreshed, 'refresh-token exchange works');
    const claims = decodeJwt(refreshed.idToken);
    assert.equal(claims.hh_kind, 'device');
    assert.equal(claims.hh_household, H);
    assert.equal(claims.hh_device, paired.deviceId);
    assert.equal(claims.hh_gen, 1);
    assert.equal(Number.isInteger(claims.hh_gen), true, 'hh_gen arrives as an integer');
    assert.equal('email' in claims, false);
    assert.equal((claims.firebase as { sign_in_provider?: string }).sign_in_provider, 'custom');
    // The server accepts it as this household's active tablet.
    const identity = await verifyDevice(refreshed.idToken, H);
    assert.equal(identity.deviceId, paired.deviceId);
    assert.equal(identity.generation, 1);
    // Durable copy on the Auth user too.
    assert.deepEqual((await adminAuth.getUser(`device_${paired.deviceId}`)).customClaims,
      { hh_kind: 'device', hh_household: H, hh_device: paired.deviceId, hh_gen: 1 });
  });

  test('re-pair: the new token carries the new generation; the old refresh token and old ID token are refused', async () => {
    const paired = await pair('Hall tablet');
    const old = await signIn(paired.customToken);
    const signedInAt = Date.now();
    // Token revocation is checked at second precision.
    await new Promise(resolve => setTimeout(resolve, 1100));
    const { code } = await createDeviceRepairCode(owner, { householdId: H, deviceId: paired.deviceId });
    const repaired = await redeemDeviceCode({ code, nonce: nonce() });
    assert.equal(repaired.deviceId, paired.deviceId);
    const fresh = await signIn(repaired.customToken);
    assert.equal(decodeJwt(fresh.idToken).hh_gen, 2);
    const freshRefreshed = await refresh(fresh.refreshToken);
    assert.equal(decodeJwt(freshRefreshed!.idToken).hh_gen, 2);
    // The re-pair revoked every earlier refresh token (tokensValidAfterTime moved past the old
    // sign-in). Refused at the exchange in production; the emulator still exchanges it, and the
    // token it returns carries the old generation, which the server and the rules refuse.
    assert.ok(await tokensValidAfter(`device_${paired.deviceId}`) >= Math.floor(signedInAt / 1000) * 1000 + 1000);
    assert.ok(['refused', 'old-generation'].includes(await oldCredentialRefused(old.refreshToken, H, 1)));
    await assert.rejects(verifyDevice(old.idToken, H), (error: unknown) => error instanceof DeviceAuthError && error.code === 'device_revoked');
  });

  test('removal: the Auth user is deleted, refresh refused, server and rules refuse new requests', async () => {
    const paired = await pair('Den tablet');
    const session = await signIn(paired.customToken);
    // The same one-time credential also opens a client SDK session (rules applied).
    const client = await clientSession(paired.customToken);
    try {
      await getDocFromServer(doc(client.db, 'households', H, 'chores', 'c1'));
      const removal = await removeDevice(owner, { householdId: H, deviceId: paired.deviceId });
      assert.equal(removal.authCleanup, 'done');
      assert.equal(await userState(`device_${paired.deviceId}`), 'missing');
      assert.equal(await refresh(session.refreshToken), null);
      await assert.rejects(verifyDevice(session.idToken, H), (error: unknown) => error instanceof DeviceAuthError && error.code === 'device_revoked');
      // The client's ID token is still unexpired, but the rules compare the record on every new read.
      await assert.rejects(getDocFromServer(doc(client.db, 'households', H, 'chores', 'c1')), /permission/i);
      await assert.rejects(getDocFromServer(doc(client.db, 'households', H)), /permission/i);
      // Its own record stays readable, so an honest tablet can see that it was removed.
      const own = await getDoc(doc(client.db, 'households', H, 'devices', paired.deviceId));
      assert.equal(own.get('status'), 'removed');
    } finally {
      await client.close();
    }
  });

  test('a listener opened before removal (JC-25): records what it receives afterwards', async (t) => {
    const paired = await pair('Porch tablet');
    const client = await clientSession(paired.customToken);
    const events: string[] = [];
    try {
      const ready = new Promise<void>((resolve) => {
        const stop = onSnapshot(doc(client.db, 'households', H, 'chores', 'c1'), (snapshot) => {
          events.push(`snapshot:${snapshot.get('task')}`);
          resolve();
        }, (error) => {
          events.push(`error:${error.code}`);
          resolve();
        });
        t.after(stop);
      });
      await ready;
      await removeDevice(owner, { householdId: H, deviceId: paired.deviceId });
      await adminDb.collection('households').doc(H).collection('chores').doc('c1').update({ task: 'Dishes after removal' });
      await new Promise(resolve => setTimeout(resolve, 2500));
      t.diagnostic(`listener events across removal: ${events.join(', ')}`);
      // Also left in the OS temp folder, so the observation can be recorded in the README.
      writeFileSync(join(tmpdir(), 'homehub-jc25-listener.json'), JSON.stringify({ at: new Date().toISOString(), events }));
      // New requests are refused at once (asserted above); an open listener is not
      // guaranteed to be cut. Whatever it did is recorded in the module README.
      assert.ok(events.length >= 1);
      assert.ok(events[0].startsWith('snapshot:'));
    } finally {
      await client.close();
    }
  });
});

describe('device tokens on personal paths, personal tokens on device paths', () => {
  let deviceToken = '';
  let personalToken = '';
  before(async () => {
    const paired = await pair('Inventory tablet');
    deviceToken = (await signIn(paired.customToken)).idToken;
    personalToken = await personToken(owner);
  });

  test('verifyDevice refuses a personal token (not_a_device) and the wrong household', async () => {
    await assert.rejects(verifyDevice(personalToken, H), (error: unknown) => error instanceof DeviceAuthError && error.code === 'not_a_device');
    await assert.rejects(verifyDevice(deviceToken, 'another-house'), (error: unknown) => error instanceof DeviceAuthError && error.code === 'wrong_household');
    await assert.rejects(verifyDevice('not-a-token', H), (error: unknown) => error instanceof DeviceAuthError && error.code === 'unauthenticated');
  });

  test('the two personal authentication paths refuse a device token (no email)', async () => {
    await assert.rejects(verifyCaller(deviceToken), /sign-in has expired/);
    const unauthenticated = (error: unknown) => (error as { code?: string }).code === 'unauthenticated';
    await assert.rejects(authorizeHouseholdAction({ idToken: deviceToken, householdId: H }), unauthenticated);
    await assert.rejects(authorizeHouseholdAction({ idToken: deviceToken, householdId: H }, 'chores.view'), unauthenticated);
  });

  test('every existing server action refuses a device token and writes nothing', async () => {
    const before = (await adminDb.collection('households').doc(H).get()).updateTime?.toMillis();
    const input = {
      idToken: deviceToken, householdId: H, name: 'Renamed by tablet', confirmName: `House ${H}`, code: 'ABCD-EFGH-JK', memberUid: owner.uid,
      role: 'member', overrides: {}, choreIds: ['c1'], choreId: 'c1', completionId: 'x', listId: 'l1', tripId: 'trip-1', mode: 'putAway', items: [],
      url: 'https://ha.example', token: 'x', deviceId: 'abcdefghij0123456789', patch: { name: 'x' }, room: 'x',
    };
    const modules: Record<string, Record<string, unknown>> = { householdActions, deviceActions, choreActions, shoppingActions, automationActions };
    let checked = 0;
    for (const [moduleName, actions] of Object.entries(modules)) {
      for (const [name, action] of Object.entries(actions)) {
        if (typeof action !== 'function') continue;
        // The two device endpoints take no personal token: redemption is unauthenticated
        // (code + nonce), the heartbeat takes the device's own token.
        if (name === 'redeemDeviceCodeAction' || name === 'deviceHeartbeatAction') continue;
        const outcome = await (action as (value: unknown) => Promise<unknown>)(input).catch((error: unknown) => ({ ok: false, thrown: String(error) }));
        assert.ok(outcome && typeof outcome === 'object' && (outcome as { ok?: unknown }).ok !== true, `${moduleName}.${name} must refuse a device token`);
        checked += 1;
      }
    }
    assert.ok(checked >= 25, `checked ${checked} actions`);
    assert.equal((await adminDb.collection('households').doc(H).get()).updateTime?.toMillis(), before);
    assert.equal((await adminDb.collection('households').doc(H).get()).get('name'), `House ${H}`);
  });
});
