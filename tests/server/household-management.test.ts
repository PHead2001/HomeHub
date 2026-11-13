import assert from 'node:assert/strict';
import { after, beforeEach, describe, test } from 'node:test';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { adminDb } from '../../src/lib/server/firebase-admin';
import {
  MembershipError,
  changeMemberRole,
  createInvite,
  deleteHousehold,
  redeemInvite,
  removeMember,
  renameHousehold,
  revokeAllInvites,
  revokeInvite,
  transferOwnership,
  updateMemberPermissions,
  type MembershipErrorCode,
  type VerifiedCaller,
} from '../../src/lib/server/household-membership';
import type { HouseholdRole, PermissionOverrides } from '../../src/lib/types';

// Household management through the real Admin SDK path, against the Firestore emulator.
// Policy under test: src/lib/household-policy.ts (unit-tested in tests/unit/household-policy.test.ts).
const NOW = new Date('2026-08-01T12:00:00.000Z');
const HOUSE = 'server-manage-house';
const OTHER = 'server-manage-other';

const owner: VerifiedCaller = { uid: 'mg-owner', email: 'mg.owner@example.test', displayName: 'Olive Owner' };
const admin: VerifiedCaller = { uid: 'mg-admin', email: 'mg.admin@example.test', displayName: 'Adam Admin' };
const admin2: VerifiedCaller = { uid: 'mg-admin2', email: 'mg.admin2@example.test', displayName: 'Ada Admin' };
const member: VerifiedCaller = { uid: 'mg-member', email: 'mg.member@example.test', displayName: 'Mel Member' };
const member2: VerifiedCaller = { uid: 'mg-member2', email: 'mg.member2@example.test' };
const guest: VerifiedCaller = { uid: 'mg-guest', email: 'mg.guest@example.test', displayName: 'Gus Guest' };
const pending: VerifiedCaller = { uid: 'mg-pending', email: 'mg.pending@example.test', displayName: 'Pat Pending' };
const outsider: VerifiedCaller = { uid: 'mg-outsider', email: 'mg.outsider@example.test' };
const stranger: VerifiedCaller = { uid: 'mg-stranger', email: 'mg.stranger@example.test', displayName: 'Sam Stranger' };
const everyone = [owner, admin, admin2, member, member2, guest, pending, outsider, stranger];

const house = () => adminDb.collection('households').doc(HOUSE);
const memberRef = (person: VerifiedCaller) => house().collection('members').doc(person.uid);
const memberData = async (person: VerifiedCaller) => (await memberRef(person).get()).data();
const profile = async (person: VerifiedCaller) => (await adminDb.collection('users').doc(person.email).get()).data();

// As the server writes members since release D: no email on the record, the email
// in the protected contact document.
const SEEDED_CONTACT_AT = '2026-07-01T00:00:00.000Z';
const seedMember = async (person: VerifiedCaller, role: HouseholdRole, permissions: PermissionOverrides = {}, householdId = HOUSE) => {
  const ref = adminDb.collection('households').doc(householdId).collection('members').doc(person.uid);
  await ref.set({
    uid: person.uid,
    ...(person.displayName ? { displayName: person.displayName } : {}),
    role,
    status: role === 'newuser' ? 'pending' : 'active',
    permissions,
    joinedAt: '2026-07-01T00:00:00.000Z',
  });
  await ref.collection('private').doc('contact').set({ email: person.email, updatedAt: SEEDED_CONTACT_AT });
};

/** Gives an existing member permission overrides, as an owner would have. */
const grant = (person: VerifiedCaller, permissions: PermissionOverrides) => memberRef(person).update({ permissions });

const seedInvite = (code: string, overrides: Record<string, unknown> = {}) => adminDb.collection('inviteCodes').doc(code).set({
  code,
  householdId: HOUSE,
  householdName: 'Manage House',
  createdByUid: owner.uid,
  createdByEmail: owner.email,
  createdAt: '2026-08-01T11:50:00.000Z',
  expiresAt: Timestamp.fromDate(new Date('2026-08-01T12:20:00.000Z')),
  maxUses: 1,
  useCount: 0,
  ...overrides,
});

const clear = async () => {
  for (const id of [HOUSE, OTHER]) await adminDb.recursiveDelete(adminDb.collection('households').doc(id));
  for (const id of [HOUSE, OTHER]) {
    const invites = await adminDb.collection('inviteCodes').where('householdId', '==', id).get();
    await Promise.all(invites.docs.map(d => d.ref.delete()));
  }
  await Promise.all(everyone.map(u => adminDb.collection('users').doc(u.email).delete()));
};

beforeEach(async () => {
  await clear();
  await house().set({
    name: 'Manage House',
    ownerUid: owner.uid,
    ownerEmail: owner.email,
    memberEmails: [owner, admin, admin2, member, member2, guest, pending].map(u => u.email),
  });
  await seedMember(owner, 'owner');
  await seedMember(admin, 'admin');
  await seedMember(admin2, 'admin');
  await seedMember(member, 'member');
  await seedMember(member2, 'member');
  await seedMember(guest, 'guest');
  await seedMember(pending, 'newuser');
  for (const [person, role] of [[owner, 'owner'], [admin, 'admin'], [member, 'member'], [guest, 'guest'], [pending, 'newuser']] as const) {
    await adminDb.collection('users').doc(person.email).set({ email: person.email, uid: person.uid, householdId: HOUSE, role, permissions: {} });
  }
  const other = adminDb.collection('households').doc(OTHER);
  await other.set({ name: 'Other House', ownerUid: outsider.uid, ownerEmail: outsider.email, memberEmails: [outsider.email] });
  await seedMember(outsider, 'owner', {}, OTHER);
});

