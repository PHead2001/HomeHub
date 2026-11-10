import assert from 'node:assert/strict';
import { after, beforeEach, describe, test } from 'node:test';
import { adminDb } from '../../src/lib/server/firebase-admin';
import {
  MembershipError,
  createHousehold,
  remindPendingMembers,
  type MembershipErrorCode,
  type VerifiedCaller,
} from '../../src/lib/server/household-membership';
import { getDeterministicNotificationId } from '../../src/lib/notifications';
import { PENDING_REMINDER_SOURCE_TYPE, pendingReminderStateKey } from '../../src/lib/household-records';
import type { HouseholdRole, PermissionOverrides } from '../../src/lib/types';

// Household creation and the daily pending-member reminder through the real
// Admin SDK path, against the Firestore emulator. Pure helpers are unit-tested in
// tests/unit/household-records.test.ts.
const NOW = new Date('2026-08-01T12:00:00.000Z');
const HOUSE = 'server-records-house';
const OTHER = 'server-records-other';

const creator: VerifiedCaller = { uid: 'rc-creator', email: 'rc.creator@example.test', displayName: 'Cora Creator', avatarUrl: 'https://example.test/c.png' };
const owner: VerifiedCaller = { uid: 'rc-owner', email: 'rc.owner@example.test', displayName: 'Olive Owner' };
const admin: VerifiedCaller = { uid: 'rc-admin', email: 'rc.admin@example.test', displayName: 'Adam Admin' };
const member: VerifiedCaller = { uid: 'rc-member', email: 'rc.member@example.test', displayName: 'Mel Member' };
const pending: VerifiedCaller = { uid: 'rc-pending', email: 'rc.pending@example.test', displayName: 'Pat Pending' };
const pending2: VerifiedCaller = { uid: 'rc-pending2', email: 'rc.pending2@example.test' };
const outsider: VerifiedCaller = { uid: 'rc-outsider', email: 'rc.outsider@example.test' };
const everyone = [creator, owner, admin, member, pending, pending2, outsider];

const house = (id = HOUSE) => adminDb.collection('households').doc(id);
const memberRef = (person: VerifiedCaller, id = HOUSE) => house(id).collection('members').doc(person.uid);
const profile = async (person: VerifiedCaller) => (await adminDb.collection('users').doc(person.email).get()).data();

const seedMember = (person: VerifiedCaller, role: HouseholdRole, extra: Record<string, unknown> = {}, householdId = HOUSE) =>
  memberRef(person, householdId).set({
    uid: person.uid,
    email: person.email,
    ...(person.displayName ? { displayName: person.displayName } : {}),
    role,
    status: role === 'newuser' ? 'pending' : 'active',
    permissions: {} as PermissionOverrides,
    joinedAt: '2026-07-01T00:00:00.000Z',
    ...extra,
  });

const createdHouseholds = async (person: VerifiedCaller) =>
  (await adminDb.collection('households').where('ownerUid', '==', person.uid).get()).docs;

const clear = async () => {
  for (const id of [HOUSE, OTHER]) await adminDb.recursiveDelete(house(id));
  for (const d of await createdHouseholds(creator)) await adminDb.recursiveDelete(d.ref);
  await Promise.all(everyone.map(u => adminDb.collection('users').doc(u.email).delete()));
};

beforeEach(async () => {
  await clear();
  await house().set({ name: 'Records House', ownerUid: owner.uid, ownerEmail: owner.email, memberEmails: [owner.email] });
  await seedMember(owner, 'owner');
  await seedMember(admin, 'admin');
  await seedMember(member, 'member');
  await seedMember(pending, 'newuser');
  await house(OTHER).set({ name: 'Other House', ownerUid: outsider.uid, ownerEmail: outsider.email, memberEmails: [outsider.email] });
  await seedMember(outsider, 'owner', {}, OTHER);
});

after(clear);

const refused = (promise: Promise<unknown>, code: MembershipErrorCode) => assert.rejects(promise, (error: unknown) => {
  assert.ok(error instanceof MembershipError, `expected MembershipError, got ${String(error)}`);
  assert.equal(error.code, code, error.userMessage);
  assert.ok(error.userMessage.length > 5);
  return true;
});

