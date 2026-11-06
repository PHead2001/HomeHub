import assert from 'node:assert/strict';
import { after, beforeEach, describe, test } from 'node:test';
import { adminDb } from '../../src/lib/server/firebase-admin';
import { MembershipError, deleteHousehold, leaveHousehold, redeemInvite, type VerifiedCaller } from '../../src/lib/server/household-membership';
import { deduplicateNotifications } from '../../src/lib/notifications';
import type { Notification } from '../../src/lib/types';

// Runs against the Firestore emulator through the real Admin SDK path the app uses.
const NOW = new Date('2026-08-01T12:00:00.000Z');
const HOUSE = 'server-join-house';
const OTHER = 'server-other-house';

const owner: VerifiedCaller = { uid: 'join-owner', email: 'join.owner@example.test', displayName: 'Owner' };
const admin: VerifiedCaller = { uid: 'join-admin', email: 'join.admin@example.test' };
const guest: VerifiedCaller = { uid: 'join-guest', email: 'join.guest@example.test' };
const newcomer: VerifiedCaller = { uid: 'join-new', email: 'join.new@example.test', displayName: 'Jordan' };
const second: VerifiedCaller = { uid: 'join-second', email: 'join.second@example.test' };
const elsewhere: VerifiedCaller = { uid: 'join-elsewhere', email: 'join.elsewhere@example.test' };

const invite = (code: string, overrides: Record<string, unknown> = {}) => adminDb.collection('inviteCodes').doc(code).set({
  code,
  householdId: HOUSE,
  createdByUid: owner.uid,
  createdByEmail: owner.email,
  createdAt: '2026-08-01T11:50:00.000Z',
  expiresAt: '2026-08-01T12:20:00.000Z',
  maxUses: 1,
  useCount: 0,
  ...overrides,
});

const clear = async () => {
  for (const id of [HOUSE, OTHER]) {
    const ref = adminDb.collection('households').doc(id);
    await adminDb.recursiveDelete(ref);
  }
  const invites = await adminDb.collection('inviteCodes').where('householdId', '==', HOUSE).get();
  await Promise.all(invites.docs.map(d => d.ref.delete()));
  await Promise.all([owner, admin, guest, newcomer, second, elsewhere].map(u => adminDb.collection('users').doc(u.email).delete()));
};

beforeEach(async () => {
  await clear();
  const house = adminDb.collection('households').doc(HOUSE);
  await house.set({ name: 'Join House', ownerUid: owner.uid, ownerEmail: owner.email, memberEmails: [owner.email, admin.email, guest.email] });
  await house.collection('members').doc(owner.uid).set({ ...owner, role: 'owner', status: 'active' });
  await house.collection('members').doc(admin.uid).set({ ...admin, role: 'admin', status: 'active' });
  await house.collection('members').doc(guest.uid).set({ ...guest, role: 'guest', status: 'active' });
  const other = adminDb.collection('households').doc(OTHER);
  await other.set({ name: 'Other', ownerUid: elsewhere.uid, ownerEmail: elsewhere.email, memberEmails: [elsewhere.email] });
  await other.collection('members').doc(elsewhere.uid).set({ ...elsewhere, role: 'owner', status: 'active' });
  await adminDb.collection('users').doc(elsewhere.email).set({ email: elsewhere.email, householdId: OTHER, role: 'owner' });
});

after(clear);

const rejects = (promise: Promise<unknown>, pattern: RegExp) => assert.rejects(promise, (error: unknown) => {
  assert.ok(error instanceof MembershipError, `expected MembershipError, got ${String(error)}`);
  assert.match(error.userMessage, pattern);
  return true;
});

