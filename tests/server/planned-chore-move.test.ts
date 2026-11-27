import assert from 'node:assert/strict';
import { after, beforeEach, describe, test } from 'node:test';
import { Timestamp } from 'firebase-admin/firestore';
import { adminDb } from '../../src/lib/server/firebase-admin';
import { movePlannedOccurrence, undoPlannedMove, PlannedMoveError } from '../../src/lib/server/planned-chore-move';
import { runHouseholdReminders } from '../../functions/src/reminders';
import { occurrenceChoreId } from '../../functions/src/shared/ids';

// Moving a planned (not yet generated) day of a repeating chore (audit CA-15, CA-27)
// through the Admin SDK, against the Firestore emulator.
const HOUSE = 'server-planned-move-house';
const house = () => adminDb.collection('households').doc(HOUSE);
const chores = () => house().collection('chores');
const ts = (d: Date) => Timestamp.fromDate(d) as never;
// Thu Nov 5 2026, 9 am in Chicago.
const NOW = new Date('2026-11-05T15:00:00Z');
const FAR = '2027-01-10'; // beyond upkeep's 30-occurrence lookahead of a daily chore

const code = async (run: Promise<unknown>) => {
  try {
    await run;
    return 'ok';
  } catch (error) {
    return error instanceof PlannedMoveError ? error.code : String(error);
  }
};

beforeEach(async () => {
  await adminDb.recursiveDelete(house());
  await house().set({ name: 'Planned', ownerUid: 'pm-owner', timeZone: 'America/Chicago' });
  await house().collection('members').doc('pm-owner').set({ uid: 'pm-owner', role: 'owner', status: 'active', displayName: 'Olive' });
  await house().collection('members').doc('pm-left').set({ uid: 'pm-left', role: 'member', status: 'removed', displayName: 'Gone' });
  await house().collection('chore-templates').doc('trash').set({
    task: 'Trash', assignedToUid: 'pm-owner', roomIds: [], notes: 'Curb', subTasks: ['Bag'], recurrence: { frequency: 'daily' },
  });
  await house().collection('chore-templates').doc('weekly').set({
    task: 'Mop', assignedToUid: 'pm-owner', roomIds: ['kitchen'], recurrence: { frequency: 'weekly', weeklyOptions: { daysOfWeek: [4] } },
  });
});

after(async () => {
  await adminDb.recursiveDelete(house());
});

