import assert from 'node:assert/strict';
import { after, beforeEach, describe, test } from 'node:test';
import { Timestamp } from 'firebase-admin/firestore';
import { adminAuth, adminDb } from '../../src/lib/server/firebase-admin';
import { verifyDevice } from '../../src/lib/server/device-identity';
import { MembershipError, redeemInvite } from '../../src/lib/server/household-membership';
import {
  createDeviceCode,
  createDeviceRepairCode,
  redeemDeviceCode,
  redeemDeviceCodeGuarded,
  removeDevice,
  revokeDeviceCode,
} from '../../src/lib/server/device-management';
import { createDeviceCodeAction } from '../../src/app/household/device-actions';
import { DEVICE_CODE_AS_INVITE_MESSAGE } from '../../src/lib/devices/device-codes';
import { decodeJwt, deleteDeviceUsers, nonce, personToken, refresh, refusedWith, seedHousehold, signIn, type Person } from './device-test-helpers';

// Device codes and redemption (docs/modules/devices/README.md, 3): authority (owner and
// admin role only), the 15-minute bound from the server's creation time, single use,
// nonce retries, exactly one winner under concurrency, creator re-check, re-pair races,
// wrong-kind messages, abuse limits, App Check outside the emulator, the creator's
// notification and activity.

const H = 'device-codes-house';
const HB = 'device-codes-house-b';
const owner: Person = { uid: 'dc-owner', email: 'dc.owner@example.test', displayName: 'Olive', role: 'owner' };
const admin: Person = { uid: 'dc-admin', email: 'dc.admin@example.test', displayName: 'Ada', role: 'admin' };
const member: Person = { uid: 'dc-member', email: 'dc.member@example.test', displayName: 'Max', role: 'member', permissions: { 'household.manageInvites': true } };
const ownerB: Person = { uid: 'dc-owner-b', email: 'dc.ownerb@example.test', displayName: 'Bea', role: 'owner' };
const created = new Set<string>();

const devices = () => adminDb.collection('households').doc(H).collection('devices');
const codeDoc = (code: string) => adminDb.collection('deviceCodes').doc(code);
const redeem = async (code: string, value = nonce(), now?: Date) => {
  const result = await redeemDeviceCode({ code, nonce: value }, now);
  created.add(result.deviceId);
  return result;
};

beforeEach(async () => {
  await seedHousehold(H, [owner, admin, member]);
  await seedHousehold(HB, [ownerB]);
});

after(async () => {
  await deleteDeviceUsers([...created]);
  for (const id of [H, HB]) {
    await adminDb.recursiveDelete(adminDb.collection('households').doc(id));
    const codes = await adminDb.collection('deviceCodes').where('householdId', '==', id).get();
    await Promise.all(codes.docs.map(d => d.ref.delete()));
  }
});

