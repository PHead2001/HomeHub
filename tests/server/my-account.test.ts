import assert from 'node:assert/strict';
import { after, beforeEach, describe, test } from 'node:test';
import { adminDb } from '../../src/lib/server/firebase-admin';
import { adminAuth, adminStorageBucket } from '../../src/lib/server/firebase-admin';
import { deleteMyAccount, exportMyData } from '../../src/lib/server/my-account';
import { MembershipError, type VerifiedCaller } from '../../src/lib/server/household-membership';

// Account controls (audit PR-26) against the Firestore emulator.
const NOW = new Date('2026-08-01T12:00:00.000Z');
const HOUSE = 'server-account-house';
const SECOND = 'server-account-second';
const me: VerifiedCaller = { uid: 'account-me', email: 'account.me@example.test', displayName: 'Me' };
const other: VerifiedCaller = { uid: 'account-other', email: 'account.other@example.test' };

const house = () => adminDb.collection('households').doc(HOUSE);
const profile = (user: VerifiedCaller) => adminDb.collection('users').doc(user.email);

const clear = async () => {
  await adminDb.recursiveDelete(house());
  await adminDb.recursiveDelete(adminDb.collection('households').doc(SECOND));
  await adminDb.recursiveDelete(profile(me));
  await adminDb.recursiveDelete(profile(other));
};

beforeEach(async () => {
  await clear();
  await house().set({ name: 'Account House', ownerUid: other.uid, timeZone: 'America/Chicago' });
  await house().collection('members').doc(other.uid).set({ uid: other.uid, role: 'owner', status: 'active', displayName: 'Other' });
  await house().collection('members').doc(other.uid).collection('private').doc('contact').set({ email: other.email, updatedAt: 'x' });
  await house().collection('members').doc(me.uid).set({ uid: me.uid, role: 'member', status: 'active', displayName: 'Me', color: 3 });
  await house().collection('members').doc(me.uid).collection('private').doc('contact').set({ email: me.email, updatedAt: 'x' });
  await profile(me).set({ email: me.email, uid: me.uid, displayName: 'Me', householdId: HOUSE, role: 'member', fcmTokens: ['legacy-token'] });
  await profile(me).collection('private').doc('push').set({ fcmTokens: ['t1', 't2'] });
  await profile(other).set({ email: other.email, uid: other.uid, displayName: 'Other', householdId: HOUSE, role: 'owner' });
  await house().collection('chores').doc('mine').set({ task: 'Dishes', assignedToUid: me.uid, isCompleted: false, dueDate: '2026-08-01T05:00:00.000Z' });
  await house().collection('chores').doc('done').set({ task: 'Trash', assignedToUid: other.uid, completedByUid: me.uid, isCompleted: true });
  await house().collection('chores').doc('theirs').set({ task: 'Laundry', assignedToUid: other.uid, isCompleted: false });
  await house().collection('notifications').doc('n-me').set({ title: 'Reminder', message: 'Hi', targetUserUid: me.uid, audience: [me.uid] });
  await house().collection('notifications').doc('n-other').set({ title: 'Private', message: 'Not yours', targetUserUid: other.uid, audience: [other.uid] });
});

after(clear);

describe('download my data (PR-26)', () => {
  test('contains only the caller\'s own data, without push tokens or anyone\'s email', async () => {
    const data = await exportMyData(me, NOW);
    assert.equal(data.account.uid, me.uid);
    assert.equal(data.profile?.displayName, 'Me');
    assert.equal('fcmTokens' in (data.profile ?? {}), false);
    assert.equal(data.pushDevices, 2);
    assert.equal(data.household?.name, 'Account House');
    assert.equal(data.household?.membership.color, 3);
    assert.deepEqual(data.choresAssigned.map((c) => c.id), ['mine']);
    assert.deepEqual(data.choresCompleted.map((c) => c.id), ['done']);
    assert.deepEqual(data.notifications.map((n) => n.id), ['n-me']);
    const text = JSON.stringify(data);
    assert.ok(!text.includes(other.email));
    assert.ok(!text.includes('legacy-token') && !text.includes('"t1"'));
    assert.ok(!text.includes('Not yours'));
  });

  test('someone without a household gets their profile only', async () => {
    await profile(me).update({ householdId: null });
    const data = await exportMyData(me, NOW);
    assert.equal(data.household, null);
    assert.deepEqual(data.choresAssigned, []);
  });
});

const ensureAuthUser = async (user: VerifiedCaller) => {
  try {
    await adminAuth.createUser({ uid: user.uid, email: user.email });
  } catch (error) {
    if ((error as { code?: string }).code !== 'auth/uid-already-exists') throw error;
  }
};
const authUserExists = async (uid: string) => adminAuth.getUser(uid).then(() => true, () => false);

