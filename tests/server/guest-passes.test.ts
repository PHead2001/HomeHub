import assert from 'node:assert/strict';
import { after, beforeEach, describe, test } from 'node:test';
import { Timestamp } from 'firebase-admin/firestore';
import { adminDb } from '../../src/lib/server/firebase-admin';
import { createTabletGuestPass } from '../../src/lib/server/guest-passes';
import { MembershipError, changeMemberRole, expireGuestPasses, removeMember, transferOwnership } from '../../src/lib/server/household-membership';
import { checkActorEligible } from '../../src/lib/server/device-gate';
import { rosterFrom } from '../../src/lib/devices/roster';
import { personToken, seedHousehold, type Person } from './device-test-helpers';
import { authorizeHouseholdAction } from '../../src/ai/action-auth';
import { setMyPin } from '../../src/lib/server/pins';
import { sweepEndedGuestPasses } from '../../functions/src/guest-pass-sweep';
import { house } from './device-actor-helpers';

// Tablet guest passes (audit HO-24, WT-21; src/lib/server/guest-passes.ts): a temporary
// face with no account, allowed only what the pass says, until `accessUntil`.

const H = 'guest-pass-house';
const owner: Person = { uid: 'gp-owner', email: 'gp.owner@example.test', displayName: 'Olive', role: 'owner' };
const admin: Person = { uid: 'gp-admin', email: 'gp.admin@example.test', displayName: 'Ada', role: 'admin' };
const member: Person = { uid: 'gp-member', email: 'gp.member@example.test', displayName: 'Max', role: 'member' };
const manager: Person = { uid: 'gp-manager', email: 'gp.manager@example.test', displayName: 'Mo', role: 'member', permissions: { 'household.manageMembers': true } };

const NOW = new Date();
const HOUR = 60 * 60 * 1000;

const refused = async (promise: Promise<unknown>, code: string) => {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof MembershipError, `expected MembershipError(${code}), got ${String(error)}`);
    assert.equal(error.code, code);
    return true;
  });
};

const record = (uid: string) => house(H).collection('members').doc(uid).get();

beforeEach(async () => {
  await adminDb.recursiveDelete(house(H));
  await seedHousehold(H, [owner, admin, member, manager]);
});

after(async () => {
  await adminDb.recursiveDelete(house(H));
});

describe('tablet guest passes (HO-24, WT-21)', () => {
  test('an admin adds one: an identity with role Guest, only the chosen abilities, ending within the pass', async () => {
    const pass = await createTabletGuestPass(admin, { householdId: H, name: ' Babysitter ', hours: 4, feedPets: true, tickChores: false }, NOW);
    assert.match(pass.guestId, /^guest_[A-Za-z0-9]{20}$/);
    const data = (await record(pass.guestId)).data();
    assert.equal(data?.kind, 'identity');
    assert.equal(data?.role, 'guest');
    assert.equal(data?.displayName, 'Babysitter');
    assert.deepEqual(data?.permissions, { 'pets.addLogs': true });
    assert.equal(data?.accessUntil.toMillis(), NOW.getTime() + 4 * HOUR);
    assert.equal((await house(H).collection('members').doc(pass.guestId).collection('private').doc('contact').get()).exists, false);
    const audit = (await house(H).collection('auditLogs').where('action', '==', 'guest.created').get()).docs[0]?.data();
    assert.equal(audit?.targetUid, pass.guestId);
  });

  test('only owners and admins; names, lengths and abilities are checked', async () => {
    await refused(createTabletGuestPass(member, { householdId: H, name: 'Sitter', hours: 4, feedPets: true }, NOW), 'missing_permission');
    await refused(createTabletGuestPass(manager, { householdId: H, name: 'Sitter', hours: 4, feedPets: true }, NOW), 'missing_permission');
    await refused(createTabletGuestPass(owner, { householdId: H, name: 'a@b.co', hours: 4, feedPets: true }, NOW), 'invalid_input');
    await refused(createTabletGuestPass(owner, { householdId: H, name: 'Sitter', hours: 3, feedPets: true }, NOW), 'invalid_input');
    await refused(createTabletGuestPass(owner, { householdId: H, name: 'Sitter', hours: 4 }, NOW), 'invalid_input');
  });

  test('the tablet gate accepts a running pass and refuses it once it ends; an account guest is never a face', async () => {
    const pass = await createTabletGuestPass(owner, { householdId: H, name: 'Walker', hours: 24, tickChores: true }, NOW);
    const actor = checkActorEligible(pass.guestId, await record(pass.guestId));
    assert.equal(actor.role, 'guest');
    assert.equal(actor.kind, 'identity');
    assert.equal(actor.permissions['chores.complete'], true);
    assert.equal(actor.permissions['pets.addLogs'], false);
    assert.equal(actor.permissions['chores.edit'], false);

    await house(H).collection('members').doc(pass.guestId).update({ accessUntil: Timestamp.fromMillis(Date.now() - 1000) });
    assert.throws(() => checkActorEligible(pass.guestId, null));
    assert.throws(() => checkActorEligible(pass.guestId, { exists: true, data: () => ({ role: 'guest', kind: 'identity', status: 'active', accessUntil: Timestamp.fromMillis(Date.now() - 1000) }) } as unknown as FirebaseFirestore.DocumentSnapshot));

    assert.throws(() => checkActorEligible('acct-guest', { exists: true, data: () => ({ role: 'guest', status: 'active' }) } as unknown as FirebaseFirestore.DocumentSnapshot));
  });

  test('"Who\'s here?" lists a running pass after the family and drops it when it ends', () => {
    const at = NOW.getTime();
    const roster = rosterFrom([
      { id: 'u-adult', data: { role: 'member', displayName: 'Max' } },
      { id: 'kid_ABCDEFGHIJKLMNOPQRST', data: { role: 'child', kind: 'identity', displayName: 'Mia' } },
      { id: 'guest_ABCDEFGHIJKLMNOPQRST', data: { role: 'guest', kind: 'identity', displayName: 'Sitter', accessUntil: Timestamp.fromMillis(at + HOUR) } },
      { id: 'guest_ZYXWVUTSRQPONMLKJIHG', data: { role: 'guest', kind: 'identity', displayName: 'Gone', accessUntil: Timestamp.fromMillis(at - HOUR) } },
      { id: 'acct-guest', data: { role: 'guest', displayName: 'Account guest' } },
    ], at);
    assert.deepEqual(roster.map(p => p.name), ['Max', 'Mia', 'Sitter']);
  });

  test('a pass is never given a role, never becomes owner, and Remove or the sweep ends it', async () => {
    const pass = await createTabletGuestPass(owner, { householdId: H, name: 'Sitter', hours: 4, feedPets: true }, NOW);
    await refused(changeMemberRole(owner, H, pass.guestId, 'member', NOW), 'identity_fixed_role');
    await refused(transferOwnership(owner, H, pass.guestId, NOW), 'target_identity');
    await removeMember(admin, H, pass.guestId, NOW);
    assert.equal((await record(pass.guestId)).exists, false);
    assert.equal((await house(H).collection('auditLogs').where('action', '==', 'guest.removed').get()).size, 1);

    const second = await createTabletGuestPass(owner, { householdId: H, name: 'Walker', hours: 4, tickChores: true }, NOW);
    assert.deepEqual(await expireGuestPasses(member, H, new Date(NOW.getTime() + 3 * HOUR)), { count: 0 });
    assert.deepEqual(await expireGuestPasses(member, H, new Date(NOW.getTime() + 5 * HOUR)), { count: 1 });
    assert.equal((await record(second.guestId)).exists, false);
    const ended = (await house(H).collection('auditLogs').where('action', '==', 'member.guest_pass_ended').get()).docs[0]?.data();
    assert.equal(ended?.targetUid, second.guestId);
    assert.equal(ended?.details?.tablet, true);
  });
});