after(clear);

const refused = (promise: Promise<unknown>, code: MembershipErrorCode) => assert.rejects(promise, (error: unknown) => {
  assert.ok(error instanceof MembershipError, `expected MembershipError, got ${String(error)}`);
  assert.equal(error.code, code, error.userMessage);
  assert.ok(error.userMessage.length > 5);
  return true;
});

const audits = async (action?: string) => {
  const snapshot = await house().collection('auditLogs').get();
  return snapshot.docs.map(d => d.data()).filter(entry => !action || entry.action === action);
};

/** The activity-log entry carries the verified caller and the server's time, nothing else as actor. */
const assertActor = (entry: FirebaseFirestore.DocumentData | undefined, caller: VerifiedCaller) => {
  assert.ok(entry, 'activity-log entry missing');
  assert.equal(entry.actorUid, caller.uid);
  assert.equal(entry.actorEmail, caller.email);
  assert.equal(entry.actorName, caller.displayName ?? null);
  assert.equal(entry.createdAt, NOW.toISOString());
};

describe('rename household', () => {
  test('the owner renames it and the activity log records who did it', async () => {
    const result = await renameHousehold(owner, HOUSE, '  Maple Street  ', NOW);
    assert.deepEqual(result, { name: 'Maple Street' });
    const data = (await house().get()).data();
    assert.equal(data?.name, 'Maple Street');
    assert.equal(data?.updatedAt, NOW.toISOString());
    const [entry] = await audits('household.renamed');
    assertActor(entry, owner);
    assert.deepEqual(entry.details, { householdName: 'Maple Street', previousName: 'Manage House' });
  });

  test('renaming to the same name writes nothing', async () => {
    await renameHousehold(owner, HOUSE, 'Manage House', NOW);
    assert.equal((await audits()).length, 0);
  });

  test('a member without manageMembers is refused; a member granted it is allowed', async () => {
    await refused(renameHousehold(member, HOUSE, 'Mine Now', NOW), 'missing_permission');
    assert.equal((await house().get()).data()?.name, 'Manage House');
    assert.equal((await audits()).length, 0);
    await grant(member, { 'household.manageMembers': true });
    await renameHousehold(member, HOUSE, 'Shared Place', NOW);
    assert.equal((await house().get()).data()?.name, 'Shared Place');
    assertActor((await audits('household.renamed'))[0], member);
  });

  test('pending people, outsiders and bad names are refused', async () => {
    await refused(renameHousehold(pending, HOUSE, 'Nope', NOW), 'not_member');
    await refused(renameHousehold(outsider, HOUSE, 'Nope', NOW), 'not_member');
    await refused(renameHousehold(owner, HOUSE, '   ', NOW), 'invalid_input');
    await refused(renameHousehold(owner, HOUSE, 'x'.repeat(81), NOW), 'invalid_input');
    await refused(renameHousehold(owner, 'no-such-house', 'Nope', NOW), 'not_found');
    assert.equal((await house().get()).data()?.name, 'Manage House');
  });

  test('a household being deleted refuses every management operation', async () => {
    await house().update({ deletingAt: new Date(), deletingByUid: owner.uid });
    await refused(renameHousehold(owner, HOUSE, 'Too Late', NOW), 'household_deleting');
    await refused(createInvite(owner, HOUSE, NOW), 'household_deleting');
    await refused(changeMemberRole(owner, HOUSE, member.uid, 'admin', NOW), 'household_deleting');
    await refused(updateMemberPermissions(owner, HOUSE, member.uid, { 'shopping.delete': true }, undefined, NOW), 'household_deleting');
    await refused(removeMember(owner, HOUSE, guest.uid, NOW), 'household_deleting');
    await refused(transferOwnership(owner, HOUSE, admin.uid, NOW), 'household_deleting');
    assert.equal((await audits()).length, 0);
  });
});