describe('invite redemption', () => {
  test('a valid code typed loosely creates a pending membership and notifies approvers only', async () => {
    await invite('ABCD-EFGH-JK');
    const result = await redeemInvite(newcomer, ' abcd efgh jk ', NOW);
    assert.equal(result.household.id, HOUSE);
    assert.equal(result.member.role, 'newuser');
    assert.equal(result.member.status, 'pending');

    const house = adminDb.collection('households').doc(HOUSE);
    const member = (await house.collection('members').doc(newcomer.uid).get()).data();
    assert.equal(member?.role, 'newuser');
    assert.equal(member?.status, 'pending');
    const used = (await adminDb.collection('inviteCodes').doc('ABCD-EFGH-JK').get()).data();
    assert.equal(used?.useCount, 1);
    const profile = (await adminDb.collection('users').doc(newcomer.email).get()).data();
    assert.equal(profile?.householdId, HOUSE);
    assert.equal(profile?.uid, newcomer.uid);

    const notes = await house.collection('notifications').where('sourceId', '==', newcomer.uid).get();
    const targets = notes.docs.map(d => d.data().targetUserUid).sort();
    assert.deepEqual(targets, [admin.uid, owner.uid].sort());
    for (const note of notes.docs) assert.equal(note.data().deepLink, '/household?tab=members');
  });

  test('expired, cancelled, used-up and unknown codes are refused with clear messages', async () => {
    await invite('EXPI-REDX-XX', { expiresAt: '2026-08-01T11:59:59.000Z' });
    await invite('REVO-KEDX-XX', { revokedAt: '2026-08-01T11:55:00.000Z' });
    await invite('USED-UPXX-XX', { useCount: 1 });
    await rejects(redeemInvite(newcomer, 'EXPI-REDX-XX', NOW), /expired/);
    await rejects(redeemInvite(newcomer, 'REVO-KEDX-XX', NOW), /cancelled/);
    await rejects(redeemInvite(newcomer, 'USED-UPXX-XX', NOW), /already been used/);
    await rejects(redeemInvite(newcomer, 'NOPE-NOPE-NO', NOW), /not found/);
    await rejects(redeemInvite(newcomer, 'short', NOW), /10-character/);
    const member = await adminDb.collection('households').doc(HOUSE).collection('members').doc(newcomer.uid).get();
    assert.equal(member.exists, false);
  });

  test('existing members and people in another household cannot redeem', async () => {
    await invite('MEMB-ERXX-XX');
    await rejects(redeemInvite(guest, 'MEMB-ERXX-XX', NOW), /already part/);
    await rejects(redeemInvite(elsewhere, 'MEMB-ERXX-XX', NOW), /Leave your current household/);
    const used = (await adminDb.collection('inviteCodes').doc('MEMB-ERXX-XX').get()).data();
    assert.equal(used?.useCount, 0);
  });

  test('a single-use code redeemed concurrently admits exactly one person', async () => {
    await invite('RACE-RACE-RA');
    const outcomes = await Promise.allSettled([
      redeemInvite(newcomer, 'RACE-RACE-RA', NOW),
      redeemInvite(second, 'RACE-RACE-RA', NOW),
    ]);
    assert.equal(outcomes.filter(o => o.status === 'fulfilled').length, 1);
    const used = (await adminDb.collection('inviteCodes').doc('RACE-RACE-RA').get()).data();
    assert.equal(used?.useCount, 1);
    const pending = await adminDb.collection('households').doc(HOUSE).collection('members').where('status', '==', 'pending').get();
    assert.equal(pending.size, 1);
  });

  test('multi-use codes stop at their limit', async () => {
    await invite('MULT-IUSE-XX', { maxUses: 2 });
    await redeemInvite(newcomer, 'MULT-IUSE-XX', NOW);
    await redeemInvite(second, 'MULT-IUSE-XX', NOW);
    const third: VerifiedCaller = { uid: 'join-third', email: 'join.third@example.test' };
    await rejects(redeemInvite(third, 'MULT-IUSE-XX', NOW), /already been used/);
    await adminDb.collection('users').doc(third.email).delete();
  });
});

