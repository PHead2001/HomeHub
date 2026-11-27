import assert from 'node:assert/strict';
import { after, beforeEach, describe, test } from 'node:test';
import { adminDb } from '../../src/lib/server/firebase-admin';
import { MembershipError, setMemberColor, setMyBirthday, type VerifiedCaller } from '../../src/lib/server/household-membership';

// PR-24 (member colour) and PR-25 (opt-in birthday) against the Firestore emulator.
const NOW = new Date('2026-08-01T12:00:00.000Z');
const HOUSE = 'server-extras-house';

const owner: VerifiedCaller = { uid: 'extras-owner', email: 'extras.owner@example.test' };
const admin: VerifiedCaller = { uid: 'extras-admin', email: 'extras.admin@example.test' };
const member: VerifiedCaller = { uid: 'extras-member', email: 'extras.member@example.test' };
const pending: VerifiedCaller = { uid: 'extras-pending', email: 'extras.pending@example.test' };
const outsider: VerifiedCaller = { uid: 'extras-outsider', email: 'extras.outsider@example.test' };

const house = () => adminDb.collection('households').doc(HOUSE);
const record = async (uid: string) => (await house().collection('members').doc(uid).get()).data() ?? {};

beforeEach(async () => {
  await adminDb.recursiveDelete(house());
  await house().set({ name: 'Extras', ownerUid: owner.uid, timeZone: 'America/Chicago' });
  await house().collection('members').doc(owner.uid).set({ uid: owner.uid, role: 'owner', status: 'active', displayName: 'Owner' });
  await house().collection('members').doc(admin.uid).set({ uid: admin.uid, role: 'admin', status: 'active', displayName: 'Admin' });
  await house().collection('members').doc(member.uid).set({ uid: member.uid, role: 'member', status: 'active', displayName: 'Member' });
  await house().collection('members').doc(pending.uid).set({ uid: pending.uid, role: 'newuser', status: 'pending' });
});

after(() => adminDb.recursiveDelete(house()));

const refused = (promise: Promise<unknown>, code?: string) => assert.rejects(promise, (error: unknown) => {
  assert.ok(error instanceof MembershipError, String(error));
  if (code) assert.equal(error.code, code);
  return true;
});

describe('member colour (PR-24)', () => {
  test('a member chooses and clears their own colour', async () => {
    assert.deepEqual(await setMemberColor(member, HOUSE, null, 4, NOW), { color: 4 });
    assert.equal((await record(member.uid)).color, 4);
    await setMemberColor(member, HOUSE, null, null, NOW);
    assert.equal('color' in (await record(member.uid)), false);
  });

  test('only slots 1-8 are accepted', async () => {
    for (const bad of [0, 9, 1.5, '3']) await refused(setMemberColor(member, HOUSE, null, bad, NOW), 'invalid_input');
  });

  test('an admin can change a member\'s clashing colour, and it is logged', async () => {
    await setMemberColor(admin, HOUSE, member.uid, 2, NOW);
    assert.equal((await record(member.uid)).color, 2);
    const audit = await house().collection('auditLogs').where('action', '==', 'member.color_changed').get();
    assert.equal(audit.size, 1);
    assert.equal(audit.docs[0].get('actorUid'), admin.uid);
  });

  test('a member cannot change someone else\'s colour, nor an admin the owner\'s', async () => {
    await refused(setMemberColor(member, HOUSE, admin.uid, 2, NOW));
    await refused(setMemberColor(admin, HOUSE, owner.uid, 2, NOW));
    assert.equal('color' in (await record(owner.uid)), false);
  });

  test('pending people and outsiders are refused', async () => {
    await refused(setMemberColor(pending, HOUSE, null, 3, NOW), 'not_member');
    await refused(setMemberColor(outsider, HOUSE, null, 3, NOW), 'not_member');
  });
});

describe('opt-in birthday (PR-25)', () => {
  test('a member saves month and day only, and can remove it', async () => {
    assert.deepEqual(await setMyBirthday(member, HOUSE, { month: 2, day: 29 }), { birthday: { month: 2, day: 29 } });
    assert.deepEqual((await record(member.uid)).birthday, { month: 2, day: 29 });
    await setMyBirthday(member, HOUSE, null);
    assert.equal('birthday' in (await record(member.uid)), false);
  });

  test('impossible dates, extra fields and other people are refused', async () => {
    await refused(setMyBirthday(member, HOUSE, { month: 2, day: 30 }), 'invalid_input');
    await refused(setMyBirthday(member, HOUSE, '1990-05-04'), 'invalid_input');
    await refused(setMyBirthday(pending, HOUSE, { month: 5, day: 4 }), 'not_member');
    await refused(setMyBirthday(outsider, HOUSE, { month: 5, day: 4 }), 'not_member');
    // A year sent along is never stored.
    await setMyBirthday(member, HOUSE, { month: 5, day: 4, year: 1990 });
    assert.deepEqual((await record(member.uid)).birthday, { month: 5, day: 4 });
  });
});