describe('invite codes', () => {
  test('the owner creates a single-use 30-minute code that can be redeemed', async () => {
    const invite = await createInvite(owner, HOUSE, NOW);
    assert.match(invite.code, /^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{2}$/);
    assert.equal(invite.id, invite.code);
    assert.equal(invite.expiresAt, '2026-08-01T12:30:00.000Z');
    const stored = (await adminDb.collection('inviteCodes').doc(invite.code).get()).data();
    assert.equal(stored?.householdId, HOUSE);
    assert.equal(stored?.householdName, 'Manage House');
    assert.equal(stored?.createdByUid, owner.uid);
    assert.equal(stored?.createdByEmail, owner.email);
    assert.equal(stored?.maxUses, 1);
    assert.equal(stored?.useCount, 0);
    assert.ok(stored?.expiresAt instanceof Timestamp);
    assert.equal(stored.expiresAt.toDate().toISOString(), '2026-08-01T12:30:00.000Z');
    const [entry] = await audits('invite.generated');
    assertActor(entry, owner);
    assert.deepEqual(entry.details, { code: invite.code });

    const joined = await redeemInvite(stranger, invite.code, NOW);
    assert.equal(joined.member.role, 'newuser');
  });

  test('manageInvites works as ticked: an admin with it unticked is refused, a member with it ticked is allowed', async () => {
    await grant(admin, { 'household.manageInvites': false });
    await refused(createInvite(admin, HOUSE, NOW), 'missing_permission');
    await refused(createInvite(member, HOUSE, NOW), 'missing_permission');
    await refused(createInvite(pending, HOUSE, NOW), 'not_member');
    await refused(createInvite(outsider, HOUSE, NOW), 'not_member');
    assert.equal((await adminDb.collection('inviteCodes').where('householdId', '==', HOUSE).get()).size, 0);

    await grant(member, { 'household.manageInvites': true });
    const invite = await createInvite(member, HOUSE, NOW);
    assert.equal((await adminDb.collection('inviteCodes').doc(invite.code).get()).data()?.createdByUid, member.uid);
    assertActor((await audits('invite.generated'))[0], member);

    await revokeInvite(member, HOUSE, invite.code, NOW);
    assert.equal((await adminDb.collection('inviteCodes').doc(invite.code).get()).data()?.revokedAt, NOW.toISOString());
    await seedInvite('ADMI-NCAN-TX');
    await refused(revokeInvite(admin, HOUSE, 'ADMI-NCAN-TX', NOW), 'missing_permission');
    await refused(revokeAllInvites(admin, HOUSE, NOW), 'missing_permission');
    assert.equal((await adminDb.collection('inviteCodes').doc('ADMI-NCAN-TX').get()).data()?.revokedAt, undefined);
  });

  test('revoking marks the code, logs it once, and cannot touch another household', async () => {
    await seedInvite('REVO-KEME-XX');
    assert.deepEqual(await revokeInvite(admin, HOUSE, 'revo keme xx', NOW), { code: 'REVO-KEME-XX' });
    assert.equal((await adminDb.collection('inviteCodes').doc('REVO-KEME-XX').get()).data()?.revokedAt, NOW.toISOString());
    // A second revoke is a no-op, not a second log entry.
    await revokeInvite(admin, HOUSE, 'REVO-KEME-XX', new Date(NOW.getTime() + 1000));
    const entries = await audits('invite.revoked');
    assert.equal(entries.length, 1);
    assertActor(entries[0], admin);
    assert.deepEqual(entries[0].details, { code: 'REVO-KEME-XX' });
    await refused(redeemInvite(stranger, 'REVO-KEME-XX', NOW), 'failed');

    await seedInvite('OTHE-RHOU-SE', { householdId: OTHER, createdByUid: outsider.uid, createdByEmail: outsider.email });
    await refused(revokeInvite(owner, HOUSE, 'OTHE-RHOU-SE', NOW), 'not_found');
    await refused(revokeInvite(owner, HOUSE, 'NOPE-NOPE-NO', NOW), 'not_found');
    await refused(revokeInvite(owner, HOUSE, 'short', NOW), 'not_found');
    assert.equal((await adminDb.collection('inviteCodes').doc('OTHE-RHOU-SE').get()).data()?.revokedAt, undefined);
  });

  test('revoke all revokes only codes that could still be used', async () => {
    await seedInvite('ACTI-VEON-EX');
    await seedInvite('ACTI-VETW-OX');
    await seedInvite('EXPI-REDX-XX', { expiresAt: Timestamp.fromDate(new Date('2026-08-01T11:59:00.000Z')) });
    await seedInvite('USED-UPXX-XX', { useCount: 1 });
    await seedInvite('GONE-ALRE-DY', { revokedAt: '2026-08-01T11:55:00.000Z' });
    await seedInvite('OTHE-RHOU-SE', { householdId: OTHER });
    assert.deepEqual(await revokeAllInvites(owner, HOUSE, NOW), { count: 2 });
    const revokedAt = async (code: string) => (await adminDb.collection('inviteCodes').doc(code).get()).data()?.revokedAt;
    assert.equal(await revokedAt('ACTI-VEON-EX'), NOW.toISOString());
    assert.equal(await revokedAt('ACTI-VETW-OX'), NOW.toISOString());
    assert.equal(await revokedAt('EXPI-REDX-XX'), undefined);
    assert.equal(await revokedAt('USED-UPXX-XX'), undefined);
    assert.equal(await revokedAt('GONE-ALRE-DY'), '2026-08-01T11:55:00.000Z');
    assert.equal(await revokedAt('OTHE-RHOU-SE'), undefined);
    const [entry] = await audits('invite.revoked_all');
    assertActor(entry, owner);
    assert.deepEqual(entry.details, { count: 2 });
    // Nothing left to revoke: no second entry.
    assert.deepEqual(await revokeAllInvites(owner, HOUSE, NOW), { count: 0 });
    assert.equal((await audits('invite.revoked_all')).length, 1);
  });
});