describe('an ended account guest pass is refused by every server path (HO-14 review)', () => {
  const visitor: Person = { uid: 'gp-visitor', email: 'gp.visitor@example.test', displayName: 'Vee', role: 'guest' };
  const setPass = (ms: number) => house(H).collection('members').doc(visitor.uid).set({
    uid: visitor.uid, role: 'guest', status: 'active', displayName: 'Vee', permissions: { 'shopping.edit': true },
    accessUntil: Timestamp.fromMillis(Date.now() + ms),
  });

  test('authorizeHouseholdAction (AI, shopping, chores, maintenance, pets actions) serves a running pass and refuses an ended one', async () => {
    const idToken = await personToken(visitor);
    await setPass(HOUR);
    const user = await authorizeHouseholdAction({ idToken, householdId: H }, 'shopping.edit');
    assert.equal(user.permissions['shopping.edit'], true);
    await setPass(-1000);
    await assert.rejects(authorizeHouseholdAction({ idToken, householdId: H }, 'shopping.edit'));
    await assert.rejects(authorizeHouseholdAction({ idToken, householdId: H }, 'chores.view'));
    await assert.rejects(authorizeHouseholdAction({ idToken, householdId: H }));
  });

  test('tablet PINs treat an ended pass as not a member', async () => {
    await setPass(-1000);
    await assert.rejects(setMyPin(visitor, { householdId: H, pin: '4826' }), (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'not_member');
      return true;
    });
  });

  test('the hourly upkeep sweep removes ended passes (account and tablet) and keeps running ones', async () => {
    await setPass(-1000);
    const memberRef = house(H).collection('members').doc(visitor.uid);
    await memberRef.collection('private').doc('contact').set({ email: visitor.email, updatedAt: NOW.toISOString() });
    await adminDb.collection('users').doc(visitor.email).set({ email: visitor.email, householdId: H, role: 'guest' });
    await house(H).collection('chores').doc('vee-open').set({ task: 'Water plants', assignedToUid: visitor.uid, isCompleted: false });
    const running = await createTabletGuestPass(owner, { householdId: H, name: 'Walker', hours: 4, tickChores: true }, NOW);
    const ended = await createTabletGuestPass(owner, { householdId: H, name: 'Sitter', hours: 4, feedPets: true }, NOW);
    await house(H).collection('members').doc(ended.guestId).update({ accessUntil: Timestamp.fromMillis(Date.now() - 1000) });

    assert.equal(await sweepEndedGuestPasses(adminDb, H, new Date()), 2);
    assert.equal((await memberRef.get()).exists, false);
    assert.equal((await memberRef.collection('private').doc('contact').get()).exists, false);
    assert.equal((await adminDb.collection('users').doc(visitor.email).get()).get('householdId'), null);
    assert.equal((await house(H).collection('chores').doc('vee-open').get()).get('assignedToUid'), '');
    assert.equal((await record(ended.guestId)).exists, false);
    assert.equal((await record(running.guestId)).exists, true);
    const logs = (await house(H).collection('auditLogs').where('action', '==', 'member.guest_pass_ended').get()).docs.map(d => d.data());
    assert.equal(logs.length, 2);
    assert.ok(logs.every(log => log.actorUid === null && log.details?.by === 'upkeep'));
    // A second run finds nothing.
    assert.equal(await sweepEndedGuestPasses(adminDb, H, new Date()), 0);
    await adminDb.collection('users').doc(visitor.email).delete();
  });
});