describe('creating device codes', () => {
  test('owners and admins create codes; the code stores no email and logs no code', async () => {
    for (const person of [owner, admin]) {
      const result = await createDeviceCode(person, { householdId: H, name: ' Kitchen tablet ', room: 'Kitchen', sections: { pets: false } });
      assert.match(result.code, /^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{2}$/);
      const stored = (await codeDoc(result.code).get()).data()!;
      assert.equal(stored.kind, 'pair');
      assert.equal(stored.name, 'Kitchen tablet');
      assert.equal(stored.sections.pets, false);
      assert.equal(stored.createdByUid, person.uid);
      assert.equal(JSON.stringify(stored).includes('@'), false);
      const expires = (stored.expiresAt as Timestamp).toMillis() - (stored.createdAt as Timestamp).toMillis();
      assert.equal(expires, 15 * 60 * 1000);
    }
    const audit = await adminDb.collection('households').doc(H).collection('auditLogs').where('action', '==', 'device.code_created').get();
    assert.equal(audit.size, 2);
    for (const entry of audit.docs) {
      assert.equal(entry.get('actorEmail'), null);
      assert.equal(JSON.stringify(entry.data()).match(/[A-Z2-9]{4}-[A-Z2-9]{4}/), null, 'no code in the activity log');
    }
  });

  test('a member holding Manage invites is refused (role, not permission); outsiders too', async () => {
    await refusedWith(createDeviceCode(member, { householdId: H, name: 'T', room: 'R' }), 'forbidden');
    await refusedWith(createDeviceCode(ownerB, { householdId: H, name: 'T', room: 'R' }), 'not_member');
    await refusedWith(createDeviceCode(owner, { householdId: H, name: '', room: 'R' }), 'invalid_input');
    await refusedWith(createDeviceCode(owner, { householdId: H, name: 'T', room: 'x'.repeat(41) }), 'invalid_input');
    await refusedWith(createDeviceCode(owner, { householdId: H, name: 'T', room: 'R', sections: { automation: true } }), 'invalid_input');
  });

  test('a device token cannot create codes (personal callers only)', async () => {
    const { code } = await createDeviceCode(owner, { householdId: H, name: 'T', room: 'R' });
    const paired = await redeem(code);
    const deviceToken = (await signIn(paired.customToken)).idToken;
    const result = await createDeviceCodeAction({ idToken: deviceToken, householdId: H, name: 'Sneaky', room: 'R' });
    assert.deepEqual(result.ok ? 'ok' : result.code, 'unauthenticated');
    const ownerToken = await personToken(owner);
    const allowed = await createDeviceCodeAction({ idToken: ownerToken, householdId: H, name: 'Fine', room: 'R' });
    assert.equal(allowed.ok, true);
  });

  test('at most 10 live codes per household; the flag off refuses everything', async () => {
    for (let index = 0; index < 10; index += 1) await createDeviceCode(owner, { householdId: H, name: `T${index}`, room: 'R' });
    await refusedWith(createDeviceCode(owner, { householdId: H, name: 'Eleven', room: 'R' }), 'too_many_codes');
    process.env.HOMEHUB_DEVICES_ENABLED = 'false';
    try {
      await refusedWith(createDeviceCode(owner, { householdId: HB, name: 'T', room: 'R' }), 'unavailable');
      await refusedWith(redeemDeviceCodeGuarded({ code: 'ABCD-EFGH-JK', nonce: nonce(), appCheckToken: null, address: null }), 'unavailable');
    } finally {
      process.env.HOMEHUB_DEVICES_ENABLED = 'true';
    }
  });

  test('a household being deleted, or one still carrying legacy emails, takes no tablets', async () => {
    const { code } = await createDeviceCode(owner, { householdId: H, name: 'T', room: 'R' });
    await adminDb.collection('households').doc(H).update({ memberEmails: [owner.email] });
    await refusedWith(redeem(code), 'household_needs_upkeep');
    await adminDb.collection('households').doc(H).update({ deletingAt: Timestamp.now() });
    await refusedWith(redeem(code), 'household_deleting');
    await refusedWith(createDeviceCode(owner, { householdId: H, name: 'T', room: 'R' }), 'household_deleting');
  });
});