describe('approve and change role', () => {
  test('an admin approves a pending person as a member', async () => {
    const result = await changeMemberRole(admin, HOUSE, pending.uid, 'member', NOW);
    assert.deepEqual(result, { role: 'member', approved: true });
    const data = await memberData(pending);
    assert.equal(data?.role, 'member');
    assert.equal(data?.status, 'active');
    assert.deepEqual(data?.permissions, {});
    assert.equal(data?.approvedAt, NOW.toISOString());
    assert.equal(data?.approvedByUid, admin.uid);
    assert.equal((await profile(pending))?.role, 'member');
    const [entry] = await audits('member.approved');
    assertActor(entry, admin);
    assert.equal(entry.targetUid, pending.uid);
    assert.equal(entry.targetEmail, pending.email);
    assert.equal(entry.targetName, pending.displayName);
    assert.deepEqual(entry.details, { role: 'member', previousRole: 'newuser' });
    // The email comes from the protected contact document; approval leaves it as it is
    // and never puts an email on the record.
    const contact = (await memberRef(pending).collection('private').doc('contact').get()).data();
    assert.deepEqual(contact, { email: pending.email, updatedAt: SEEDED_CONTACT_AT });
    assert.equal('email' in (data ?? {}), false);
  });

  test('a legacy email on the record is never used: without a contact document there is no email', async () => {
    await memberRef(pending).update({ email: 'legacy.record@example.test' });
    await memberRef(pending).collection('private').doc('contact').delete();
    await changeMemberRole(admin, HOUSE, pending.uid, 'member', NOW);
    const [entry] = await audits('member.approved');
    assert.equal(entry.targetEmail, null);
    assert.equal((await adminDb.collection('users').doc('legacy.record@example.test').get()).exists, false);
  });

  test('a role change of an approved member leaves the contact document alone', async () => {
    await memberRef(member).collection('private').doc('contact').set({ email: member.email, updatedAt: 'before' });
    await changeMemberRole(admin, HOUSE, member.uid, 'guest', NOW);
    assert.equal((await memberRef(member).collection('private').doc('contact').get()).data()?.updatedAt, 'before');
  });

  test('the owner promotes a member to admin and their overrides are reset', async () => {
    await grant(member, { 'shopping.delete': true });
    await adminDb.collection('users').doc(member.email).set({ permissions: { 'shopping.delete': true } }, { merge: true });
    const result = await changeMemberRole(owner, HOUSE, member.uid, 'admin', NOW);
    assert.deepEqual(result, { role: 'admin', approved: false });
    const data = await memberData(member);
    assert.equal(data?.role, 'admin');
    assert.deepEqual(data?.permissions, {});
    const cached = await profile(member);
    assert.equal(cached?.role, 'admin');
    assert.deepEqual(cached?.permissions, {});
    assert.equal(cached?.householdId, HOUSE);
    const [entry] = await audits('member.role_changed');
    assertActor(entry, owner);
    assert.equal(entry.targetUid, member.uid);
    assert.deepEqual(entry.details, { role: 'admin', previousRole: 'member' });
  });

  test('assigning the role someone already has writes nothing', async () => {
    await changeMemberRole(owner, HOUSE, member.uid, 'member', NOW);
    assert.equal((await audits()).length, 0);
  });

  test('every policy refusal leaves the member untouched', async () => {
    // No permission.
    await refused(changeMemberRole(member, HOUSE, pending.uid, 'guest', NOW), 'missing_permission');
    await grant(admin2, { 'household.manageMembers': false });
    await refused(changeMemberRole(admin2, HOUSE, guest.uid, 'member', NOW), 'missing_permission');
    // Equal rank and the owner.
    await refused(changeMemberRole(admin, HOUSE, admin2.uid, 'member', NOW), 'rank');
    await refused(changeMemberRole(admin, HOUSE, owner.uid, 'member', NOW), 'rank');
    // A role at or above the actor's own.
    await refused(changeMemberRole(admin, HOUSE, member.uid, 'admin', NOW), 'role_too_high');
    // Roles nobody can assign.
    await refused(changeMemberRole(owner, HOUSE, member.uid, 'owner', NOW), 'role_not_assignable');
    await refused(changeMemberRole(owner, HOUSE, member.uid, 'newuser', NOW), 'role_not_assignable');
    await refused(changeMemberRole(owner, HOUSE, member.uid, 'emperor' as HouseholdRole, NOW), 'role_not_assignable');
    // Yourself, the owner included (the owner changes only through a transfer).
    await refused(changeMemberRole(admin, HOUSE, admin.uid, 'member', NOW), 'self');
    await refused(changeMemberRole(owner, HOUSE, owner.uid, 'admin', NOW), 'self');
    // People who are not approved members, and targets who are not here.
    await refused(changeMemberRole(pending, HOUSE, guest.uid, 'member', NOW), 'not_member');
    await refused(changeMemberRole(outsider, HOUSE, guest.uid, 'member', NOW), 'not_member');
    await refused(changeMemberRole(owner, HOUSE, outsider.uid, 'member', NOW), 'not_found');

    assert.equal((await memberData(owner))?.role, 'owner');
    assert.equal((await memberData(admin2))?.role, 'admin');
    assert.equal((await memberData(member))?.role, 'member');
    assert.equal((await memberData(guest))?.role, 'guest');
    assert.equal((await memberData(pending))?.role, 'newuser');
    assert.equal((await audits()).length, 0);
  });

  test('a member granted manageMembers approves only below their own rank', async () => {
    await grant(member, { 'household.manageMembers': true });
    await refused(changeMemberRole(member, HOUSE, pending.uid, 'member', NOW), 'role_too_high');
    await refused(changeMemberRole(member, HOUSE, pending.uid, 'admin', NOW), 'role_too_high');
    await refused(changeMemberRole(member, HOUSE, member2.uid, 'guest', NOW), 'rank');
    await refused(changeMemberRole(member, HOUSE, admin.uid, 'guest', NOW), 'rank');
    await changeMemberRole(member, HOUSE, pending.uid, 'guest', NOW);
    assert.equal((await memberData(pending))?.role, 'guest');
    assertActor((await audits('member.approved'))[0], member);
  });
});