describe('create household', () => {
  test('writes the household, owner membership, profile pointer and activity entry together', async () => {
    await adminDb.collection('users').doc(creator.email).set({ email: creator.email, uid: creator.uid, displayName: 'Cora C.', role: 'member', householdId: null });
    const result = await createHousehold(creator, { name: '  Maple Street  ', timeZone: 'America/New_York' }, NOW);
    const id = result.household.id;
    assert.match(id, /^maple-street-[a-z0-9]{4}$/);
    assert.equal(result.household.name, 'Maple Street');

    const data = (await house(id).get()).data();
    assert.deepEqual(data, {
      name: 'Maple Street',
      ownerUid: creator.uid,
      ownerEmail: creator.email,
      memberEmails: [creator.email],
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
      timeZone: 'America/New_York',
    });
    const owned = (await memberRef(creator, id).get()).data();
    assert.equal(owned?.role, 'owner');
    assert.equal(owned?.status, 'active');
    assert.equal(owned?.approvedByUid, creator.uid);
    // The name chosen in the HomeHub profile wins over the token's.
    assert.equal(owned?.displayName, 'Cora C.');
    assert.equal(owned?.avatarUrl, creator.avatarUrl);
    assert.deepEqual(result.member, owned);

    const cache = await profile(creator);
    assert.equal(cache?.householdId, id);
    assert.equal(cache?.role, 'owner');
    assert.deepEqual(cache?.permissions, {});
    assert.equal(cache?.displayName, 'Cora C.', 'other profile fields are kept');

    const entries = (await house(id).collection('auditLogs').get()).docs.map(d => d.data());
    assert.equal(entries.length, 1);
    assert.equal(entries[0].action, 'household.created');
    assert.equal(entries[0].actorUid, creator.uid);
    assert.equal(entries[0].actorEmail, creator.email);
    assert.equal(entries[0].actorName, 'Cora C.');
    assert.equal(entries[0].createdAt, NOW.toISOString());
    assert.deepEqual(entries[0].details, { householdName: 'Maple Street' });
  });

  test('a photo removed in Profile stays removed; with no avatarUrl field the token photo is used', async () => {
    await adminDb.collection('users').doc(creator.email).set({ email: creator.email, uid: creator.uid, avatarUrl: null, householdId: null });
    const cleared = await createHousehold(creator, { name: 'No Photo' }, NOW);
    assert.equal('avatarUrl' in ((await memberRef(creator, cleared.household.id).get()).data() || {}), false);
    assert.equal('avatarUrl' in cleared.member, false);

    await adminDb.recursiveDelete(house(cleared.household.id));
    await adminDb.collection('users').doc(creator.email).set({ email: creator.email, uid: creator.uid, householdId: null });
    const missing = await createHousehold(creator, { name: 'Token Photo' }, NOW);
    assert.equal((await memberRef(creator, missing.household.id).get()).data()?.avatarUrl, creator.avatarUrl);

    await adminDb.recursiveDelete(house(missing.household.id));
    await adminDb.collection('users').doc(creator.email).set({ email: creator.email, uid: creator.uid, avatarUrl: 'https://example.test/chosen.png', householdId: null });
    const chosen = await createHousehold(creator, { name: 'Chosen Photo' }, NOW);
    assert.equal((await memberRef(creator, chosen.household.id).get()).data()?.avatarUrl, 'https://example.test/chosen.png');
  });

  test('an invalid or missing time zone is left out', async () => {
    const result = await createHousehold(creator, { name: 'Zoneless', timeZone: 'Not/AZone' }, NOW);
    assert.equal('timeZone' in ((await house(result.household.id).get()).data() || {}), false);
  });

  test('a name with no usable letters gets the default slug', async () => {
    const result = await createHousehold(creator, { name: '!!!' }, NOW);
    assert.match(result.household.id, /^household-[a-z0-9]{4}$/);
  });

  test('an empty, blank, over-long or non-string name is refused and nothing is written', async () => {
    for (const name of ['', '   ', 'x'.repeat(81), 42, null]) {
      await refused(createHousehold(creator, { name }, NOW), 'invalid_input');
    }
    assert.equal((await createdHouseholds(creator)).length, 0);
    assert.equal(await profile(creator), undefined);
  });

  test('80 characters is allowed', async () => {
    const result = await createHousehold(creator, { name: 'y'.repeat(80) }, NOW);
    assert.equal(result.household.name.length, 80);
  });

  test('someone still in a household cannot create another', async () => {
    await adminDb.collection('users').doc(member.email).set({ email: member.email, uid: member.uid, householdId: HOUSE, role: 'member' });
    await refused(createHousehold(member, { name: 'Second Home' }, NOW), 'conflict');
    assert.equal((await createdHouseholds(member)).length, 0);
    assert.equal((await profile(member))?.householdId, HOUSE);
    // A pending request counts too: the person is waiting on another household.
    await adminDb.collection('users').doc(pending.email).set({ email: pending.email, uid: pending.uid, householdId: HOUSE, role: 'newuser' });
    await refused(createHousehold(pending, { name: 'Elsewhere' }, NOW), 'conflict');
  });

  test('a stale profile pointer (no membership record) does not block creation', async () => {
    await adminDb.collection('users').doc(creator.email).set({ email: creator.email, uid: creator.uid, householdId: OTHER, role: 'member' });
    const result = await createHousehold(creator, { name: 'Fresh Start' }, NOW);
    assert.equal((await profile(creator))?.householdId, result.household.id);
    // The other household is untouched.
    assert.equal((await memberRef(creator, OTHER).get()).exists, false);
  });

  test('two creations at once leave the person in exactly one household', async () => {
    const results = await Promise.allSettled([
      createHousehold(creator, { name: 'Race One' }, NOW),
      createHousehold(creator, { name: 'Race Two' }, NOW),
    ]);
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
    const rejected = results.find(r => r.status === 'rejected') as PromiseRejectedResult | undefined;
    assert.ok(rejected && rejected.reason instanceof MembershipError && rejected.reason.code === 'conflict');
    const owned = await createdHouseholds(creator);
    assert.equal(owned.length, 1);
    assert.equal((await profile(creator))?.householdId, owned[0].id);
  });
});