describe('redeeming', () => {
  test('pairing creates the record with the code\'s name, room and sections, marks the code used, notifies the creator', async () => {
    const { code } = await createDeviceCode(admin, { householdId: H, name: 'Kitchen tablet', room: 'Kitchen', sections: { maintenance: false } });
    const paired = await redeem(code);
    assert.equal(paired.householdId, H);
    assert.match(paired.deviceId, /^[A-Za-z0-9]{20}$/);
    const record = (await devices().doc(paired.deviceId).get()).data()!;
    assert.equal(record.status, 'active');
    assert.equal(record.generation, 1);
    assert.equal(record.name, 'Kitchen tablet');
    assert.equal(record.room, 'Kitchen');
    assert.equal(record.sections.maintenance, false);
    assert.equal(record.pairedByUid, admin.uid);
    assert.deepEqual(record.startPage, { kind: 'home' });
    // No credential material on the record.
    assert.equal(JSON.stringify(record).match(/token|nonce|secret/i), null);
    const used = (await codeDoc(code).get()).data()!;
    assert.ok(used.usedAt);
    assert.equal(used.usedByDeviceId, paired.deviceId);
    assert.equal(used.usedDeviceName, 'Kitchen tablet');
    assert.match(used.redemptionNonceHash, /^[0-9a-f]{64}$/);
    const note = (await adminDb.collection('households').doc(H).collection('notifications').doc(`device-paired-${paired.deviceId}-1`).get()).data()!;
    assert.deepEqual(note.audience, [admin.uid]);
    assert.equal(note.targetUserUid, admin.uid);
    assert.equal(note.category, 'system');
    assert.equal(note.deepLink, '/household?tab=devices');
    const audit = await adminDb.collection('households').doc(H).collection('auditLogs').where('action', '==', 'device.paired').get();
    assert.equal(audit.size, 1);
    assert.equal(audit.docs[0].get('actorUid'), admin.uid);
    assert.equal(audit.docs[0].get('details').generation, 1);
  });

  test('typed loosely; a missing code, a member invite, a revoked or used code each get their refusal', async () => {
    const { code } = await createDeviceCode(owner, { householdId: H, name: 'T', room: 'R' });
    const loose = await redeem(code.toLowerCase().replace(/-/g, ' '));
    assert.equal(loose.householdId, H);
    await refusedWith(redeem(code), 'used');
    await refusedWith(redeem('ZZZZ-ZZZZ-ZZ'), 'not_found');
    await refusedWith(redeem('nope'), 'invalid_input');
    await refusedWith(redeemDeviceCode({ code, nonce: 'short' }), 'invalid_input');
    await adminDb.collection('inviteCodes').doc('INVT-CODE-22').set({ householdId: H, code: 'INVT-CODE-22', expiresAt: Timestamp.fromMillis(Date.now() + 600_000), maxUses: 1, useCount: 0 });
    try {
      await refusedWith(redeem('INVT-CODE-22'), 'wrong_kind');
    } finally {
      await adminDb.collection('inviteCodes').doc('INVT-CODE-22').delete();
    }
    const second = await createDeviceCode(owner, { householdId: H, name: 'T2', room: 'R' });
    await revokeDeviceCode(admin, { householdId: H, code: second.code });
    await refusedWith(redeem(second.code), 'revoked');
    const revoked = (await codeDoc(second.code).get()).data()!;
    assert.equal(revoked.revokedReason, 'manual');
  });

  test('a device code typed as a member invite is pointed to tablet setup, never redeemed', async () => {
    const { code } = await createDeviceCode(owner, { householdId: H, name: 'T', room: 'R' });
    await assert.rejects(redeemInvite({ uid: 'dc-joiner', email: 'dc.joiner@example.test' }, code), (error: unknown) => {
      assert.ok(error instanceof MembershipError);
      assert.equal(error.userMessage, DEVICE_CODE_AS_INVITE_MESSAGE);
      return true;
    });
    assert.equal((await codeDoc(code).get()).get('usedAt'), undefined);
    assert.equal((await adminDb.collection('households').doc(H).collection('members').doc('dc-joiner').get()).exists, false);
  });

  test('expiry is 15 minutes from the server\'s creation time, whatever expiresAt claims', async () => {
    const { code } = await createDeviceCode(owner, { householdId: H, name: 'T', room: 'R' });
    // A stored expiry pushed a day out does not extend the code.
    await codeDoc(code).update({ expiresAt: Timestamp.fromMillis(Date.now() + 86_400_000) });
    await refusedWith(redeem(code, nonce(), new Date(Date.now() + 15 * 60_000 + 5_000)), 'expired');
    // A stored expiry in the past ends it early.
    await codeDoc(code).update({ expiresAt: Timestamp.fromMillis(Date.now() - 1_000) });
    await refusedWith(redeem(code), 'expired');
  });

  test('the same tablet retrying with its nonce gets a credential for the same record; anyone else gets used', async () => {
    const { code } = await createDeviceCode(owner, { householdId: H, name: 'T', room: 'R' });
    const value = nonce();
    const first = await redeem(code, value);
    const retry = await redeem(code, value);
    assert.equal(retry.deviceId, first.deviceId);
    assert.ok((await signIn(retry.customToken)).idToken);
    await refusedWith(redeem(code, nonce()), 'used');
    assert.equal((await devices().get()).size, 1);
    // After the code's 15 minutes, even the same nonce is refused.
    await refusedWith(redeem(code, value, new Date(Date.now() + 16 * 60_000)), 'expired');
    // A retry after the record left the active state is refused.
    await removeDevice(owner, { householdId: H, deviceId: first.deviceId });
    await refusedWith(redeem(code, value), 'used');
  });

  test('two or more tablets redeeming one code at once: exactly one winner, one record, no partial record', async () => {
    const { code } = await createDeviceCode(owner, { householdId: H, name: 'T', room: 'R' });
    const outcomes = await Promise.allSettled(Array.from({ length: 5 }, () => redeem(code)));
    const won = outcomes.filter(outcome => outcome.status === 'fulfilled');
    const lost = outcomes.filter(outcome => outcome.status === 'rejected') as PromiseRejectedResult[];
    assert.equal(won.length, 1);
    assert.equal(lost.length, 4);
    for (const loss of lost) assert.equal((loss.reason as { code?: string }).code, 'used');
    const records = await devices().get();
    assert.equal(records.size, 1);
    assert.equal(records.docs[0].id, (won[0] as PromiseFulfilledResult<{ deviceId: string }>).value.deviceId);
  });

  test('the creator lost access before redemption (demoted, removed or pending): refused', async () => {
    const demoted = await createDeviceCode(admin, { householdId: H, name: 'T', room: 'R' });
    await adminDb.collection('households').doc(H).collection('members').doc(admin.uid).update({ role: 'member' });
    await refusedWith(redeem(demoted.code), 'creator_lost_access');
    const removed = await createDeviceCode(owner, { householdId: H, name: 'T', room: 'R' });
    await adminDb.collection('households').doc(H).collection('members').doc(owner.uid).delete();
    await refusedWith(redeem(removed.code), 'creator_lost_access');
    assert.equal((await devices().get()).size, 0);
  });
});

