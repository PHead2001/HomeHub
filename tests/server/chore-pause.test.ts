import assert from 'node:assert/strict';
import { after, beforeEach, describe, test } from 'node:test';
import { adminDb } from '../../src/lib/server/firebase-admin';
import { pauseChoresAs } from '../../src/lib/server/chore-pause';
import { runHouseholdReminders } from '../../functions/src/reminders';
import { Timestamp } from 'firebase-admin/firestore';

// Away / sick pause (CH-32) through the Admin SDK, against the Firestore emulator.
const HOUSE = 'server-chore-pause-house';
const house = () => adminDb.collection('households').doc(HOUSE);
const chores = () => house().collection('chores');
const templates = () => house().collection('chore-templates');
const ts = (d: Date) => Timestamp.fromDate(d) as never;
// Noon on Fri Nov 27, 2026 in Chicago.
const NOW = new Date('2026-11-27T18:00:00Z');

beforeEach(async () => {
  await adminDb.recursiveDelete(house());
  await house().set({ name: 'Pause', ownerUid: 'owner', timeZone: 'America/Chicago', memberEmails: [] });
  for (const [uid, role, displayName] of [['owner', 'owner', 'Olive'], ['sam', 'member', 'Sam'], ['kid', 'child', 'Kid']] as const) {
    await house().collection('members').doc(uid).set({ uid, role, status: 'active', displayName });
  }
  await templates().doc('dishes').set({ task: 'Dishes', roomIds: [], subTasks: [], assignedToUid: 'sam', recurrence: { frequency: 'daily', interval: 1 } });
  await templates().doc('mow').set({ task: 'Mow', roomIds: [], subTasks: [], assignedToUid: 'owner', recurrence: { frequency: 'daily', interval: 1 } });
  await runHouseholdReminders(adminDb as never, HOUSE, NOW, ts);
});

after(async () => {
  await adminDb.recursiveDelete(house());
});

const openDays = async (templateId: string) => (await chores().where('templateId', '==', templateId).get()).docs
  .filter(doc => doc.get('isCompleted') !== true).map(doc => doc.get('originalDueDate') as string).sort();

