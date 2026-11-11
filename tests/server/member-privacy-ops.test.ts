import assert from 'node:assert/strict';
import { after, beforeEach, describe, test } from 'node:test';
import { adminDb } from '../../src/lib/server/firebase-admin';
import { choreStatsAssigneeKey, choreStatsMemberKey } from '../../functions/src/shared/ids';
import { summarizeChores } from '../../src/lib/dashboard/wrapped';
import { creditedPerson } from '../../functions/src/shared/chore-stats';
import {
  hasLegacyKeys,
  householdLegacyKeys,
  householdStats,
  readHouseholdPeople,
  rekeyHouseholdStats,
  scrubChoreCollection,
  settleHouseholdFormerPeople,
} from '../../scripts/ops/member-privacy-household.mjs';

// Release D's ops steps (scripts/ops/rekey-chore-stats.mjs and
// scripts/ops/scrub-member-emails.mjs run exactly these per household) against
// the Firestore emulator: one identity per person who has left, whichever runs first.
const HOUSE = 'privacy-ops-house';
const house = () => adminDb.collection('households').doc(HOUSE);
const LEE = 'lee@example.test';
const db = adminDb as never;

const rekey = async (apply: boolean) => {
  const stats = await householdStats(house());
  if (!hasLegacyKeys(stats)) return { written: 0 };
  const people = await readHouseholdPeople(db, house());
  const former = await settleHouseholdFormerPeople(db, house(), people, { apply, needSecret: true });
  return rekeyHouseholdStats(db, stats, { apply, byLegacy: householdLegacyKeys(people, former), unknownKeyOf: former.unknownKeyOf });
};

const scrub = async (apply: boolean) => {
  const people = await readHouseholdPeople(db, house());
  const former = await settleHouseholdFormerPeople(db, house(), people, { apply });
  const stats = await rekeyHouseholdStats(db, await householdStats(house()), { apply, byLegacy: householdLegacyKeys(people, former) });
  const counts = { scanned: 0, clean: 0, kept: 0, scrub: 0, assignee: 0, completer: 0, former: 0, written: 0, changed: 0 };
  await scrubChoreCollection(db, house().collection('chores'), { apply, uidByEmail: people.uidByEmail, formerKeyOf: former.identityOf, counts });
  await scrubChoreCollection(db, house().collection('chore-templates'), { apply, uidByEmail: people.uidByEmail, formerKeyOf: former.identityOf, counts });
  return { stats: stats.written, chores: counts.written, kept: counts.kept };
};

// Home Wrapped for 2026, as a member sees it (no emails).
const wrapped = async () => {
  const stats = (await house().collection('stats').doc('chores-2026').get()).data();
  const retained = (await house().collection('chores').get()).docs.map(d => ({ id: d.id, ...d.data() }));
  return { stats, summary: summarizeChores(retained, 2026, { stats, timeZone: 'America/Chicago', people: [{ uid: 'o1' }], names: new Map([['o1', 'Owner']]) }) };
};

const leeChore = (index: number, extra: Record<string, unknown> = {}) => ({
  task: `Lee ${index}`, isCompleted: true, completedAt: `2026-10-0${index}T12:00:00.000Z`,
  assignedToEmail: LEE, assignedToDisplayName: 'Lee', ...extra,
});

beforeEach(async () => {
  await adminDb.recursiveDelete(house());
  await house().set({ name: 'Ops', ownerUid: 'o1', timeZone: 'America/Chicago' });
  await house().collection('members').doc('o1').set({ uid: 'o1', role: 'owner', status: 'active', displayName: 'Owner' });
  await house().collection('members').doc('o1').collection('private').doc('contact').set({ email: 'owner@example.test', updatedAt: 'x' });
  // Lee has left: six completions already archived under the legacy email key, five still stored.
  await house().collection('stats').doc('chores-2026').set({
    year: 2026, completed: 6, byAssignee: { [choreStatsAssigneeKey(LEE)]: 6 }, names: { [choreStatsAssigneeKey(LEE)]: 'Lee' },
  });
  for (let index = 1; index <= 5; index += 1) await house().collection('chores').doc(`lee-${index}`).set(leeChore(index));
  // The owner, still a member, has three.
  for (let index = 1; index <= 3; index += 1) {
    await house().collection('chores').doc(`owner-${index}`).set({ task: `Owner ${index}`, isCompleted: true, completedAt: `2026-10-0${index}T13:00:00.000Z`, assignedToUid: 'o1', completedByUid: 'o1' });
  }
});