describe('re-pairing', () => {
  test('re-pair keeps the record and settings, bumps the generation, and revokes older unused re-pair codes', async () => {
    const { code } = await createDeviceCode(owner, { householdId: H, name: 'Kitchen tablet', room: 'Kitchen' });
    const paired = await redeem(code);
    await devices().doc(paired.deviceId).update({ 'comfort.textScale': 130, 'sections.pets': false });
    const older = await createDeviceRepairCode(owner, { householdId: H, deviceId: paired.deviceId });
    const newer = await createDeviceRepairCode(admin, { householdId: H, deviceId: paired.deviceId });
    assert.equal((await codeDoc(older.code).get()).get('revokedReason'), 'superseded');
    await refusedWith(redeem(older.code), 'revoked');
    const repaired = await redeem(newer.code);
    assert.equal(repaired.deviceId, paired.deviceId);
    const record = (await devices().doc(paired.deviceId).get()).data()!;
    assert.equal(record.generation, 2);
    assert.equal(record.status, 'active');
    assert.equal(record.comfort.textScale, 130);
    assert.equal(record.sections.pets, false);
    assert.equal((await devices().get()).size, 1);
    assert.equal((await adminDb.collection('households').doc(H).collection('notifications').doc(`device-paired-${paired.deviceId}-2`).get()).get('targetUserUid'), admin.uid);
  });

  test('a removal between making and using the re-pair code wins: not_repairable; a removed record gets no code', async () => {
    const { code } = await createDeviceCode(owner, { householdId: H, name: 'T', room: 'R' });
    const paired = await redeem(code);
    const repair = await createDeviceRepairCode(owner, { householdId: H, deviceId: paired.deviceId });
    // Removal revokes the device's unused re-pair codes.
    await removeDevice(owner, { householdId: H, deviceId: paired.deviceId });
    await refusedWith(redeem(repair.code), 'revoked');
    await refusedWith(createDeviceRepairCode(owner, { householdId: H, deviceId: paired.deviceId }), 'not_repairable');
    // Even with the revocation undone, the generation check refuses it.
    await codeDoc(repair.code).update({ revokedAt: null });
    const reread = (await codeDoc(repair.code).get()).data()!;
    assert.equal(reread.revokedAt, null);
    await refusedWith(redeem(repair.code), 'not_repairable');
  });

  test('two re-pair codes for the same generation racing: one generation, the loser superseded', async () => {
    const { code } = await createDeviceCode(owner, { householdId: H, name: 'T', room: 'R' });
    const paired = await redeem(code);
    const first = await createDeviceRepairCode(owner, { householdId: H, deviceId: paired.deviceId });
    // A second code made concurrently in another session (not superseding the first).
    const secondId = 'RACE-CODE-22';
    const stored = (await codeDoc(first.code).get()).data()!;
    await codeDoc(secondId).set({ ...stored, code: secondId, createdAt: Timestamp.now(), expiresAt: Timestamp.fromMillis(Date.now() + 600_000) });
    const results = await Promise.allSettled([redeem(first.code), redeem(secondId)]);
    const won = results.filter(result => result.status === 'fulfilled');
    const lost = results.filter(result => result.status === 'rejected') as PromiseRejectedResult[];
    assert.equal(won.length, 1);
    assert.equal(lost.length, 1);
    assert.equal((lost[0].reason as { code?: string }).code, 'superseded');
    assert.equal((await devices().doc(paired.deviceId).get()).get('generation'), 2);
  });

  test('codes of another household cannot be revoked or used to re-pair its devices', async () => {
    const { code } = await createDeviceCode(owner, { householdId: H, name: 'T', room: 'R' });
    await refusedWith(revokeDeviceCode(ownerB, { householdId: HB, code }), 'not_found');
    const paired = await redeem(code);
    await refusedWith(createDeviceRepairCode(ownerB, { householdId: HB, deviceId: paired.deviceId }), 'not_found');
    await refusedWith(createDeviceRepairCode(member, { householdId: H, deviceId: paired.deviceId }), 'forbidden');
  });
});