describe('edit permissions', () => {
  test('the owner customizes a member; only differences from the role default are stored', async () => {
    await adminDb.collection('users').doc(member.email).set({ permissions: { 'pets.view': false } }, { merge: true });
    const result = await updateMemberPermissions(owner, HOUSE, member.uid,
      { 'shopping.delete': true, 'chores.view': true, 'chores.edit': false }, 'member', NOW);
    assert.deepEqual(result.permissions, { 'shopping.delete': true, 'chores.edit': false });
    assert.deepEqual((await memberData(member))?.permissions, { 'shopping.delete': true, 'chores.edit': false });
    // The profile cache is replaced, not merged with what was there.
    assert.deepEqual((await profile(member))?.permissions, { 'shopping.delete': true, 'chores.edit': false });
    const [entry] = await audits('member.permissions_changed');
    assertActor(entry, owner);
    assert.equal(entry.targetUid, member.uid);
    assert.deepEqual(entry.details, { granted: 'shopping.delete', revoked: 'chores.edit' });
  });

  test('saving what is already stored writes nothing', async () => {
    await updateMemberPermissions(owner, HOUSE, member.uid, {}, 'member', NOW);
    assert.equal((await audits()).length, 0);
  });

  test('guard: nobody edits their own permissions', async () => {
    await refused(updateMemberPermissions(admin, HOUSE, admin.uid, { 'chores.delete': false }, undefined, NOW), 'self');
    await refused(updateMemberPermissions(owner, HOUSE, owner.uid, { 'chores.delete': false }, undefined, NOW), 'self');
    await grant(member, { 'household.manageRoles': true });
    await refused(updateMemberPermissions(member, HOUSE, member.uid, { 'household.manageRoles': true, 'household.manageMembers': true }, undefined, NOW), 'self');
    assert.deepEqual((await memberData(member))?.permissions, { 'household.manageRoles': true });
  });

  test('guard: nobody grants a permission they do not hold, but they may take one away', async () => {
    await grant(admin, { 'shopping.delete': false });
    await refused(updateMemberPermissions(admin, HOUSE, member.uid, { 'shopping.delete': true }, undefined, NOW), 'grant_unheld');
    await refused(updateMemberPermissions(admin, HOUSE, member.uid, { 'chores.delete': true, 'shopping.delete': true }, undefined, NOW), 'grant_unheld');
    assert.deepEqual((await memberData(member))?.permissions, {});

    // The owner gave this member the permission; the admin who lacks it can still remove it.
    await grant(member, { 'shopping.delete': true });
    await updateMemberPermissions(admin, HOUSE, member.uid, {}, undefined, NOW);
    assert.deepEqual((await memberData(member))?.permissions, {});
    const [entry] = await audits('member.permissions_changed');
    assertActor(entry, admin);
    assert.deepEqual(entry.details, { granted: '', revoked: 'shopping.delete' });

    // A member granted manageRoles passes on only what a member holds.
    await grant(member, { 'household.manageRoles': true });
    await refused(updateMemberPermissions(member, HOUSE, guest.uid, { 'household.manageMembers': true }, undefined, NOW), 'grant_unheld');
    await updateMemberPermissions(member, HOUSE, guest.uid, { 'shopping.edit': true }, undefined, NOW);
    assert.deepEqual((await memberData(guest))?.permissions, { 'shopping.edit': true });
  });

  test('an unrelated change is allowed while the target keeps a permission the actor lacks', async () => {
    await grant(admin, { 'shopping.delete': false });
    await grant(member, { 'shopping.delete': true });
    await updateMemberPermissions(admin, HOUSE, member.uid, { 'shopping.delete': true, 'chores.delete': true }, undefined, NOW);
    assert.deepEqual((await memberData(member))?.permissions, { 'shopping.delete': true, 'chores.delete': true });
  });

  test('guard: nobody edits someone at or above their own rank', async () => {
    await refused(updateMemberPermissions(admin, HOUSE, admin2.uid, { 'chores.delete': false }, undefined, NOW), 'rank');
    await refused(updateMemberPermissions(admin, HOUSE, owner.uid, { 'chores.delete': false }, undefined, NOW), 'rank');
    await grant(member, { 'household.manageRoles': true });
    await refused(updateMemberPermissions(member, HOUSE, member2.uid, { 'chores.edit': false }, undefined, NOW), 'rank');
    await refused(updateMemberPermissions(member, HOUSE, admin.uid, { 'chores.edit': false }, undefined, NOW), 'rank');
    assert.deepEqual((await memberData(admin2))?.permissions, {});
    assert.deepEqual((await memberData(member2))?.permissions, {});
  });

  test('the owner-only permissions can never be granted, by anyone', async () => {
    await refused(updateMemberPermissions(owner, HOUSE, admin.uid, { 'household.delete': true }, undefined, NOW), 'owner_only');
    await refused(updateMemberPermissions(owner, HOUSE, admin.uid, { 'household.transferOwnership': true }, undefined, NOW), 'owner_only');
    await refused(updateMemberPermissions(admin, HOUSE, member.uid, { 'household.delete': true }, undefined, NOW), 'owner_only');
    assert.deepEqual((await memberData(admin))?.permissions, {});
    assert.equal((await audits()).length, 0);
  });

  test('other refusals: no permission, pending target, a role that changed, bad input', async () => {
    await refused(updateMemberPermissions(member, HOUSE, guest.uid, { 'shopping.edit': true }, undefined, NOW), 'missing_permission');
    await grant(admin2, { 'household.manageRoles': false });
    await refused(updateMemberPermissions(admin2, HOUSE, guest.uid, { 'shopping.edit': true }, undefined, NOW), 'missing_permission');
    await refused(updateMemberPermissions(owner, HOUSE, pending.uid, { 'chores.view': true }, undefined, NOW), 'target_pending');
    await refused(updateMemberPermissions(pending, HOUSE, guest.uid, { 'chores.view': false }, undefined, NOW), 'not_member');
    await refused(updateMemberPermissions(owner, HOUSE, outsider.uid, { 'chores.view': false }, undefined, NOW), 'not_found');
    // The editor showed a guest column, but the person is a member now.
    await refused(updateMemberPermissions(owner, HOUSE, member.uid, { 'shopping.edit': true }, 'guest', NOW), 'conflict');
    await refused(updateMemberPermissions(owner, HOUSE, member.uid, { 'not.a.permission': true } as PermissionOverrides, undefined, NOW), 'invalid_input');
    await refused(updateMemberPermissions(owner, HOUSE, member.uid, { 'chores.view': 'yes' } as unknown as PermissionOverrides, undefined, NOW), 'invalid_input');
    await refused(updateMemberPermissions(owner, HOUSE, member.uid, null as unknown as PermissionOverrides, undefined, NOW), 'invalid_input');
    assert.deepEqual((await memberData(member))?.permissions, {});
    assert.deepEqual((await memberData(guest))?.permissions, {});
    assert.equal((await audits()).length, 0);
  });
});

