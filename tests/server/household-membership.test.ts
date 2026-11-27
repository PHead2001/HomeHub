import assert from 'node:assert/strict';
import { after, beforeEach, describe, test } from 'node:test';
import { adminDb } from '../../src/lib/server/firebase-admin';
import { MembershipError, deleteHousehold, leaveHousehold, redeemInvite, syncMemberProfile, type VerifiedCaller } from '../../src/lib/server/household-membership';
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
    // No email on the record (it is in the protected contact document only).
    assert.equal('email' in (member ?? {}), false);
    // The household document gets no email (member privacy release C); the legacy list is untouched.
    assert.deepEqual((await house.get()).data()?.memberEmails, [owner.email, admin.email, guest.email]);
    const used = (await adminDb.collection('inviteCodes').doc('ABCD-EFGH-JK').get()).data();
    assert.equal(used?.useCount, 1);
    const profile = (await adminDb.collection('users').doc(newcomer.email).get()).data();
    assert.equal(profile?.householdId, HOUSE);
    assert.equal(profile?.uid, newcomer.uid);

    const notes = await house.collection('notifications').where('sourceId', '==', newcomer.uid).get();
    const targets = notes.docs.map(d => d.data().targetUserUid).sort();
    for (const note of notes.docs) assert.deepEqual(note.data().audience, [note.data().targetUserUid]);
    assert.deepEqual(targets, [admin.uid, owner.uid].sort());
    for (const note of notes.docs) assert.equal(note.data().deepLink, '/household?tab=members');
  });

  test('the joiner gets back only the household id and name and their own status', async () => {
    await invite('TRIM-MEDX-XX');
    const result = await redeemInvite(newcomer, 'TRIM-MEDX-XX', NOW);
    assert.deepEqual(JSON.parse(JSON.stringify(result)), {
      household: { id: HOUSE, name: 'Join House' },
      member: { uid: newcomer.uid, role: 'newuser', status: 'pending', joinedAt: NOW.toISOString(), householdName: 'Join House' },
    });
    // Nobody's email, not even the household's member list or owner.
    const serialized = JSON.stringify(result);
    for (const email of [owner.email, admin.email, guest.email, newcomer.email]) assert.ok(!serialized.includes(email), email);
    // The waiting screen reads the name from the person's own record, not the household document.
    const member = (await adminDb.collection('households').doc(HOUSE).collection('members').doc(newcomer.uid).get()).data();
    assert.equal(member?.householdName, 'Join House');
    assert.equal(member?.displayName, 'Jordan');
  });

  test('joining writes the protected contact document with the verified email', async () => {
    await invite('CONT-ACTX-XX');
    await redeemInvite(newcomer, 'CONT-ACTX-XX', NOW);
    const contact = (await adminDb.collection('households').doc(HOUSE).collection('members').doc(newcomer.uid)
      .collection('private').doc('contact').get()).data();
    assert.deepEqual(contact, { email: newcomer.email, updatedAt: NOW.toISOString() });
  });

  test('a joiner whose token name is an email gets no public name', async () => {
    await invite('MAIL-NAME-XX');
    await redeemInvite({ ...second, displayName: second.email }, 'MAIL-NAME-XX', NOW);
    const member = (await adminDb.collection('households').doc(HOUSE).collection('members').doc(second.uid).get()).data();
    assert.equal(member?.displayName, undefined);
  });

  test('the joining photo follows the profile: removed stays removed, a missing field uses the token', async () => {
    const pictured: VerifiedCaller = { ...newcomer, avatarUrl: 'https://example.test/google.png' };
    const users = adminDb.collection('users').doc(newcomer.email);
    const memberDoc = adminDb.collection('households').doc(HOUSE).collection('members').doc(newcomer.uid);

    await users.set({ email: newcomer.email, avatarUrl: null, householdId: null });
    await invite('PHOT-OREM-OV');
    const cleared = await redeemInvite(pictured, 'PHOT-OREM-OV', NOW);
    assert.equal('avatarUrl' in cleared.member, false);
    assert.equal('avatarUrl' in ((await memberDoc.get()).data() || {}), false);

    await memberDoc.delete();
    await users.set({ email: newcomer.email, householdId: null });
    await invite('PHOT-OTOK-EN');
    await redeemInvite(pictured, 'PHOT-OTOK-EN', NOW);
    assert.equal((await memberDoc.get()).data()?.avatarUrl, pictured.avatarUrl);

    await memberDoc.delete();
    await users.set({ email: newcomer.email, avatarUrl: 'https://example.test/chosen.png', householdId: null });
    await invite('PHOT-OCHO-SE');
    await redeemInvite(pictured, 'PHOT-OCHO-SE', NOW);
    assert.equal((await memberDoc.get()).data()?.avatarUrl, 'https://example.test/chosen.png');
  });

  test('a joiner shows the name they chose in Profile, not the Google name (PR-2)', async () => {
    await invite('PROF-NAME-XX');
    await adminDb.collection('users').doc(newcomer.email).set({ email: newcomer.email, displayName: 'Jo' });
    await redeemInvite(newcomer, 'PROF-NAME-XX', NOW);
    const house = adminDb.collection('households').doc(HOUSE);
    assert.equal((await house.collection('members').doc(newcomer.uid).get()).get('displayName'), 'Jo');
    const notes = await house.collection('notifications').where('sourceId', '==', newcomer.uid).get();
    assert.ok(notes.docs.length > 0);
    for (const note of notes.docs) assert.match(String(note.get('message')), /Jo\b/);
    for (const note of notes.docs) assert.doesNotMatch(String(note.get('message')), /Jordan/);
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

  test('a code stops working once its creator may no longer invite (HO-8)', async () => {
    const house = adminDb.collection('households').doc(HOUSE);
    const members = house.collection('members');
    const noLongerValid = /no longer valid/;
    // Demoted: an admin made a Member (Members cannot manage invites by default).
    await invite('DEMO-TEDX-XX', { createdByUid: admin.uid, createdByEmail: admin.email });
    await members.doc(admin.uid).update({ role: 'member' });
    await rejects(redeemInvite(newcomer, 'DEMO-TEDX-XX', NOW), noLongerValid);
    // Invite permission taken away by an override.
    await members.doc(admin.uid).update({ role: 'admin', permissions: { 'household.manageInvites': false } });
    await invite('OVER-RIDE-XX', { createdByUid: admin.uid, createdByEmail: admin.email });
    await rejects(redeemInvite(newcomer, 'OVER-RIDE-XX', NOW), noLongerValid);
    // Removed (or left): no record any more.
    await members.doc(admin.uid).delete();
    await invite('REMO-VEDX-XX', { createdByUid: admin.uid, createdByEmail: admin.email });
    await rejects(redeemInvite(newcomer, 'REMO-VEDX-XX', NOW), noLongerValid);
    // Nothing was written by the refusals.
    assert.equal((await members.doc(newcomer.uid).get()).exists, false);
    for (const code of ['DEMO-TEDX-XX', 'OVER-RIDE-XX', 'REMO-VEDX-XX']) {
      assert.equal((await adminDb.collection('inviteCodes').doc(code).get()).data()?.useCount, 0, code);
    }
    // A guest granted the invite permission by an override is a valid creator.
    await members.doc(guest.uid).update({ permissions: { 'household.manageInvites': true } });
    await invite('GRAN-TEDX-XX', { createdByUid: guest.uid, createdByEmail: guest.email });
    const joined = await redeemInvite(newcomer, 'GRAN-TEDX-XX', NOW);
    assert.equal(joined.household.id, HOUSE);
  });

  test('a malformed invite or request is refused in plain words, not as a generic failure (HO-8)', async () => {
    const codes = adminDb.collection('inviteCodes');
    try {
      // No household on the invite: refused before any path is built from it.
      await codes.doc('NOHO-USEX-XX').set({ code: 'NOHO-USEX-XX', createdByUid: owner.uid, expiresAt: '2026-08-01T12:20:00.000Z', maxUses: 1, useCount: 0 });
      await rejects(redeemInvite(newcomer, 'NOHO-USEX-XX', NOW), /no longer valid/);
      await codes.doc('BADH-OUSE-XX').set({ code: 'BADH-OUSE-XX', householdId: 'a/b', createdByUid: owner.uid, expiresAt: '2026-08-01T12:20:00.000Z', maxUses: 1, useCount: 0 });
      await rejects(redeemInvite(newcomer, 'BADH-OUSE-XX', NOW), /no longer valid/);
      // No creator (written before codes recorded one).
      await invite('NOCR-EATO-RX', { createdByUid: null });
      await rejects(redeemInvite(newcomer, 'NOCR-EATO-RX', NOW), /no longer valid/);
      // Unreadable expiry and counts.
      await invite('BADE-XPIR-YX', { expiresAt: 'not a date' });
      await rejects(redeemInvite(newcomer, 'BADE-XPIR-YX', NOW), /expired/);
      // A request whose code is not a string.
      await rejects(redeemInvite(newcomer, 12345 as unknown as string, NOW), /10-character/);
      await rejects(redeemInvite(newcomer, { code: 'ABCD-EFGH-JK' } as unknown as string, NOW), /10-character/);
      assert.equal((await adminDb.collection('households').doc(HOUSE).collection('members').doc(newcomer.uid).get()).exists, false);
    } finally {
      await Promise.all(['NOHO-USEX-XX', 'BADH-OUSE-XX'].map(code => codes.doc(code).delete()));
    }
  });
});