describe('abuse limits and App Check', () => {
  // A fresh minute window per test (the limits are per instance, in memory).
  const later = (minutes: number) => new Date(Date.now() + minutes * 60_000);

  test('per client address: 10 a minute, then rate_limited; another address is unaffected', async () => {
    const now = later(60);
    const limits = { perAddress: 10, perInstance: 10_000 };
    for (let index = 0; index < 10; index += 1) {
      await refusedWith(redeemDeviceCodeGuarded({ code: 'ZZZZ-ZZZZ-ZZ', nonce: nonce(), appCheckToken: null, address: '203.0.113.9' }, { now, limits }), 'not_found');
    }
    await refusedWith(redeemDeviceCodeGuarded({ code: 'ZZZZ-ZZZZ-ZZ', nonce: nonce(), appCheckToken: null, address: '203.0.113.9' }, { now, limits }), 'rate_limited');
    await refusedWith(redeemDeviceCodeGuarded({ code: 'ZZZZ-ZZZZ-ZZ', nonce: nonce(), appCheckToken: null, address: '203.0.113.10' }, { now, limits }), 'not_found');
  });

  test('no known address is still limited per address, in the shared "unknown" bucket (PR #176 review)', async () => {
    const now = later(240);
    const limits = { perAddress: 2, perInstance: 10_000 };
    for (let index = 0; index < 2; index += 1) {
      await refusedWith(redeemDeviceCodeGuarded({ code: 'ZZZZ-ZZZZ-ZZ', nonce: nonce(), appCheckToken: null, address: null }, { now, limits }), 'not_found');
    }
    await refusedWith(redeemDeviceCodeGuarded({ code: 'ZZZZ-ZZZZ-ZZ', nonce: nonce(), appCheckToken: null, address: null }, { now, limits }), 'rate_limited');
    await refusedWith(redeemDeviceCodeGuarded({ code: 'ZZZZ-ZZZZ-ZZ', nonce: nonce(), appCheckToken: null, address: 'unknown' }, { now, limits }), 'rate_limited');
    await refusedWith(redeemDeviceCodeGuarded({ code: 'ZZZZ-ZZZZ-ZZ', nonce: nonce(), appCheckToken: null, address: '203.0.113.50' }, { now, limits }), 'not_found');
  });

  test('per instance: also without a known address', async () => {
    // Later than every other window in this file (entries ahead of `now` still count).
    const now = later(600);
    const limits = { perAddress: 100, perInstance: 3 };
    for (let index = 0; index < 3; index += 1) {
      await refusedWith(redeemDeviceCodeGuarded({ code: 'ZZZZ-ZZZZ-ZZ', nonce: nonce(), appCheckToken: null, address: null }, { now, limits }), 'not_found');
    }
    await refusedWith(redeemDeviceCodeGuarded({ code: 'ZZZZ-ZZZZ-ZZ', nonce: nonce(), appCheckToken: null, address: null }, { now, limits }), 'rate_limited');
  });

  test('outside the emulator a missing or unusable App Check token fails closed, before any redemption', async () => {
    const { code } = await createDeviceCode(owner, { householdId: H, name: 'T', room: 'R' });
    process.env.NEXT_PUBLIC_USE_FIREBASE_EMULATORS = 'false';
    try {
      await refusedWith(redeemDeviceCodeGuarded({ code, nonce: nonce(), appCheckToken: null, address: null }, { now: later(180) }), 'app_check_failed');
      await refusedWith(redeemDeviceCodeGuarded({ code, nonce: nonce(), appCheckToken: 'x'.repeat(5000), address: null }, { now: later(181) }), 'app_check_failed');
    } finally {
      process.env.NEXT_PUBLIC_USE_FIREBASE_EMULATORS = 'true';
    }
    assert.equal((await codeDoc(code).get()).get('usedAt'), undefined);
  });
});