describe('moving a planned day of a repeating chore', () => {
  test('creates the occurrence with upkeep\'s id and fields, due on the new day; upkeep never makes the old day again', async () => {
    const outcome = await movePlannedOccurrence(adminDb, HOUSE, { templateId: 'trash', roomId: 'general', day: FAR, toDay: '2027-01-12' }, NOW);
    const id = occurrenceChoreId('trash', 'general', FAR);
    assert.deepEqual(outcome, { choreId: id, day: FAR, toDay: '2027-01-12' });
    const stored = (await chores().doc(id).get()).data()!;
    assert.equal(stored.task, 'Trash');
    assert.equal(stored.assignedToUid, 'pm-owner');
    assert.equal(stored.assignedToDisplayName, 'Olive');
    assert.equal(stored.originalDueDate, '2027-01-12');
    assert.equal(stored.occurrenceKey, `trash|general|${FAR}`);
    assert.equal(stored.templateId, 'trash');
    assert.equal(stored.isCompleted, false);
    assert.deepEqual(stored.subTasks, ['Bag']);
    assert.deepEqual(stored.roomIds, []);
    assert.equal(stored.dueDate, '2027-01-12T06:00:00.000Z', 'household midnight of the new day');
    // Weeks later the day is inside upkeep's lookahead: it is not generated a second time.
    await runHouseholdReminders(adminDb as never, HOUSE, new Date('2026-12-20T15:00:00Z'), ts);
    const forDay = (await chores().where('occurrenceKey', '==', `trash|general|${FAR}`).get()).docs;
    assert.equal(forDay.length, 1);
    assert.equal(forDay[0].get('originalDueDate'), '2027-01-12');
  });

  test('refuses days the chore does not repeat on, past days, skipped days and the same day', async () => {
    assert.equal(await code(movePlannedOccurrence(adminDb, HOUSE, { templateId: 'weekly', roomId: 'kitchen', day: '2027-01-11', toDay: '2027-01-12' }, NOW)), 'invalid', 'Monday is not a Thursday');
    assert.equal(await code(movePlannedOccurrence(adminDb, HOUSE, { templateId: 'trash', roomId: 'general', day: '2026-11-04', toDay: '2026-11-06' }, NOW)), 'invalid', 'yesterday');
    assert.equal(await code(movePlannedOccurrence(adminDb, HOUSE, { templateId: 'trash', roomId: 'general', day: FAR, toDay: '2026-11-04' }, NOW)), 'invalid', 'into the past');
    assert.equal(await code(movePlannedOccurrence(adminDb, HOUSE, { templateId: 'trash', roomId: 'general', day: FAR, toDay: FAR }, NOW)), 'invalid');
    assert.equal(await code(movePlannedOccurrence(adminDb, HOUSE, { templateId: 'trash', roomId: 'garage', day: FAR, toDay: '2027-01-12' }, NOW)), 'invalid', 'not one of its rooms');
    await house().collection('chore-templates').doc('trash').update({ skippedOccurrences: [`trash|general|${FAR}`] });
    assert.equal(await code(movePlannedOccurrence(adminDb, HOUSE, { templateId: 'trash', roomId: 'general', day: FAR, toDay: '2027-01-12' }, NOW)), 'invalid', 'a skipped day');
    assert.equal(await code(movePlannedOccurrence(adminDb, HOUSE, { templateId: 'missing', roomId: 'general', day: FAR, toDay: '2027-01-12' }, NOW)), 'not-found');
    assert.equal((await chores().get()).size, 0);
  });

  test('refuses a template that still names its assignee by email, or someone no longer a member', async () => {
    await house().collection('chore-templates').doc('trash').update({ assignedToEmail: 'olive@example.test' });
    assert.equal(await code(movePlannedOccurrence(adminDb, HOUSE, { templateId: 'trash', roomId: 'general', day: FAR, toDay: '2027-01-12' }, NOW)), 'invalid');
    await house().collection('chore-templates').doc('weekly').update({ assignedToUid: 'pm-left' });
    assert.equal(await code(movePlannedOccurrence(adminDb, HOUSE, { templateId: 'weekly', roomId: 'kitchen', day: '2027-01-14', toDay: '2027-01-15' }, NOW)), 'invalid');
  });

  test('a rotating chore (CH-28) is created for whoever\'s turn that day is, as upkeep would', async () => {
    await house().collection('members').doc('pm-b').set({ uid: 'pm-b', role: 'member', status: 'active', displayName: 'Bea' });
    await house().collection('chore-templates').doc('rot').set({
      task: 'Feed fish', assignedToUid: 'pm-owner', roomIds: [], recurrence: { frequency: 'daily' },
      rotation: ['pm-owner', 'pm-b'], rotationStart: '2026-11-05',
    });
    const even = await movePlannedOccurrence(adminDb, HOUSE, { templateId: 'rot', roomId: 'general', day: '2027-01-10', toDay: '2027-01-12' }, NOW);
    const odd = await movePlannedOccurrence(adminDb, HOUSE, { templateId: 'rot', roomId: 'general', day: '2027-01-11', toDay: '2027-01-12' }, NOW);
    assert.equal((await chores().doc(even.choreId).get()).get('assignedToUid'), 'pm-owner', '66 days after the start: the first turn');
    assert.equal((await chores().doc(odd.choreId).get()).get('assignedToUid'), 'pm-b');
    // Upkeep, run once those days are in its lookahead, agrees and creates nothing more for them.
    await runHouseholdReminders(adminDb as never, HOUSE, new Date('2026-12-20T15:00:00Z'), ts);
    const forDays = (await chores().where('templateId', '==', 'rot').get()).docs.filter(d => ['rot|general|2027-01-10', 'rot|general|2027-01-11'].includes(d.get('occurrenceKey')));
    assert.equal(forDays.length, 2);
    const nextDay = (await chores().where('occurrenceKey', '==', 'rot|general|2027-01-12').get()).docs[0];
    assert.equal(nextDay?.get('assignedToUid'), 'pm-owner', 'the turns continue where they would have');
  });

  test('a day that exists already (generated meanwhile, or held by a reassigned chore) is a conflict', async () => {
    await chores().doc(occurrenceChoreId('trash', 'general', FAR)).set({ task: 'Trash', originalDueDate: FAR, isCompleted: false });
    assert.equal(await code(movePlannedOccurrence(adminDb, HOUSE, { templateId: 'trash', roomId: 'general', day: FAR, toDay: '2027-01-12' }, NOW)), 'conflict');
    await chores().doc('legacy-id').set({ task: 'Trash', originalDueDate: '2027-01-09', occurrenceKey: 'trash|general|2027-01-09', isCompleted: false });
    assert.equal(await code(movePlannedOccurrence(adminDb, HOUSE, { templateId: 'trash', roomId: 'general', day: '2027-01-09', toDay: '2027-01-12' }, NOW)), 'conflict');
  });

  test('Undo removes the untouched move; a completed or changed one is kept', async () => {
    const { choreId } = await movePlannedOccurrence(adminDb, HOUSE, { templateId: 'trash', roomId: 'general', day: FAR, toDay: '2027-01-12' }, NOW);
    assert.deepEqual(await undoPlannedMove(adminDb, HOUSE, { choreId, toDay: '2027-01-12' }), { status: 'undone' });
    assert.equal((await chores().doc(choreId).get()).exists, false);
    assert.deepEqual(await undoPlannedMove(adminDb, HOUSE, { choreId, toDay: '2027-01-12' }), { status: 'missing' });

    const again = await movePlannedOccurrence(adminDb, HOUSE, { templateId: 'trash', roomId: 'general', day: FAR, toDay: '2027-01-12' }, NOW);
    await chores().doc(again.choreId).update({ completedSubTasks: ['Bag'] });
    assert.deepEqual(await undoPlannedMove(adminDb, HOUSE, { choreId: again.choreId, toDay: '2027-01-12' }), { status: 'stale' });
    await chores().doc(again.choreId).update({ completedSubTasks: [], originalDueDate: '2027-01-13' });
    assert.deepEqual(await undoPlannedMove(adminDb, HOUSE, { choreId: again.choreId, toDay: '2027-01-12' }), { status: 'stale', }, 'moved again meanwhile');
    assert.equal((await chores().doc(again.choreId).get()).exists, true);
  });
});