describe('remove member', () => {
  test('an admin removes a guest: access gone, open chores unassigned, history kept', async () => {
    await house().collection('chores').doc('open').set({ task: 'Trash', assignedToEmail: guest.email, assignedToDisplayName: 'Gus Guest', isCompleted: false });
    await house().collection('chores').doc('done').set({ task: 'Dishes', assignedToEmail: guest.email, assignedToDisplayName: 'Gus Guest', isCompleted: true });
    await house().collection('chores').doc('theirs').set({ task: 'Mow', assignedToEmail: member.email, isCompleted: false });
    await house().collection('chore-templates').doc('recurring').set({ task: 'Trash', assignedToEmail: guest.email, recurrence: { frequency: 'daily', assignedToEmail: guest.email } });
    await house().collection('chore-templates').doc('plain').set({ task: 'Sweep', assignedToEmail: guest.email });

    await memberRef(guest).collection('private').doc('contact').set({ email: guest.email, updatedAt: 'x' });
    assert.deepEqual(await removeMember(admin, HOUSE, guest.uid, NOW), { denied: false });
    assert.equal((await memberRef(guest).get()).exists, false);
    assert.equal((await memberRef(guest).collection('private').doc('contact').get()).exists, false);
    const data = (await house().get()).data();
    // A legacy list loses the removed member's email; nothing else is written to it.
    assert.ok(!data?.memberEmails.includes(guest.email));
    assert.ok(data?.memberEmails.includes(member.email));
    assert.equal(data?.updatedAt, NOW.toISOString());
    const cached = await profile(guest);
    assert.equal(cached?.householdId, null);
    assert.equal(cached?.role, 'member');
    assert.deepEqual(cached?.permissions, {});

    const open = (await house().collection('chores').doc('open').get()).data();
    assert.equal(open?.assignedToEmail, undefined, 'no email is left on an unassigned chore');
    assert.equal(open?.assignedToUid, '');
    assert.equal(open?.assignedToDisplayName, 'Unassigned');
    const done = (await house().collection('chores').doc('done').get()).data();
    assert.equal(done?.assignedToEmail, guest.email, 'completed chores keep who did them');
    assert.equal(done?.assignedToDisplayName, 'Gus Guest');
    assert.equal((await house().collection('chores').doc('theirs').get()).data()?.assignedToEmail, member.email);
    const recurring = (await house().collection('chore-templates').doc('recurring').get()).data();
    assert.equal(recurring?.assignedToEmail, undefined);
    assert.deepEqual(recurring?.recurrence, { frequency: 'daily' });
    const plain = (await house().collection('chore-templates').doc('plain').get()).data();
    assert.equal(plain?.assignedToEmail, undefined);
    assert.equal(plain?.recurrence, undefined);

    const [entry] = await audits('member.removed');
    assertActor(entry, admin);
    assert.equal(entry.targetUid, guest.uid);
    assert.equal(entry.targetEmail, guest.email);
    assert.equal(entry.targetName, guest.displayName);
    assert.equal(entry.details, undefined);
  });

  test('removal unassigns chores and templates assigned by uid too', async () => {
    await house().collection('chores').doc('by-uid').set({ task: 'Trash', assignedToUid: guest.uid, assignedToEmail: '', isCompleted: false });
    await house().collection('chores').doc('moved').set({ task: 'Moved', assignedToUid: guest.uid, assignedToEmail: member.email, isCompleted: false });
    await house().collection('chore-templates').doc('by-uid').set({ task: 'Sweep', assignedToUid: guest.uid, assignedToEmail: guest.email, recurrence: { frequency: 'daily', assignedToEmail: guest.email } });
    await removeMember(admin, HOUSE, guest.uid, NOW);
    const chore = (await house().collection('chores').doc('by-uid').get()).data();
    assert.equal(chore?.assignedToUid, '');
    assert.equal(chore?.assignedToDisplayName, 'Unassigned');
    assert.equal((await house().collection('chores').doc('moved').get()).data()?.assignedToEmail, member.email, 'an older build moved it to someone else');
    const template = (await house().collection('chore-templates').doc('by-uid').get()).data();
    assert.equal(template?.assignedToUid, undefined);
    assert.equal(template?.assignedToEmail, undefined);
    assert.deepEqual(template?.recurrence, { frequency: 'daily' });
  });

  test('a household without the legacy email list gets none on removal', async () => {
    await house().update({ memberEmails: FieldValue.delete(), ownerEmail: FieldValue.delete() });
    await removeMember(admin, HOUSE, guest.uid, NOW);
    const data = (await house().get()).data();
    assert.equal('memberEmails' in (data || {}), false);
    assert.equal('ownerEmail' in (data || {}), false);
  });

  test('denying a pending request removes it and says so in the log', async () => {
    assert.deepEqual(await removeMember(admin, HOUSE, pending.uid, NOW), { denied: true });
    assert.equal((await memberRef(pending).get()).exists, false);
    assert.equal((await profile(pending))?.householdId, null);
    const [entry] = await audits('member.removed');
    assertActor(entry, admin);
    assert.deepEqual(entry.details, { pending: true });
  });

  test('a profile that points at another household is left alone', async () => {
    await adminDb.collection('users').doc(guest.email).set({ email: guest.email, householdId: OTHER, role: 'member', permissions: {} });
    await removeMember(owner, HOUSE, guest.uid, NOW);
    const cached = await profile(guest);
    assert.equal(cached?.householdId, OTHER);
  });

  test('the owner, equals, yourself and people without the permission are refused', async () => {
    await refused(removeMember(admin, HOUSE, owner.uid, NOW), 'rank');
    await refused(removeMember(admin, HOUSE, admin2.uid, NOW), 'rank');
    await refused(removeMember(admin, HOUSE, admin.uid, NOW), 'self');
    await refused(removeMember(owner, HOUSE, owner.uid, NOW), 'self');
    await refused(removeMember(member, HOUSE, guest.uid, NOW), 'missing_permission');
    await refused(removeMember(guest, HOUSE, pending.uid, NOW), 'missing_permission');
    await refused(removeMember(pending, HOUSE, guest.uid, NOW), 'not_member');
    await refused(removeMember(outsider, HOUSE, guest.uid, NOW), 'not_member');
    await refused(removeMember(owner, HOUSE, outsider.uid, NOW), 'not_found');
    await grant(member, { 'household.manageMembers': true });
    await refused(removeMember(member, HOUSE, member2.uid, NOW), 'rank');
    await refused(removeMember(member, HOUSE, admin.uid, NOW), 'rank');
    for (const person of [owner, admin, admin2, member2, guest, pending]) {
      assert.equal((await memberRef(person).get()).exists, true, person.uid);
    }
    assert.equal((await audits()).length, 0);
    // The granted member can remove someone below them.
    await removeMember(member, HOUSE, guest.uid, NOW);
    assert.equal((await memberRef(guest).get()).exists, false);
  });
});