describe('delete my account (PR-26)', () => {
  test('a member leaves through leaveHousehold, then profile, push tokens, photos and sign-in go', async () => {
    await ensureAuthUser(me);
    const bucket = adminStorageBucket();
    if (bucket) await bucket.file(`users/${me.uid}/avatars/a.jpg`).save(Buffer.from('x'), { contentType: 'image/jpeg' });
    const result = await deleteMyAccount(me, NOW);
    assert.equal(result.leftHousehold, true);
    assert.equal((await house().collection('members').doc(me.uid).get()).exists, false);
    assert.equal((await house().collection('members').doc(me.uid).collection('private').doc('contact').get()).exists, false);
    assert.equal((await profile(me).get()).exists, false);
    assert.equal((await profile(me).collection('private').doc('push').get()).exists, false);
    assert.equal(await authUserExists(me.uid), false);
    // Open chores were unassigned; finished history stays.
    assert.equal((await house().collection('chores').doc('mine').get()).get('assignedToUid'), '');
    assert.equal((await house().collection('chores').doc('done').get()).get('completedByUid'), me.uid);
    // Owners and admins are told.
    const notes = await house().collection('notifications').where('sourceType', '==', 'household-member-left').get();
    assert.deepEqual(notes.docs.map((d) => d.get('targetUserUid')), [other.uid]);
    if (bucket) {
      const [files] = await bucket.getFiles({ prefix: `users/${me.uid}/avatars/` });
      assert.equal(files.length, 0);
    }
  });

  test('running it again after a partial failure finishes without errors', async () => {
    await ensureAuthUser(me);
    await deleteMyAccount(me, NOW);
    const again = await deleteMyAccount(me, NOW);
    assert.equal(again.leftHousehold, false);
  });

  test('an owner is refused until the household is handed on or deleted; nothing is removed', async () => {
    await ensureAuthUser(other);
    await assert.rejects(deleteMyAccount(other, NOW), (error: unknown) => {
      assert.ok(error instanceof MembershipError);
      assert.match(error.userMessage, /Make someone else the owner first/);
      return true;
    });
    // Alone with only a kid profile: delete the household first.
    await house().collection('members').doc(me.uid).delete();
    await house().collection('members').doc('kid_aaaaaaaaaaaaaaaaaaaa').set({ uid: 'kid_aaaaaaaaaaaaaaaaaaaa', role: 'child', status: 'active', kind: 'identity' });
    await assert.rejects(deleteMyAccount(other, NOW), /Delete the household first/);
    assert.equal((await profile(other).get()).exists, true);
    assert.equal(await authUserExists(other.uid), true);
    await adminAuth.deleteUser(other.uid);
  });

  test('a cleared household pointer does not hide a membership: it is found by uid and left', async () => {
    await ensureAuthUser(me);
    await profile(me).update({ householdId: null });
    const result = await deleteMyAccount(me, NOW);
    assert.equal(result.householdsLeft, 1);
    assert.equal((await profile(me).get()).exists, false);
    assert.equal((await house().collection('members').doc(me.uid).get()).exists, false);
  });

  test('an owner who cleared their own household pointer is still refused (security review)', async () => {
    await ensureAuthUser(other);
    // The rules let a person set their own users/{email}.householdId to null.
    await profile(other).update({ householdId: null, role: 'member', permissions: {} });
    await assert.rejects(deleteMyAccount(other, NOW), (error: unknown) => {
      assert.ok(error instanceof MembershipError);
      assert.equal(error.code, 'conflict');
      assert.match(error.userMessage, /Make someone else the owner first/);
      return true;
    });
    assert.equal((await house().collection('members').doc(other.uid).get()).get('role'), 'owner');
    assert.equal((await profile(other).get()).exists, true);
    assert.equal(await authUserExists(other.uid), true);
    await adminDb.recursiveDelete(profile(other));
    await assert.rejects(deleteMyAccount(other, NOW), /Make someone else the owner first/);
    assert.equal(await authUserExists(other.uid), true);
    await adminAuth.deleteUser(other.uid);
  });

  test('owning a second household the profile does not point at refuses deletion and changes nothing', async () => {
    await ensureAuthUser(me);
    const second = adminDb.collection('households').doc(SECOND);
    await second.set({ name: 'Second', ownerUid: me.uid });
    await second.collection('members').doc(me.uid).set({ uid: me.uid, role: 'owner', status: 'active' });
    await second.collection('members').doc(other.uid).set({ uid: other.uid, role: 'member', status: 'active' });
    await assert.rejects(deleteMyAccount(me, NOW), /Make someone else the owner first/);
    // Nothing was left first: the pointed-at membership is untouched.
    assert.equal((await house().collection('members').doc(me.uid).get()).exists, true);
    assert.equal((await profile(me).get()).exists, true);
    await adminAuth.deleteUser(me.uid);
  });

  test('every household that lists the caller as a member is left, not only the pointed-at one', async () => {
    await ensureAuthUser(me);
    const second = adminDb.collection('households').doc(SECOND);
    await second.set({ name: 'Second', ownerUid: other.uid });
    await second.collection('members').doc(other.uid).set({ uid: other.uid, role: 'owner', status: 'active' });
    await second.collection('members').doc(me.uid).set({ uid: me.uid, role: 'member', status: 'active' });
    const result = await deleteMyAccount(me, NOW);
    assert.equal(result.householdsLeft, 2);
    assert.equal((await house().collection('members').doc(me.uid).get()).exists, false);
    assert.equal((await second.collection('members').doc(me.uid).get()).exists, false);
    assert.equal(await authUserExists(me.uid), false);
  });
});
