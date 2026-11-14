import assert from 'node:assert/strict';
import { after, beforeEach, describe, test } from 'node:test';
import { Timestamp } from 'firebase-admin/firestore';
import { adminAuth, adminDb } from '../../src/lib/server/firebase-admin';
import { createChildIdentity, removeChildIdentity, updateChildIdentity } from '../../src/lib/server/child-identities';
import { MembershipError, changeMemberRole, deleteHousehold, removeMember, transferOwnership } from '../../src/lib/server/household-membership';
import { setChildPin } from '../../src/lib/server/pins';
import { createChildIdentityAction, removeChildIdentityAction, updateChildIdentityAction } from '../../src/app/household/child-actions';
import { buildNotificationDocument } from '../../src/lib/notifications';
import { readMemberContacts, runHouseholdReminders } from '../../functions/src/reminders';
import { withContactEmails } from '../../functions/src/shared/member-contact';
import { selectRecipientEmails } from '../../functions/src/push-policy';
import { personToken, seedHousehold, type Person } from './device-test-helpers';
import { house } from './device-actor-helpers';

// Kid profiles (child identities; docs/modules/devices/README.md, "Actors"; HO-15a-c,
// D-T9): create/update/remove authority, the record shape, no sign-in possible, every
// consumer change of design 6.2 (role change, ownership transfer, removal routing, PIN
// documents, push recipients, chore reminders, targeted notices).

const H = 'kids-house';
const owner: Person = { uid: 'k-owner', email: 'k.owner@example.test', displayName: 'Olive', role: 'owner' };
const admin: Person = { uid: 'k-admin', email: 'k.admin@example.test', displayName: 'Ada', role: 'admin' };
const member: Person = { uid: 'k-member', email: 'k.member@example.test', displayName: 'Max', role: 'member' };
const manager: Person = { uid: 'k-manager', email: 'k.manager@example.test', displayName: 'Mo', role: 'member', permissions: { 'household.manageMembers': true } };

const membershipErr = async (promise: Promise<unknown>, code: string) => {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof MembershipError, `expected MembershipError(${code}), got ${String(error)}`);
    assert.equal(error.code, code);
    return true;
  });
};

const kidRecord = async (uid: string) => (await house(H).collection('members').doc(uid).get()).data();

beforeEach(async () => {
  await seedHousehold(H, [owner, admin, member, manager]);
  for (const person of [owner, admin, member]) {
    await house(H).collection('members').doc(person.uid).collection('private').doc('contact').set({ email: person.email, updatedAt: '2026-11-01T00:00:00.000Z' });
  }
});

after(async () => {
  await adminDb.recursiveDelete(house(H));
});