describe('leaving and deleting', () => {
  test('a member leaves: record gone, chores unassigned, owner and admin alerted', async () => {
    const house = adminDb.collection('households').doc(HOUSE);
    await house.collection('chores').doc('c1').set({ task: 'Trash', assignedToEmail: guest.email, isCompleted: false });
    await house.collection('chores').doc('c2').set({ task: 'Done', assignedToEmail: guest.email, isCompleted: true });
    await house.collection('chore-templates').doc('t1').set({ task: 'Trash', assignedToEmail: guest.email, recurrence: { frequency: 'daily', assignedToEmail: guest.email } });
    await leaveHousehold(guest, HOUSE, NOW);
    assert.equal((await house.collection('members').doc(guest.uid).get()).exists, false);
    assert.equal((await house.collection('chores').doc('c1').get()).data()?.assignedToEmail, '');
    assert.equal((await house.collection('chores').doc('c2').get()).data()?.assignedToEmail, guest.email);
    const template = (await house.collection('chore-templates').doc('t1').get()).data();
    assert.equal(template?.assignedToEmail, undefined);
    assert.equal(template?.recurrence?.assignedToEmail, undefined);
    assert.ok(!((await house.get()).data()?.memberEmails || []).includes(guest.email));
    const notes = await house.collection('notifications').where('sourceType', '==', 'household-member-left').get();
    assert.deepEqual(notes.docs.map(d => d.data().targetUserUid).sort(), [admin.uid, owner.uid].sort());
  });

  test('the owner cannot leave and outsiders are refused', async () => {
    await rejects(leaveHousehold(owner, HOUSE, NOW), /Transfer ownership/);
    await rejects(leaveHousehold(newcomer, HOUSE, NOW), /not part/);
  });

  test('only the owner, typing the exact name, can delete; everything goes', async () => {
    const house = adminDb.collection('households').doc(HOUSE);
    await house.collection('chores').doc('c1').set({ task: 'Trash' });
    await house.collection('pets').doc('p1').collection('feeding-logs').doc('f1').set({ amount: 1 });
    await adminDb.collection('users').doc(owner.email).set({ email: owner.email, householdId: HOUSE, role: 'owner' });
    await invite('DELE-TEME-XX');
    await rejects(deleteHousehold(admin, HOUSE, 'Join House'), /Only the household owner/);
    await rejects(deleteHousehold(owner, HOUSE, 'join house'), /exactly/);
    await deleteHousehold(owner, HOUSE, 'Join House');
    assert.equal((await house.get()).exists, false);
    assert.equal((await house.collection('chores').get()).size, 0);
    assert.equal((await house.collection('pets').doc('p1').collection('feeding-logs').get()).size, 0);
    assert.equal((await adminDb.collection('inviteCodes').doc('DELE-TEME-XX').get()).exists, false);
    assert.equal((await adminDb.collection('users').doc(owner.email).get()).data()?.householdId, null);
  });

  test('a refused delete freezes nothing', async () => {
    const house = adminDb.collection('households').doc(HOUSE);
    await rejects(deleteHousehold(owner, HOUSE, 'Wrong Name'), /exactly/);
    assert.equal((await house.get()).data()?.deletingAt, undefined);
    assert.equal((await house.collection('members').doc(admin.uid).get()).data()?.status, 'active');
  });

  test('a household being deleted refuses joining and leaving, and only its owner can finish', async () => {
    const house = adminDb.collection('households').doc(HOUSE);
    // The state a delete leaves when it froze the household and then failed partway.
    await house.update({ deletingAt: new Date(), deletingByUid: owner.uid });
    for (const id of [owner.uid, admin.uid, guest.uid]) await house.collection('members').doc(id).update({ status: 'deleting' });
    await house.collection('chores').doc('left-behind').set({ task: 'Leftover' });
    await invite('FROZ-ENHO-US');
    await rejects(redeemInvite(newcomer, 'FROZ-ENHO-US', NOW), /being deleted/);
    await rejects(leaveHousehold(guest, HOUSE, NOW), /being deleted/);
    await rejects(deleteHousehold(admin, HOUSE, 'Join House'), /Only the household owner/);
    await deleteHousehold(owner, HOUSE, 'Join House');
    assert.equal((await house.get()).exists, false);
    assert.equal((await house.collection('chores').get()).size, 0);
    assert.equal((await house.collection('members').get()).size, 0);
    assert.equal((await adminDb.collection('inviteCodes').doc('FROZ-ENHO-US').get()).exists, false);
  });
});

describe('repeat events', () => {
  test('rejoining creates new approval notifications so push fires again', async () => {
    const house = adminDb.collection('households').doc(HOUSE);
    const approvals = async () => (await house.collection('notifications')
      .where('sourceType', '==', 'household-newuser').where('targetUserUid', '==', owner.uid).get()).size;
    await invite('FIRS-TJOI-NX');
    await redeemInvite(newcomer, 'FIRS-TJOI-NX', NOW);
    assert.equal(await approvals(), 1);
    // The owner dismisses the first request.
    const first = (await house.collection('notifications').where('sourceType', '==', 'household-newuser').where('targetUserUid', '==', owner.uid).get()).docs[0];
    await first.ref.update({ [`dismissedBy.${owner.uid}`]: true, [`readBy.${owner.uid}`]: true });
    await leaveHousehold(newcomer, HOUSE, new Date(NOW.getTime() + 60_000));
    await invite('SECO-NDJO-IN');
    await redeemInvite(newcomer, 'SECO-NDJO-IN', new Date(NOW.getTime() + 120_000));
    assert.equal(await approvals(), 2);
    // What the owner's bell shows after de-duplication: the new request, not dismissed.
    const docs = (await house.collection('notifications').where('targetUserUid', '==', owner.uid).get()).docs;
    const shown = deduplicateNotifications(docs.map(d => ({ id: d.id, ...d.data(),
      createdAt: d.data().createdAt.toDate(), expiresAt: d.data().expiresAt.toDate() }) as unknown as Notification))
      .filter(n => n.sourceType === 'household-newuser');
    assert.equal(shown.length, 2, 'separate join events stay separate');
    assert.equal(shown.filter(n => !(n.dismissedBy as Record<string, unknown>)?.[owner.uid]).length, 1, 'the rejoin request is not dismissed');
  });
});
