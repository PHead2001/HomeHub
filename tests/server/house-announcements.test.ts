import assert from 'node:assert/strict';
import { after, beforeEach, describe, test } from 'node:test';
import { adminDb } from '../../src/lib/server/firebase-admin';
import { HouseAnnouncementError, postHouseAnnouncement } from '../../src/lib/server/house-announcements';
import type { VerifiedCaller } from '../../src/lib/server/household-membership';

// NO-25 "Message the house" against the Firestore emulator: only active owners and admins
// (by role) post; the notice is household-wide, carries no email, is silent unless a push
// was asked for, and is logged.
const HOUSE = 'house-message-house';
const NOW = new Date('2026-11-13T18:00:00Z');
const owner: VerifiedCaller = { uid: 'hm-owner', email: 'hm.owner@example.test', displayName: 'Olive Owner' };
const admin: VerifiedCaller = { uid: 'hm-admin', email: 'hm.admin@example.test', displayName: 'adam@example.test' };
const member: VerifiedCaller = { uid: 'hm-member', email: 'hm.member@example.test', displayName: 'Mel' };
const guest: VerifiedCaller = { uid: 'hm-guest', email: 'hm.guest@example.test' };
const pending: VerifiedCaller = { uid: 'hm-pending', email: 'hm.pending@example.test' };
const house = () => adminDb.collection('households').doc(HOUSE);
const post = (caller: VerifiedCaller, fields: Record<string, unknown> = {}) =>
  postHouseAnnouncement(caller, { householdId: HOUSE, message: 'Dinner at 6', hours: 12, push: false, ...fields }, NOW);
const refused = async (work: Promise<unknown>, code: string) => {
  await assert.rejects(work, (error: unknown) => error instanceof HouseAnnouncementError && error.code === code);
};

beforeEach(async () => {
  await adminDb.recursiveDelete(house());
  await house().set({ name: 'Messages', ownerUid: owner.uid, timeZone: 'America/Chicago' });
  for (const [person, role] of [[owner, 'owner'], [admin, 'admin'], [member, 'member'], [guest, 'guest'], [pending, 'newuser']] as const) {
    await house().collection('members').doc(person.uid).set({
      uid: person.uid, role, status: role === 'newuser' ? 'pending' : 'active', permissions: {},
      ...(person.displayName ? { displayName: person.displayName } : {}),
    });
  }
});

after(async () => {
  await adminDb.recursiveDelete(house());
});

describe('message the house (NO-25)', () => {
  test('an owner posts a household-wide notice that expires and is not pushed unless asked', async () => {
    const result = await post(owner);
    const data = (await house().collection('notifications').doc(result.id).get()).data()!;
    assert.equal(data.category, 'general');
    assert.equal(data.sourceType, 'house-announcement');
    assert.deepEqual(data.audience, ['*']);
    assert.equal(data.title, 'House message from Olive Owner');
    assert.equal(data.message, 'Dinner at 6');
    assert.equal(data.createdByUid, owner.uid);
    assert.equal(data.silent, true);
    assert.equal(data.expiresAt.toMillis(), NOW.getTime() + 12 * 3600_000);
    assert.equal(result.expiresAt, new Date(NOW.getTime() + 12 * 3600_000).toISOString());
    const logs = (await house().collection('auditLogs').get()).docs.map((d) => d.data());
    assert.equal(logs.length, 1);
    assert.equal(logs[0].action, 'household.message_posted');
    assert.equal(JSON.stringify(logs).includes('@'), false, 'no email in the activity entry');
  });

  test('with a push requested it is not silent; an email-like name is never shown', async () => {
    const result = await post(admin, { push: true, hours: 2 });
    const data = (await house().collection('notifications').doc(result.id).get()).data()!;
    assert.equal('silent' in data, false);
    assert.equal(data.title, 'House message');
    assert.equal(JSON.stringify(data).includes('@'), false);
  });

  test('members, guests, pending people and outsiders are refused', async () => {
    await refused(post(member), 'forbidden');
    await refused(post(guest), 'forbidden');
    await refused(post(pending), 'not_member');
    await refused(post({ uid: 'stranger', email: 's@example.test' }), 'not_member');
    assert.equal((await house().collection('notifications').get()).size, 0);
  });

  test('bad input and a household being deleted are refused', async () => {
    await refused(post(owner, { message: '   ' }), 'invalid_input');
    await refused(post(owner, { message: 'x'.repeat(201) }), 'invalid_input');
    await refused(post(owner, { hours: 1000 }), 'invalid_input');
    await refused(post(owner, { push: 'yes' }), 'invalid_input');
    await refused(postHouseAnnouncement(owner, { householdId: 'bad/id', message: 'x', hours: 12, push: false }, NOW), 'not_found');
    await house().update({ deletingAt: new Date() });
    await refused(post(owner), 'household_deleting');
  });
});
