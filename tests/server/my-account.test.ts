import assert from 'node:assert/strict';
import { after, beforeEach, describe, test } from 'node:test';
import { adminDb } from '../../src/lib/server/firebase-admin';
import { exportMyData } from '../../src/lib/server/my-account';
import type { VerifiedCaller } from '../../src/lib/server/household-membership';

// Account controls (audit PR-26) against the Firestore emulator.
const NOW = new Date('2026-08-01T12:00:00.000Z');
const HOUSE = 'server-account-house';
const me: VerifiedCaller = { uid: 'account-me', email: 'account.me@example.test', displayName: 'Me' };
const other: VerifiedCaller = { uid: 'account-other', email: 'account.other@example.test' };

const house = () => adminDb.collection('households').doc(HOUSE);
const profile = (user: VerifiedCaller) => adminDb.collection('users').doc(user.email);

const clear = async () => {
  await adminDb.recursiveDelete(house());
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