describe('pending-member reminder', () => {
  const notifications = async () => (await house().collection('notifications').get()).docs;
  const stamp = async (person: VerifiedCaller) => (await memberRef(person).get()).get('lastNewUserReminderAt');

  test('stamps the pending person and writes one household-wide notification with an audience', async () => {
    assert.deepEqual(await remindPendingMembers(owner, HOUSE, NOW), { count: 1 });
    assert.equal(await stamp(pending), NOW.toISOString());
    const docs = await notifications();
    assert.equal(docs.length, 1);
    const expectedId = getDeterministicNotificationId({
      sourceType: PENDING_REMINDER_SOURCE_TYPE,
      sourceId: pending.uid,
      stateKey: pendingReminderStateKey(NOW),
    });
    assert.equal(docs[0].id, expectedId, 'same ID an older browser would write for this person and day');
    const data = docs[0].data();
    assert.deepEqual(data.audience, ['*']);
    assert.equal(data.category, 'system');
    assert.equal(data.householdId, HOUSE);
    assert.equal(data.message, 'Pat Pending still needs a household role.');
    assert.equal(data.deepLink, '/household?tab=members');
    assert.equal(data.sourceType, PENDING_REMINDER_SOURCE_TYPE);
    assert.equal(data.sourceId, pending.uid);
    assert.equal(data.targetUserUid, undefined);
    assert.equal(data.createdAt.toDate().toISOString(), NOW.toISOString());
    assert.ok(data.expiresAt.toMillis() > NOW.getTime());
    // Approved members are never stamped.
    assert.equal(await stamp(member), undefined);
  });

  test('nobody is reminded about twice within 24 hours; after 24 hours they are again', async () => {
    await remindPendingMembers(admin, HOUSE, NOW);
    const later = new Date(NOW.getTime() + 23 * 60 * 60 * 1000);
    assert.deepEqual(await remindPendingMembers(owner, HOUSE, later), { count: 0 });
    assert.equal(await stamp(pending), NOW.toISOString());
    assert.equal((await notifications()).length, 1);
    const nextDay = new Date(NOW.getTime() + 24 * 60 * 60 * 1000);
    assert.deepEqual(await remindPendingMembers(owner, HOUSE, nextDay), { count: 1 });
    assert.equal(await stamp(pending), nextDay.toISOString());
    assert.equal((await notifications()).length, 2);
  });

  test('only people who are due are reminded; a missing name is never replaced by the email', async () => {
    await memberRef(pending).update({ lastNewUserReminderAt: new Date(NOW.getTime() - 60 * 60 * 1000).toISOString() });
    await seedMember(pending2, 'newuser');
    assert.deepEqual(await remindPendingMembers(owner, HOUSE, NOW), { count: 1 });
    const [doc] = await notifications();
    assert.equal(doc.data().sourceId, pending2.uid);
    assert.equal(doc.data().message, 'A member still needs a household role.');
    assert.ok(!doc.data().message.includes(pending2.email));
  });

  test('no pending people: nothing is written', async () => {
    await memberRef(pending).delete();
    assert.deepEqual(await remindPendingMembers(owner, HOUSE, NOW), { count: 0 });
    assert.equal((await notifications()).length, 0);
  });

  test('without household.manageMembers it is refused; with the permission granted it is allowed', async () => {
    await refused(remindPendingMembers(member, HOUSE, NOW), 'missing_permission');
    await refused(remindPendingMembers(pending, HOUSE, NOW), 'not_member');
    await refused(remindPendingMembers(outsider, HOUSE, NOW), 'not_member');
    assert.equal(await stamp(pending), undefined);
    assert.equal((await notifications()).length, 0);

    await memberRef(admin).update({ permissions: { 'household.manageMembers': false } });
    await refused(remindPendingMembers(admin, HOUSE, NOW), 'missing_permission');

    await memberRef(member).update({ permissions: { 'household.manageMembers': true } });
    assert.deepEqual(await remindPendingMembers(member, HOUSE, NOW), { count: 1 });
  });

  test('refused for a household being deleted or one that does not exist', async () => {
    await house().update({ deletingAt: new Date() });
    await refused(remindPendingMembers(owner, HOUSE, NOW), 'household_deleting');
    await refused(remindPendingMembers(owner, 'no-such-house', NOW), 'not_found');
    await refused(remindPendingMembers(owner, 'bad/id', NOW), 'invalid_input');
  });
});