describe('transfer ownership and delete', () => {
  test('the owner hands the household to a member and becomes an admin', async () => {
    await grant(member, { 'shopping.delete': true });
    assert.deepEqual(await transferOwnership(owner, HOUSE, member.uid, NOW), { ownerUid: member.uid });
    const data = (await house().get()).data();
    assert.equal(data?.ownerUid, member.uid);
    // No email on the household document (member privacy release C): the legacy one is removed.
    assert.equal('ownerEmail' in (data || {}), false);
    assert.equal(data?.updatedAt, NOW.toISOString());
    const next = await memberData(member);
    assert.equal(next?.role, 'owner');
    assert.equal(next?.status, 'active');
    assert.deepEqual(next?.permissions, {});
    const previous = await memberData(owner);
    assert.equal(previous?.role, 'admin');
    assert.deepEqual(previous?.permissions, {});
    assert.equal((await profile(member))?.role, 'owner');
    assert.equal((await profile(owner))?.role, 'admin');
    // Exactly one owner record.
    assert.equal((await house().collection('members').where('role', '==', 'owner').get()).size, 1);

    const [entry] = await audits('ownership.transferred');
    assertActor(entry, owner);
    assert.equal(entry.targetUid, member.uid);
    assert.equal(entry.targetEmail, member.email);

    const notes = await house().collection('notifications').where('sourceType', '==', 'household-ownership-transfer').get();
    assert.equal(notes.size, 1);
    const note = notes.docs[0].data();
    assert.equal(note.message, 'Mel Member is now the owner of Manage House.');
    assert.equal(note.sourceId, member.uid);
    assert.equal(note.deepLink, '/household');
    assert.equal(note.targetUserUid, undefined, 'the transfer notice goes to the whole household');
    assert.ok(note.createdAt instanceof Timestamp && note.expiresAt instanceof Timestamp);

    // The previous owner is an admin now and cannot take it back.
    await refused(transferOwnership(owner, HOUSE, owner.uid, NOW), 'owner_only');
    await refused(transferOwnership(owner, HOUSE, admin.uid, NOW), 'owner_only');
  });

  test('only the owner can transfer, whatever overrides are stored', async () => {
    await grant(admin, { 'household.transferOwnership': true, 'household.delete': true });
    await refused(transferOwnership(admin, HOUSE, admin.uid, NOW), 'owner_only');
    await refused(transferOwnership(admin, HOUSE, member.uid, NOW), 'owner_only');
    await refused(transferOwnership(member, HOUSE, member.uid, NOW), 'owner_only');
    await refused(transferOwnership(pending, HOUSE, pending.uid, NOW), 'owner_only');
    await refused(transferOwnership(outsider, HOUSE, guest.uid, NOW), 'not_member');
    await refused(transferOwnership(owner, HOUSE, owner.uid, NOW), 'self');
    await refused(transferOwnership(owner, HOUSE, pending.uid, NOW), 'target_pending');
    await refused(transferOwnership(owner, HOUSE, outsider.uid, NOW), 'not_found');
    const data = (await house().get()).data();
    assert.equal(data?.ownerUid, owner.uid);
    assert.equal((await memberData(owner))?.role, 'owner');
    assert.equal((await memberData(admin))?.role, 'admin');
    assert.equal((await audits()).length, 0);
    assert.equal((await house().collection('notifications').get()).size, 0);
  });

  test('only the owner can delete, whatever overrides are stored', async () => {
    await grant(admin, { 'household.delete': true });
    await assert.rejects(deleteHousehold(admin, HOUSE, 'Manage House'), (error: unknown) => {
      assert.ok(error instanceof MembershipError);
      assert.match(error.userMessage, /Only the household owner/);
      return true;
    });
    await assert.rejects(deleteHousehold(member, HOUSE, 'Manage House'), MembershipError);
    assert.equal((await house().get()).data()?.deletingAt, undefined);
  });
});