describe('pausing chores (CH-32)', () => {
  test('a member pauses their own days: the open days go, the skips stay, upkeep does not bring them back', async () => {
    // A day completed inside the range is history and stays.
    const completed = (await chores().where('templateId', '==', 'dishes').where('originalDueDate', '==', '2026-11-28').get()).docs[0];
    await completed.ref.update({ isCompleted: true, completedAt: NOW.toISOString() });
    const outcome = await pauseChoresAs(adminDb, HOUSE, { uid: 'sam' }, { memberUid: 'sam', from: '2026-11-28', to: '2026-11-30' }, NOW);
    assert.deepEqual(outcome, { status: 'paused', templates: 1, removed: 2, days: 3 });
    const days = await openDays('dishes');
    assert.equal(days.includes('2026-11-29') || days.includes('2026-11-30'), false);
    assert.ok(days.includes('2026-11-27') && days.includes('2026-12-01'));
    assert.equal((await completed.ref.get()).get('isCompleted'), true);
    await runHouseholdReminders(adminDb as never, HOUSE, NOW, ts);
    assert.equal((await openDays('dishes')).includes('2026-11-29'), false, 'upkeep honours the skip');
    // Someone else's series is untouched.
    assert.ok((await openDays('mow')).includes('2026-11-29'));
  });

  test('resume removes the skips and upkeep makes the days again', async () => {
    await pauseChoresAs(adminDb, HOUSE, { uid: 'sam' }, { memberUid: 'sam', from: '2026-11-28', to: '2026-11-30' }, NOW);
    const outcome = await pauseChoresAs(adminDb, HOUSE, { uid: 'sam' }, { memberUid: 'sam', from: '2026-11-28', to: '2026-11-30', resume: true }, NOW);
    assert.equal(outcome.status, 'resumed');
    assert.deepEqual((await templates().doc('dishes').get()).get('skippedOccurrences'), []);
    await runHouseholdReminders(adminDb as never, HOUSE, NOW, ts);
    assert.ok((await openDays('dishes')).includes('2026-11-29'));
  });

  test('someone else\'s chores need chores.delete; a kid cannot pause at all', async () => {
    assert.deepEqual(await pauseChoresAs(adminDb, HOUSE, { uid: 'kid' }, { memberUid: 'kid', from: '2026-11-28', to: '2026-11-29' }, NOW), { status: 'refused', reason: 'forbidden' });
    // A member (chores.edit and chores.assign, no chores.delete) pauses only their own chores.
    assert.deepEqual(await pauseChoresAs(adminDb, HOUSE, { uid: 'sam' }, { memberUid: 'owner', from: '2026-11-28', to: '2026-11-29' }, NOW), { status: 'refused', reason: 'forbidden' });
    assert.ok((await openDays('mow')).includes('2026-11-28'), 'nothing was written');
    assert.equal((await pauseChoresAs(adminDb, HOUSE, { uid: 'sam' }, { memberUid: 'sam', from: '2026-11-28', to: '2026-11-29' }, NOW)).status, 'paused');
    // Given chores.delete, they may pause someone else's.
    await house().collection('members').doc('sam').update({ permissions: { 'chores.delete': true } });
    assert.equal((await pauseChoresAs(adminDb, HOUSE, { uid: 'sam' }, { memberUid: 'owner', from: '2026-11-28', to: '2026-11-29' }, NOW)).status, 'paused');
    const byOwner = await pauseChoresAs(adminDb, HOUSE, { uid: 'owner' }, { memberUid: 'sam', from: '2026-11-30', to: '2026-11-30' }, NOW);
    assert.equal(byOwner.status, 'paused');
  });

  test('a day already swapped or reassigned to someone else is neither deleted nor skipped', async () => {
    const swapped = (await chores().where('templateId', '==', 'dishes').where('originalDueDate', '==', '2026-11-29').get()).docs[0];
    await swapped.ref.update({ assignedToUid: 'owner', assignedToDisplayName: 'Olive' });
    const outcome = await pauseChoresAs(adminDb, HOUSE, { uid: 'sam' }, { memberUid: 'sam', from: '2026-11-28', to: '2026-11-30' }, NOW);
    assert.deepEqual(outcome, { status: 'paused', templates: 1, removed: 2, days: 2 });
    const kept = await swapped.ref.get();
    assert.equal(kept.exists, true, 'the swapped day stays');
    assert.equal(kept.get('assignedToUid'), 'owner');
    const skipped = (await templates().doc('dishes').get()).get('skippedOccurrences') as string[];
    assert.equal(skipped.some(key => key.endsWith('2026-11-29')), false);
    assert.ok(skipped.some(key => key.endsWith('2026-11-28')) && skipped.some(key => key.endsWith('2026-11-30')));
  });

  test('a range that is too long, over or inverted changes nothing', async () => {
    for (const [from, to, reason] of [['2026-11-28', '2026-12-29', 'too-long'], ['2026-11-01', '2026-11-02', 'past'], ['2026-11-29', '2026-11-28', 'invalid']] as const) {
      assert.deepEqual(await pauseChoresAs(adminDb, HOUSE, { uid: 'sam' }, { memberUid: 'sam', from, to }, NOW), { status: 'refused', reason });
    }
    assert.equal((await templates().doc('dishes').get()).get('skippedOccurrences'), undefined);
  });

  test('a rotating chore: only the paused member\'s turns are skipped and removed (CH-28)', async () => {
    await templates().doc('bins').set({ task: 'Bins', roomIds: [], subTasks: [], recurrence: { frequency: 'daily', interval: 1 }, rotation: ['sam', 'owner'], rotationStart: '2026-11-28' });
    await runHouseholdReminders(adminDb as never, HOUSE, NOW, ts);
    const outcome = await pauseChoresAs(adminDb, HOUSE, { uid: 'sam' }, { memberUid: 'sam', from: '2026-11-28', to: '2026-12-01' }, NOW);
    assert.equal(outcome.status, 'paused');
    const days = await openDays('bins');
    // Sam's turns (Nov 28 and 30) are gone; the owner's (Nov 29 and Dec 1) stay.
    assert.equal(days.includes('2026-11-28') || days.includes('2026-11-30'), false);
    assert.ok(days.includes('2026-11-29') && days.includes('2026-12-01'));
    const skipped = (await templates().doc('bins').get()).get('skippedOccurrences') as string[];
    assert.deepEqual(skipped.map(key => key.slice(-10)).sort(), ['2026-11-28', '2026-11-30']);
  });
});