describe('credential issuance after the commit (PR #176 review)', () => {
  const deferred = () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>(resolve => { release = resolve; });
    return { gate, release };
  };

  test('committed, then minting failed: a retry with the same code and nonce recovers the same tablet', async () => {
    const { code } = await createDeviceCode(owner, { householdId: H, name: 'T', room: 'R' });
    const value = nonce();
    await refusedWith(redeemDeviceCode({ code, nonce: value }, undefined, {
      beforeMint: async () => { throw new Error('Auth unavailable'); },
    }), 'failed');
    const record = (await devices().get()).docs[0];
    assert.equal(record.get('status'), 'active');
    assert.equal(record.get('credentialLease'), undefined, 'the issuance lease is released after a failure');
    const retry = await redeem(code, value);
    assert.equal(retry.deviceId, record.id);
    const session = await signIn(retry.customToken);
    assert.equal(decodeJwt(session.idToken).hh_gen, 1);
    // A new nonce (what the setup screen did before the fix) cannot recover it.
    await refusedWith(redeem(code, nonce()), 'used');
  });

  test('a superseded redemption resuming after a newer re-pair finished changes nothing: the newer claims and session survive', async () => {
    const { code } = await createDeviceCode(owner, { householdId: H, name: 'T', room: 'R' });
    const paired = await redeem(code);
    const first = await createDeviceRepairCode(owner, { householdId: H, deviceId: paired.deviceId });
    const pause = deferred();
    const committed = deferred();
    // A commits generation 2, then pauses before issuing its credential.
    const stale = redeemDeviceCode({ code: first.code, nonce: nonce() }, undefined, {
      afterCommit: async () => { committed.release(); await pause.gate; },
    });
    await committed.gate;
    assert.equal((await devices().doc(paired.deviceId).get()).get('generation'), 2);
    // B re-pairs to generation 3 and finishes, and its tablet signs in.
    const second = await createDeviceRepairCode(admin, { householdId: H, deviceId: paired.deviceId });
    const newer = await redeem(second.code);
    const session = await signIn(newer.customToken);
    assert.equal(decodeJwt(session.idToken).hh_gen, 3);
    // A resumes.
    pause.release();
    await refusedWith(stale, 'superseded');
    const claims = (await adminAuth.getUser(`device_${paired.deviceId}`)).customClaims;
    assert.equal(claims?.hh_gen, 3, 'the stale redemption did not overwrite the claims');
    const refreshed = await refresh(session.refreshToken);
    assert.ok(refreshed, "B's session survives");
    assert.equal(decodeJwt(refreshed.idToken).hh_gen, 3);
    assert.equal((await verifyDevice(refreshed.idToken, H)).generation, 3);
  });

  test('a newer re-pair committing while an older one holds the issuance lease: the older is refused, the newer issues last', async () => {
    const { code } = await createDeviceCode(owner, { householdId: H, name: 'T', room: 'R' });
    const paired = await redeem(code);
    const first = await createDeviceRepairCode(owner, { householdId: H, deviceId: paired.deviceId });
    const pause = deferred();
    const holding = deferred();
    const stale = redeemDeviceCode({ code: first.code, nonce: nonce() }, undefined, {
      beforeMint: async () => { holding.release(); await pause.gate; },
    });
    await holding.gate;
    const second = await createDeviceRepairCode(admin, { householdId: H, deviceId: paired.deviceId });
    const newerPromise = redeem(second.code);
    // The newer issuance waits for the lease; let the older one finish first.
    await new Promise(resolve => setTimeout(resolve, 500));
    pause.release();
    await refusedWith(stale, 'superseded');
    const newer = await newerPromise;
    const session = await signIn(newer.customToken);
    assert.equal(decodeJwt(session.idToken).hh_gen, 3);
    assert.equal((await adminAuth.getUser(`device_${paired.deviceId}`)).customClaims?.hh_gen, 3);
    assert.ok(await refresh(session.refreshToken));
    assert.equal((await devices().doc(paired.deviceId).get()).get('credentialLease'), undefined);
  });
});