after(async () => {
  await adminDb.recursiveDelete(house());
});

const assertOneScore = async (identityKey?: string) => {
  const { stats, summary } = await wrapped();
  assert.deepEqual(summary.champion, { name: 'Lee', count: 11 }, '6 archived + 5 retained are one score');
  assert.equal(summary.choresDone, 14);
  const keys = Object.keys(stats?.byAssignee ?? {});
  assert.equal(keys.length, 1);
  if (identityKey) assert.equal(keys[0], identityKey);
  assert.ok(!JSON.stringify(stats).includes(choreStatsAssigneeKey(LEE)), 'no legacy key is left');
  const retained = (await house().collection('chores').get()).docs.filter(d => d.id.startsWith('lee-')).map(d => d.data());
  assert.ok(retained.every(c => c.assignedToEmail === undefined && c.completedByEmail === undefined));
  assert.ok(retained.every(c => choreStatsMemberKey(creditedPerson(c, [{ uid: 'o1' }])?.uid ?? '') === keys[0]));
  return keys[0];
};

describe('release D ops: one identity per person who has left', () => {
  test('re-key then scrub: archived and retained completions are one score; re-runs write nothing', async () => {
    // Dry runs write nothing.
    assert.equal((await rekey(false)).written, 0);
    assert.deepEqual(await scrub(false), { stats: 0, chores: 0, kept: 0 });
    assert.equal((await house().collection('ops').doc('former-members').get()).exists, false);
    assert.equal((await wrapped()).summary.champion?.count, 6, 'unchanged by the dry runs');

    assert.equal((await rekey(true)).written, 1);
    assert.deepEqual(await scrub(true), { stats: 0, chores: 5, kept: 0 });
    const key = await assertOneScore();
    assert.match(key, /^uid-former-[0-9a-f]{24}$/);
    assert.equal((await rekey(true)).written, 0);
    assert.deepEqual(await scrub(true), { stats: 0, chores: 0, kept: 0 });
    const ops = (await house().collection('ops').doc('former-members').get()).data();
    assert.ok(!JSON.stringify(ops).includes('@'), 'the stored decisions hold no email');
  });

  test('scrub then re-key gives the same single score', async () => {
    assert.deepEqual(await scrub(true), { stats: 1, chores: 5, kept: 0 });
    await assertOneScore();
    assert.equal((await rekey(true)).written, 0, 'nothing left for the re-key');
  });

  test('a scrub stopped after the stats and resumed later keeps the identity it stored', async () => {
    // First run: identities settled and stats re-keyed, then stopped before any chore.
    const people = await readHouseholdPeople(db, house());
    const former = await settleHouseholdFormerPeople(db, house(), people, { apply: true });
    await rekeyHouseholdStats(db, await householdStats(house()), { apply: true, byLegacy: householdLegacyKeys(people, former) });
    const statsKey = Object.keys((await house().collection('stats').doc('chores-2026').get()).data()?.byAssignee ?? {})[0];
    // Meanwhile the evidence changed (a chore pairing Lee's email with a uid appeared): the stored decision still wins.
    await house().collection('chores').doc('lee-1').update({ assignedToUid: 'uid-lee' });
    assert.deepEqual(await scrub(true), { stats: 0, chores: 5, kept: 0 });
    assert.equal(await assertOneScore(), statsKey);
  });

  test('an email paired with exactly one uid is that uid, in the stats and on every chore', async () => {
    await house().collection('chores').doc('lee-2').update({ assignedToUid: 'uid-lee' });
    await house().collection('chores').doc('lee-3').update({ completedByEmail: LEE, completedByUid: 'uid-lee' });
    await rekey(true);
    await scrub(true);
    const key = await assertOneScore(choreStatsMemberKey('uid-lee'));
    assert.equal(key, choreStatsMemberKey('uid-lee'));
  });

  test('an email paired with two uids keeps the opaque key, everywhere', async () => {
    await house().collection('chores').doc('lee-2').update({ assignedToUid: 'uid-lee' });
    await house().collection('chores').doc('lee-4').update({ assignedToUid: 'uid-other' });
    await scrub(true);
    await rekey(true);
    const key = await assertOneScore();
    assert.match(key, /^uid-former-[0-9a-f]{24}$/);
  });
});