describe('create, update, remove', () => {
  test('owners and admins create a kid profile: a member record with kind identity, role Child, no email, no Auth user', async () => {
    const { childId, name } = await createChildIdentity(admin, { householdId: H, name: '  Mia  ' });
    assert.match(childId, /^kid_[A-Za-z0-9]{20}$/);
    assert.equal(name, 'Mia');
    const record = await kidRecord(childId);
    assert.equal(record?.kind, 'identity');
    assert.equal(record?.role, 'child');
    assert.equal(record?.status, 'active');
    assert.equal(record?.uid, childId);
    assert.equal(record?.createdByUid, admin.uid);
    assert.ok(!JSON.stringify(record).includes('@'));
    assert.equal((await house(H).collection('members').doc(childId).collection('private').doc('contact').get()).exists, false);
    await assert.rejects(adminAuth.getUser(childId), (error: unknown) => (error as { code?: string }).code === 'auth/user-not-found');
    const audit = await house(H).collection('auditLogs').where('action', '==', 'child.created').get();
    assert.equal(audit.docs[0]?.get('targetUid'), childId);
  });

  test('members (even with manageMembers), bad names and tablet tokens are refused', async () => {
    await membershipErr(createChildIdentity(member, { householdId: H, name: 'Mia' }), 'missing_permission');
    await membershipErr(createChildIdentity(manager, { householdId: H, name: 'Mia' }), 'missing_permission');
    await membershipErr(createChildIdentity(owner, { householdId: H, name: '' }), 'invalid_input');
    await membershipErr(createChildIdentity(owner, { householdId: H, name: 'mia@example.com' }), 'invalid_input');
    const viaAction = await createChildIdentityAction({ idToken: await personToken(owner), householdId: H, name: 'Noa' });
    assert.ok(viaAction.ok);
    const outcome = await createChildIdentityAction({ idToken: 'not-a-token', householdId: H, name: 'Mia' });
    assert.equal(outcome.ok ? 'ok' : outcome.code, 'unauthenticated');
  });

  test('update: name and a photo from the kid profile folder only', async () => {
    const { childId } = await createChildIdentity(owner, { householdId: H, name: 'Mia' });
    assert.deepEqual((await updateChildIdentity(admin, { householdId: H, childId, name: 'Mila' })).changed, ['name']);
    const path = `households/${H}/members/${childId}/avatar/a.png`;
    const bucket = process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET!;
    const url = `https://firebasestorage.googleapis.com/v0/b/${bucket}/o/${encodeURIComponent(path)}?alt=media`;
    assert.deepEqual((await updateChildIdentity(admin, { householdId: H, childId, avatarUrl: url })).changed, ['photo']);
    assert.equal((await kidRecord(childId))?.avatarUrl, url);
    const elsewhere = `https://firebasestorage.googleapis.com/v0/b/${bucket}/o/${encodeURIComponent(`households/other/members/${childId}/avatar/a.png`)}`;
    // Another bucket, even with the right path, is refused (security review 8).
    const otherBucket = `https://firebasestorage.googleapis.com/v0/b/someone-else.appspot.com/o/${encodeURIComponent(path)}?alt=media`;
    await membershipErr(updateChildIdentity(admin, { householdId: H, childId, avatarUrl: otherBucket }), 'invalid_input');
    await membershipErr(updateChildIdentity(admin, { householdId: H, childId, avatarUrl: elsewhere }), 'invalid_input');
    await membershipErr(updateChildIdentity(admin, { householdId: H, childId, avatarUrl: 'https://evil.example/a.png' }), 'invalid_input');
    await membershipErr(updateChildIdentity(member, { householdId: H, childId, name: 'X' }), 'missing_permission');
    // An account is not a kid profile.
    await membershipErr(updateChildIdentity(admin, { householdId: H, childId: member.uid, name: 'X' }), 'not_found');
    const outcome = await updateChildIdentityAction({ idToken: 'x', householdId: H, childId, name: 'Y' });
    assert.equal(outcome.ok ? 'ok' : outcome.code, 'unauthenticated');
  });

  test('remove: open chores unassigned, completed history kept, PIN documents gone', async () => {
    const { childId } = await createChildIdentity(owner, { householdId: H, name: 'Mia' });
    await setChildPin(owner, { householdId: H, childId, pin: '9314' });
    await house(H).collection('chores').doc('open').set({ task: 'Feed fish', assignedToUid: childId, assignedToDisplayName: 'Mia', isCompleted: false });
    await house(H).collection('chores').doc('done').set({ task: 'Tidy', assignedToUid: childId, isCompleted: true, completedByUid: childId, completedByName: 'Mia' });
    await house(H).collection('chore-templates').doc('t').set({ task: 'Fish', assignedToUid: childId, recurrence: { frequency: 'daily' } });
    await membershipErr(removeChildIdentity(member, { householdId: H, childId }), 'missing_permission');
    assert.deepEqual(await removeChildIdentity(admin, { householdId: H, childId }), { removed: true });
    assert.equal(await kidRecord(childId), undefined);
    assert.equal((await house(H).collection('members').doc(childId).collection('private').doc('pin').get()).exists, false);
    assert.equal((await house(H).collection('chores').doc('open').get()).get('assignedToUid'), '');
    assert.equal((await house(H).collection('chores').doc('done').get()).get('completedByUid'), childId);
    assert.equal((await house(H).collection('chore-templates').doc('t').get()).get('assignedToUid'), undefined);
    assert.equal((await house(H).collection('auditLogs').where('action', '==', 'child.removed').get()).size, 1);
    const outcome = await removeChildIdentityAction({ idToken: 'x', householdId: H, childId });
    assert.equal(outcome.ok ? 'ok' : outcome.code, 'unauthenticated');
  });
});

