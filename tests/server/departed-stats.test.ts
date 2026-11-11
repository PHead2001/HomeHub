import assert from 'node:assert/strict';
import { after, beforeEach, describe, test } from 'node:test';
import { Timestamp } from 'firebase-admin/firestore';
import { adminDb } from '../../src/lib/server/firebase-admin';
import { leaveHousehold, type VerifiedCaller } from '../../src/lib/server/household-membership';
import { runHouseholdReminders } from '../../functions/src/reminders';
import { choreStatsAssigneeKey, choreStatsMemberKey } from '../../functions/src/shared/ids';
import { summarizeChores } from '../../src/lib/dashboard/wrapped';

// Review finding on #140: a member's yearly chore score stays one bucket when they
// leave (archived before + retained after), so Home Wrapped's champion does not change.
// Release D keys everyone by uid: the departure alias folds the archived legacy key into it.
const HOUSE = 'departed-stats-house';
const house = () => adminDb.collection('households').doc(HOUSE);
const ts = (d: Date) => Timestamp.fromDate(d) as never;
const owner = { uid: 'ds-owner', email: 'ds.owner@example.test' };
const sam: VerifiedCaller = { uid: 'ds-sam', email: 'ds.sam@example.test', displayName: 'Sam' };
const ana = { uid: 'ds-ana', email: 'ds.ana@example.test' };
const SAM = choreStatsAssigneeKey(sam.email);
const ANA = choreStatsAssigneeKey(ana.email);

const member = async (person: { uid: string; email: string }, role: string, displayName: string) => {
  await house().collection('members').doc(person.uid).set({ uid: person.uid, role, status: 'active', displayName });
  await house().collection('members').doc(person.uid).collection('private').doc('contact').set({ email: person.email, updatedAt: 'x' });
};

// Home Wrapped as a member sees it (C: member records may carry emails; the people left are the current members).
const wrapped = async (people: Array<{ uid: string; email?: string }>, names: Map<string, string>) => {
  const stats = (await house().collection('stats').doc('chores-2026').get()).data();
  const retained = (await house().collection('chores').get()).docs.map(d => ({ id: d.id, ...d.data() }));
  return summarizeChores(retained, 2026, { stats, timeZone: 'America/Chicago', people, names });
};

beforeEach(async () => {
  await adminDb.recursiveDelete(house());
  await house().set({ name: 'Departed', ownerUid: owner.uid, timeZone: 'America/Chicago' });
  await member(owner, 'owner', 'Owner');
  await member(sam, 'member', 'Sam');
  await member(ana, 'member', 'Ana');
  // Archived before Sam leaves: Sam 5, Ana 7, under their email-derived keys.
  await house().collection('stats').doc('chores-2026').set({
    year: 2026, completed: 12, byAssignee: { [SAM]: 5, [ANA]: 7 }, names: { [SAM]: 'Sam', [ANA]: 'Ana' },
  });
  // Retained: five of Sam's, stored by uid only and completed without a recorded completer.
  for (let index = 1; index <= 5; index += 1) {
    await house().collection('chores').doc(`sam-${index}`).set({
      task: `Sam ${index}`, assignedToUid: sam.uid, assignedToDisplayName: 'Sam', isCompleted: true,
      completedAt: `2026-02-0${index}T12:00:00.000Z`,
    });
  }
});

after(async () => {
  await adminDb.recursiveDelete(house());
  for (const person of [owner, sam, ana]) await adminDb.collection('users').doc(person.email).delete();
});