describe('concurrent changes', () => {
  test('a role change racing a permission edit never leaves overrides from the old role', async () => {
    // The owner promotes a member to admin while an admin edits that member's permissions.
    // Each transaction re-reads the member: either the edit lands first and the promotion
    // resets it, or the promotion lands first and the edit is refused (equal rank).
    const [promotion, edit] = await Promise.allSettled([
      changeMemberRole(owner, HOUSE, member.uid, 'admin', NOW),
      updateMemberPermissions(admin, HOUSE, member.uid, { 'shopping.delete': true }, 'member', NOW),
    ]);
    assert.equal(promotion.status, 'fulfilled');
    const data = await memberData(member);
    assert.equal(data?.role, 'admin');
    assert.deepEqual(data?.permissions, {});
    if (edit.status === 'rejected') {
      assert.ok(edit.reason instanceof MembershipError);
      assert.ok(['rank', 'conflict'].includes(edit.reason.code), edit.reason.code);
      assert.equal((await audits('member.permissions_changed')).length, 0);
    } else {
      assert.equal((await audits('member.permissions_changed')).length, 1);
    }
    assert.equal((await audits('member.role_changed')).length, 1);
  });

  test('two people removing the same member: one removal, one log entry', async () => {
    const outcomes = await Promise.allSettled([
      removeMember(owner, HOUSE, guest.uid, NOW),
      removeMember(admin, HOUSE, guest.uid, NOW),
    ]);
    assert.equal(outcomes.filter(o => o.status === 'fulfilled').length, 1);
    const failed = outcomes.find(o => o.status === 'rejected') as PromiseRejectedResult;
    assert.ok(failed.reason instanceof MembershipError);
    assert.equal(failed.reason.code, 'not_found');
    assert.equal((await audits('member.removed')).length, 1);
  });

  test('a demoted actor loses what the old role allowed', async () => {
    // The owner demotes an admin to guest; afterwards that person's removal of a member is refused.
    await changeMemberRole(owner, HOUSE, admin.uid, 'guest', NOW);
    await refused(removeMember(admin, HOUSE, member.uid, NOW), 'missing_permission');
    assert.equal((await memberRef(member).get()).exists, true);
  });
});