describe('consumers (design 6.2)', () => {
  test('role change and ownership transfer are refused for a kid profile', async () => {
    const { childId } = await createChildIdentity(owner, { householdId: H, name: 'Mia' });
    await membershipErr(changeMemberRole(owner, H, childId, 'member'), 'identity_fixed_role');
    await membershipErr(transferOwnership(owner, H, childId), 'target_identity');
    assert.equal((await kidRecord(childId))?.role, 'child');
  });

  test('removeMember routes a kid profile to the kid-profile body with its authority (owner or admin role)', async () => {
    const { childId } = await createChildIdentity(owner, { householdId: H, name: 'Mia' });
    await setChildPin(owner, { householdId: H, childId, pin: '9314' });
    await membershipErr(removeMember(manager, H, childId), 'missing_permission');
    assert.ok(await kidRecord(childId));
    await removeMember(admin, H, childId);
    assert.equal(await kidRecord(childId), undefined);
    assert.equal((await house(H).collection('members').doc(childId).collection('private').doc('pin').get()).exists, false);
    assert.equal((await house(H).collection('auditLogs').where('action', '==', 'child.removed').get()).size, 1);
    assert.equal((await house(H).collection('auditLogs').where('action', '==', 'member.removed').get()).size, 0);
  });

  test('push: a kid profile in a household-wide audience causes no contact lookup error and gets nothing', async () => {
    const { childId } = await createChildIdentity(owner, { householdId: H, name: 'Mia' });
    const records = (await house(H).collection('members').get()).docs.map(d => ({ uid: d.id, ...d.data() }));
    const contacts = await readMemberContacts(house(H) as never, records.map(r => r.uid), []);
    const members = withContactEmails(records as never, contacts);
    const recipients = selectRecipientEmails(members as never, { audience: ['*'], category: 'chores' });
    assert.deepEqual(recipients.sort(), [admin.email, member.email, owner.email].sort());
    assert.ok(records.some(r => r.uid === childId));
  });

  test('no targeted notice ever names a kid profile: the builder refuses, reminders skip them', async () => {
    const { childId } = await createChildIdentity(owner, { householdId: H, name: 'Mia' });
    assert.throws(() => buildNotificationDocument({ householdId: H, category: 'chores', message: 'x', targetUser: { uid: childId } }));
    assert.ok(buildNotificationDocument({ householdId: H, category: 'chores', message: 'x', targetUser: { uid: member.uid } }));
    const now = new Date('2026-11-05T15:00:00Z');
    await house(H).collection('chores').doc('kid-chore').set({
      task: 'Feed fish', assignedToUid: childId, assignedToDisplayName: 'Mia', isCompleted: false, dueDate: '2026-11-01T05:00:00.000Z',
    });
    await runHouseholdReminders(adminDb as never, H, now, ((d: Date) => Timestamp.fromDate(d)) as never);
    const notices = await house(H).collection('notifications').get();
    assert.ok(notices.docs.every(d => d.get('targetUserUid') !== childId && !(d.get('audience') ?? []).includes(childId)));
  });

  test('household deletion removes kid profiles and their PIN documents', async () => {
    const { childId } = await createChildIdentity(owner, { householdId: H, name: 'Mia' });
    await setChildPin(owner, { householdId: H, childId, pin: '9314' });
    await deleteHousehold(owner, H, `House ${H}`);
    assert.equal(await kidRecord(childId), undefined);
    assert.equal((await house(H).collection('members').doc(childId).collection('private').doc('pin').get()).exists, false);
  });
});