describe('yearly chore credit across a departure', () => {
  test('archived before + retained after are one bucket: the champion is unchanged by the departure and by the purge', async () => {
    const everyone = [owner, sam, ana];
    const byEmail = new Map([[owner.uid, 'Owner'], [sam.uid, 'Sam'], [ana.uid, 'Ana']]);
    assert.deepEqual((await wrapped(everyone, byEmail)).champion, { name: 'Sam', count: 10 });

    await leaveHousehold(sam, HOUSE, new Date('2026-03-01T12:00:00Z'));
    const stats = (await house().collection('stats').doc('chores-2026').get()).data();
    assert.deepEqual(stats?.aliases, { [sam.uid]: SAM }, 'the departure keeps Sam\'s key, with no email');
    assert.equal((await house().collection('stats').doc('chores-2025').get()).data()?.aliases?.[sam.uid], SAM);
    const left = [owner, ana];
    const leftNames = new Map([[owner.uid, 'Owner'], [ana.uid, 'Ana']]);
    assert.deepEqual((await wrapped(left, leftNames)).champion, { name: 'Sam', count: 10 }, 'not Ana (7)');

    // Upkeep purges Sam's five once they are 90 days old.
    const result = await runHouseholdReminders(adminDb as never, HOUSE, new Date('2026-06-01T15:00:00Z'), ts);
    assert.equal(result.purgedChores, 5);
    const after = (await house().collection('stats').doc('chores-2026').get()).data();
    assert.deepEqual(after?.byAssignee, { [choreStatsMemberKey(sam.uid)]: 10, [choreStatsMemberKey(ana.uid)]: 7 });
    assert.equal(after?.completed, 17);
    assert.equal(after?.byAssignee?.[SAM], undefined, 'no second bucket for Sam');
    assert.deepEqual(after?.aliases, { [sam.uid]: SAM }, 'kept by upkeep');
    assert.deepEqual((await wrapped(left, leftNames)).champion, { name: 'Sam', count: 10 });
  });

  test('a uid bucket and the aliased legacy key are one score', async () => {
    await house().collection('stats').doc('chores-2026').set({
      year: 2026, completed: 14, byAssignee: { [SAM]: 5, [ANA]: 7, [choreStatsMemberKey(sam.uid)]: 2 }, names: { [SAM]: 'Sam', [ANA]: 'Ana' },
      aliases: { [sam.uid]: SAM },
    });
    await house().collection('members').doc(sam.uid).delete();
    const left = [owner, ana];
    assert.deepEqual((await wrapped(left, new Map())).champion, { name: 'Sam', count: 12 });
    await runHouseholdReminders(adminDb as never, HOUSE, new Date('2026-06-01T15:00:00Z'), ts);
    const after = (await house().collection('stats').doc('chores-2026').get()).data();
    assert.deepEqual(after?.byAssignee, { [choreStatsMemberKey(sam.uid)]: 12, [choreStatsMemberKey(ana.uid)]: 7 });
  });

  // Review finding on #140: the alias years are the household's, as for completionYear and Home Wrapped.
  test('east of UTC: leaving just after local New Year aliases this local year and the last (Tokyo)', async () => {
    await house().update({ timeZone: 'Asia/Tokyo' });
    await house().collection('stats').doc('chores-2026').delete();
    for (let index = 1; index <= 5; index += 1) await house().collection('chores').doc(`sam-${index}`).delete();
    // That local morning (2027-01-01 in Tokyo, still 2026-12-31 UTC): one uid-only completion, one by email.
    await house().collection('chores').doc('sam-uid').set({ task: 'Uid', assignedToUid: sam.uid, assignedToDisplayName: 'Sam', isCompleted: true, completedAt: '2026-12-31T15:10:00.000Z' });
    await house().collection('chores').doc('sam-email').set({ task: 'Email', assignedToUid: owner.uid, isCompleted: true, completedAt: '2026-12-31T15:20:00.000Z', completedByEmail: sam.email, completedByUid: sam.uid, completedByName: 'Sam' });
    await leaveHousehold(sam, HOUSE, new Date('2026-12-31T16:00:00Z'));
    const aliased = async (year: number) => (await house().collection('stats').doc(`chores-${year}`).get()).data()?.aliases?.[sam.uid];
    assert.equal(await aliased(2027), SAM);
    assert.equal(await aliased(2026), SAM);
    assert.equal(await aliased(2025), undefined);
    const retained = (await house().collection('chores').get()).docs.map(d => ({ id: d.id, ...d.data() }));
    const stats2027 = (await house().collection('stats').doc('chores-2027').get()).data();
    assert.deepEqual(summarizeChores(retained, 2027, { stats: stats2027, timeZone: 'Asia/Tokyo', people: [owner, ana] }).champion, { name: 'Sam', count: 2 });
    await runHouseholdReminders(adminDb as never, HOUSE, new Date('2027-04-15T03:00:00Z'), ts);
    const after = (await house().collection('stats').doc('chores-2027').get()).data();
    assert.deepEqual(after?.byAssignee, { [choreStatsMemberKey(sam.uid)]: 2 }, 'one bucket after the purge');
  });

  test('west of UTC: leaving on the local last evening of the year (UTC already Jan 1) aliases that local year and the one before (Los Angeles)', async () => {
    await house().update({ timeZone: 'America/Los_Angeles' });
    await leaveHousehold(sam, HOUSE, new Date('2027-01-01T05:00:00Z'));
    const aliased = async (year: number) => (await house().collection('stats').doc(`chores-${year}`).get()).data()?.aliases?.[sam.uid];
    assert.equal(await aliased(2026), SAM);
    assert.equal(await aliased(2025), SAM);
    assert.equal((await house().collection('stats').doc('chores-2027').get()).exists, false, 'no local 2027 yet');
  });
});