describe('leaving and deleting', () => {
  test('a member leaves: record gone, chores unassigned, owner and admin alerted', async () => {
    const house = adminDb.collection('households').doc(HOUSE);
    await house.collection('chores').doc('c1').set({ task: 'Trash', assignedToEmail: guest.email, isCompleted: false });
    await house.collection('chores').doc('c2').set({ task: 'Done', assignedToEmail: guest.email, isCompleted: true });
    await house.collection('chore-templates').doc('t1').set({ task: 'Trash', assignedToEmail: guest.email, recurrence: { frequency: 'daily', assignedToEmail: guest.email } });
    await house.collection('members').doc(guest.uid).collection('private').doc('contact').set({ email: guest.email, updatedAt: 'x' });
    await leaveHousehold(guest, HOUSE, NOW);
    assert.equal((await house.collection('members').doc(guest.uid).get()).exists, false);
    assert.equal((await house.collection('members').doc(guest.uid).collection('private').doc('contact').get()).exists, false);
    assert.equal((await house.collection('chores').doc('c1').get()).data()?.assignedToEmail, undefined);
    assert.equal((await house.collection('chores').doc('c2').get()).data()?.assignedToEmail, guest.email);
    const template = (await house.collection('chore-templates').doc('t1').get()).data();
    assert.equal(template?.assignedToEmail, undefined);
    assert.equal(template?.recurrence?.assignedToEmail, undefined);
    assert.ok(!((await house.get()).data()?.memberEmails || []).includes(guest.email));
    const unassigned = (await house.collection('chores').doc('c1').get()).data();
    assert.equal(unassigned?.assignedToUid, '');
    assert.equal(unassigned?.assignedToDisplayName, 'Unassigned');
    const notes = await house.collection('notifications').where('sourceType', '==', 'household-member-left').get();
    assert.deepEqual(notes.docs.map(d => d.data().targetUserUid).sort(), [admin.uid, owner.uid].sort());
    for (const note of notes.docs) assert.deepEqual(note.data().audience, [note.data().targetUserUid]);
  });

  test('the leaving notice uses the member record name, which follows Profile (PR-2)', async () => {
    const house = adminDb.collection('households').doc(HOUSE);
    await house.collection('members').doc(guest.uid).update({ displayName: 'Grandma' });
    await leaveHousehold({ ...guest, displayName: 'Google Name' }, HOUSE, NOW);
    const notes = await house.collection('notifications').where('sourceType', '==', 'household-member-left').get();
    assert.ok(notes.docs.length > 0);
    for (const note of notes.docs) assert.equal(note.get('message'), 'Grandma left the household.');
    const audit = await house.collection('auditLogs').where('action', '==', 'member.left').get();
    assert.equal(audit.docs[0]?.get('actorName'), 'Grandma');
  });

  test('leaving unassigns chores and templates found by uid; a chore an older build moved to someone else is left alone', async () => {
    const house = adminDb.collection('households').doc(HOUSE);
    await house.collection('chores').doc('u1').set({ task: 'New', assignedToUid: guest.uid, assignedToEmail: guest.email, isCompleted: false });
    await house.collection('chores').doc('u2').set({ task: 'Uid only', assignedToUid: guest.uid, assignedToEmail: '', isCompleted: false });
    await house.collection('chores').doc('moved').set({ task: 'Moved', assignedToUid: guest.uid, assignedToEmail: admin.email, isCompleted: false });
    await house.collection('chore-templates').doc('t2').set({ task: 'Mop', assignedToUid: guest.uid, assignedToEmail: '', recurrence: { frequency: 'daily', assignedToEmail: '' } });
    await leaveHousehold(guest, HOUSE, NOW);
    for (const id of ['u1', 'u2']) {
      const chore = (await house.collection('chores').doc(id).get()).data();
      assert.equal(chore?.assignedToUid, '', id);
      assert.equal(chore?.assignedToEmail, undefined, id);
    }
    const moved = (await house.collection('chores').doc('moved').get()).data();
    assert.equal(moved?.assignedToEmail, admin.email);
    const template = (await house.collection('chore-templates').doc('t2').get()).data();
    assert.equal(template?.assignedToUid, undefined);
    assert.equal(template?.recurrence?.assignedToEmail, undefined);
  });

  test('the owner cannot leave and outsiders are refused', async () => {
    await rejects(leaveHousehold(owner, HOUSE, NOW), /Transfer ownership/);
    await rejects(leaveHousehold(newcomer, HOUSE, NOW), /not part/);
  });

  test('a child account cannot leave on its own (HO-11); an adult removes them', async () => {
    const house = adminDb.collection('households').doc(HOUSE);
    await house.collection('members').doc(second.uid).set({ uid: second.uid, role: 'child', status: 'active' });
    await rejects(leaveHousehold(second, HOUSE, NOW), /Ask an owner or admin/);
    assert.equal((await house.collection('members').doc(second.uid).get()).exists, true);
    // While the household is being deleted a child may leave like anyone else (HO-4).
    await house.update({ deletingAt: new Date() });
    await house.collection('members').doc(second.uid).update({ status: 'deleting' });
    await leaveHousehold(second, HOUSE, NOW);
    assert.equal((await house.collection('members').doc(second.uid).get()).exists, false);
  });

  test('a pending person cancels their request (HO-3): record and pointer gone, approval notices resolved, free to join elsewhere', async () => {
    const house = adminDb.collection('households').doc(HOUSE);
    await invite('CANC-ELME-XX');
    await redeemInvite(newcomer, 'CANC-ELME-XX', NOW);
    const requests = async () => (await house.collection('notifications').where('sourceType', '==', 'household-newuser').get()).docs;
    assert.ok((await requests()).length > 0);
    await leaveHousehold(newcomer, HOUSE, new Date(NOW.getTime() + 60_000));
    assert.equal((await house.collection('members').doc(newcomer.uid).get()).exists, false);
    assert.equal((await house.collection('members').doc(newcomer.uid).collection('private').doc('contact').get()).exists, false);
    assert.equal((await adminDb.collection('users').doc(newcomer.email).get()).data()?.householdId, null);
    for (const request of await requests()) assert.ok(request.get('resolvedAt'), 'join request resolved');
    // No "Member left" notices for a request that was never approved; the log says what happened.
    assert.equal((await house.collection('notifications').where('sourceType', '==', 'household-member-left').get()).size, 0);
    const log = (await house.collection('auditLogs').where('action', '==', 'member.request_cancelled').get()).docs;
    assert.equal(log.length, 1);
    assert.equal(log[0].get('actorUid'), newcomer.uid);
    // Joining another household is no longer blocked.
    await adminDb.collection('inviteCodes').doc('OTHE-RHOU-SE').set({
      code: 'OTHE-RHOU-SE', householdId: OTHER, createdByUid: elsewhere.uid, createdAt: NOW.toISOString(),
      expiresAt: '2026-08-01T12:20:00.000Z', maxUses: 1, useCount: 0,
    });
    const joined = await redeemInvite(newcomer, 'OTHE-RHOU-SE', new Date(NOW.getTime() + 120_000));
    assert.equal(joined.household.id, OTHER);
    await adminDb.collection('inviteCodes').doc('OTHE-RHOU-SE').delete();
  });

  test('only the owner, typing the exact name, can delete; everything goes', async () => {
    const house = adminDb.collection('households').doc(HOUSE);
    await house.collection('chores').doc('c1').set({ task: 'Trash' });
    await house.collection('pets').doc('p1').collection('feeding-logs').doc('f1').set({ amount: 1 });
    await adminDb.collection('users').doc(owner.email).set({ email: owner.email, householdId: HOUSE, role: 'owner' });
    await invite('DELE-TEME-XX');
    for (const person of [owner, guest]) {
      await house.collection('members').doc(person.uid).collection('private').doc('contact').set({ email: person.email, updatedAt: 'x' });
    }
    await rejects(deleteHousehold(admin, HOUSE, 'Join House'), /Only the household owner/);
    await rejects(deleteHousehold(owner, HOUSE, 'join house'), /exactly/);
    await deleteHousehold(owner, HOUSE, 'Join House');
    assert.equal((await house.get()).exists, false);
    for (const person of [owner, guest]) {
      assert.equal((await house.collection('members').doc(person.uid).collection('private').doc('contact').get()).exists, false);
    }
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

  test('a household being deleted refuses joining; non-owners may leave it (HO-4); only its owner can finish', async () => {
    const house = adminDb.collection('households').doc(HOUSE);
    // The state a delete leaves when it froze the household and then failed partway.
    await house.update({ deletingAt: new Date(), deletingByUid: owner.uid });
    for (const id of [owner.uid, admin.uid, guest.uid]) await house.collection('members').doc(id).update({ status: 'deleting' });
    await house.collection('members').doc(guest.uid).collection('private').doc('contact').set({ email: guest.email, updatedAt: 'x' });
    await adminDb.collection('users').doc(guest.email).set({ email: guest.email, householdId: HOUSE, role: 'guest' });
    await house.collection('chores').doc('left-behind').set({ task: 'Leftover', assignedToUid: guest.uid, isCompleted: false });
    await invite('FROZ-ENHO-US');
    await rejects(redeemInvite(newcomer, 'FROZ-ENHO-US', NOW), /being deleted/);
    // The guest leaves: their own documents go, nothing is written into the household.
    await leaveHousehold(guest, HOUSE, NOW);
    assert.equal((await house.collection('members').doc(guest.uid).get()).exists, false);
    assert.equal((await house.collection('members').doc(guest.uid).collection('private').doc('contact').get()).exists, false);
    assert.equal((await adminDb.collection('users').doc(guest.email).get()).data()?.householdId, null);
    assert.equal((await house.collection('auditLogs').get()).size, 0);
    assert.equal((await house.collection('notifications').get()).size, 0);
    assert.equal((await house.collection('chores').doc('left-behind').get()).data()?.assignedToUid, guest.uid);
    // And can join another household at once.
    await adminDb.collection('inviteCodes').doc('ELSE-WHER-EE').set({
      code: 'ELSE-WHER-EE', householdId: OTHER, createdByUid: elsewhere.uid, createdAt: NOW.toISOString(),
      expiresAt: '2026-08-01T12:20:00.000Z', maxUses: 1, useCount: 0,
    });
    const joined = await redeemInvite(guest, 'ELSE-WHER-EE', NOW);
    assert.equal(joined.household.id, OTHER);
    await adminDb.collection('inviteCodes').doc('ELSE-WHER-EE').delete();
    // The owner cannot walk away from it; they finish deleting instead.
    await rejects(leaveHousehold(owner, HOUSE, NOW), /Finish deleting/);
    await rejects(deleteHousehold(admin, HOUSE, 'Join House'), /Only the household owner/);
    await deleteHousehold(owner, HOUSE, 'Join House');
    assert.equal((await house.get()).exists, false);
    assert.equal((await house.collection('chores').get()).size, 0);
    assert.equal((await house.collection('members').get()).size, 0);
    assert.equal((await adminDb.collection('inviteCodes').doc('FROZ-ENHO-US').get()).exists, false);
  });
});

describe('public member data', () => {
  const photo = 'https://firebasestorage.googleapis.com/v0/b/demo/o/users%2Fa.png?alt=media&token=t';

  test('your profile name and photo reach your membership record, and nothing else changes', async () => {
    const house = adminDb.collection('households').doc(HOUSE);
    await adminDb.collection('users').doc(guest.email).set({ email: guest.email, displayName: 'Gus Guest', avatarUrl: photo, householdId: HOUSE, role: 'admin' });
    assert.deepEqual(await syncMemberProfile(guest, HOUSE), { displayName: 'Gus Guest', avatarUrl: photo, changed: true });
    const member = (await house.collection('members').doc(guest.uid).get()).data();
    assert.equal(member?.displayName, 'Gus Guest');
    assert.equal(member?.avatarUrl, photo);
    assert.equal(member?.role, 'guest', 'the profile role is never copied');
    assert.equal(member?.email, guest.email);
    // Running it again changes nothing.
    assert.equal((await syncMemberProfile(guest, HOUSE)).changed, false);
  });

  test('a removed photo and a cleared name are removed; emails and odd URLs are never copied', async () => {
    const house = adminDb.collection('households').doc(HOUSE);
    await house.collection('members').doc(guest.uid).update({ displayName: 'Old Name', avatarUrl: photo });
    await adminDb.collection('users').doc(guest.email).set({ email: guest.email, displayName: guest.email, avatarUrl: 'javascript:alert(1)' });
    assert.deepEqual(await syncMemberProfile(guest, HOUSE), { displayName: null, avatarUrl: null, changed: true });
    const member = (await house.collection('members').doc(guest.uid).get()).data();
    assert.equal(member?.displayName, undefined);
    assert.equal(member?.avatarUrl, null);
  });

  test('a pending person may sync; outsiders and unknown households are refused', async () => {
    await invite('SYNC-PEND-XX');
    await redeemInvite(newcomer, 'SYNC-PEND-XX', NOW);
    await adminDb.collection('users').doc(newcomer.email).set({ displayName: 'Jordan Lee' }, { merge: true });
    assert.equal((await syncMemberProfile(newcomer, HOUSE)).displayName, 'Jordan Lee');
    await rejects(syncMemberProfile(elsewhere, HOUSE), /not part of this household/);
    await rejects(syncMemberProfile(guest, 'no-such-house'), /no longer exists/);
    await rejects(syncMemberProfile(guest, 'bad/id'), /no longer exists/);
  });

  test('a household being deleted refuses it', async () => {
    await adminDb.collection('households').doc(HOUSE).update({ deletingAt: new Date() });
    await rejects(syncMemberProfile(guest, HOUSE), /being deleted/);
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
