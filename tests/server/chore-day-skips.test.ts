import assert from 'node:assert/strict';
import { after, beforeEach, describe, test } from 'node:test';
import { adminDb } from '../../src/lib/server/firebase-admin';
import { ChoreSkipError, skipChoreDays, undoSkipChoreDays } from '../../src/lib/server/chore-day-skips';
import { occurrenceChoreId } from '../../functions/src/shared/ids';

// Skipping days of repeating chores from the calendar (audit CA-27; review findings 2
// and 3) through the Admin SDK, against the Firestore emulator.
const HOUSE = 'server-chore-skips-house';
const house = () => adminDb.collection('households').doc(HOUSE);
const chores = () => house().collection('chores');
const template = () => house().collection('chore-templates').doc('trash');
// Thu Nov 5 2026, 9 am in Chicago.
const NOW = new Date('2026-11-05T15:00:00Z');
const key = (day: string) => `trash|general|${day}`;
const id = (day: string) => occurrenceChoreId('trash', 'general', day);

const seed = (day: string, extra: Record<string, unknown> = {}) => chores().doc(id(day)).set({
  task: 'Trash', assignedToUid: 'sk-owner', templateId: 'trash', occurrenceKey: key(day), originalDueDate: day,
  dueDate: `${day}T06:00:00.000Z`, isCompleted: false, subTasks: ['Bag'], completedSubTasks: [], roomIds: [], ...extra,
});
const code = async (run: Promise<unknown>) => {
  try {
    await run;
    return 'ok';
  } catch (error) {
    return error instanceof ChoreSkipError ? error.code : String(error);
  }
};

beforeEach(async () => {
  await adminDb.recursiveDelete(house());
  await house().set({ name: 'Skips', timeZone: 'America/Chicago' });
  await template().set({ task: 'Trash', assignedToUid: 'sk-owner', roomIds: [], recurrence: { frequency: 'daily' } });
});

after(async () => {
  await adminDb.recursiveDelete(house());
});

describe('skipping days on the server', () => {
  test('re-reads each chore: deletes the open occurrence, keeps one completed meanwhile, and records the keys', async () => {
    await seed('2026-11-06');
    await seed('2026-11-07', { isCompleted: true, completedByUid: 'sk-owner' }); // completed after the calendar showed it open
    await seed('2026-11-08', { occurrenceKey: key('2026-11-09') }); // no longer that day's occurrence
    const outcome = await skipChoreDays(adminDb, HOUSE, { items: [
      { templateId: 'trash', key: key('2026-11-06'), choreId: id('2026-11-06') },
      { templateId: 'trash', key: key('2026-11-07'), choreId: id('2026-11-07') },
      { templateId: 'trash', key: key('2026-11-08'), choreId: id('2026-11-08') },
      { templateId: 'trash', key: key('2026-11-10') }, // planned
      { templateId: 'trash', key: key('2026-11-01'), choreId: id('2026-11-01') }, // past: ignored
    ] }, 'sk-owner', NOW);
    assert.equal(outcome.deleted, 1);
    assert.equal(outcome.kept, 2);
    assert.equal((await chores().doc(id('2026-11-06')).get()).exists, false);
    assert.equal((await chores().doc(id('2026-11-07')).get()).get('isCompleted'), true, 'a completion is never deleted');
    assert.equal((await chores().doc(id('2026-11-08')).get()).exists, true);
    assert.deepEqual((await template().get()).get('skippedOccurrences'), [key('2026-11-06'), key('2026-11-07'), key('2026-11-08'), key('2026-11-10')]);
    const op = (await house().collection('calendar-ops').doc(outcome.opId).get()).data()!;
    assert.equal(op.kind, 'skip');
    assert.deepEqual(op.removed.map((entry: { id: string }) => entry.id), [id('2026-11-06')]);
  });

  test('a day sent as planned that upkeep generated meanwhile is found and skipped (review round 2)', async () => {
    await seed('2026-11-12'); // generated after the calendar planned it: its deterministic id
    await chores().doc('legacy-trash-day').set({ // an older id that holds the key
      task: 'Trash', templateId: 'trash', occurrenceKey: key('2026-11-13'), originalDueDate: '2026-11-13', isCompleted: false,
    });
    await seed('2026-11-14', { isCompleted: true });
    const outcome = await skipChoreDays(adminDb, HOUSE, { items: [
      { templateId: 'trash', key: key('2026-11-12') },
      { templateId: 'trash', key: key('2026-11-13') },
      { templateId: 'trash', key: key('2026-11-14') },
    ] }, 'sk-owner', NOW);
    assert.equal(outcome.deleted, 2);
    assert.equal((await chores().doc(id('2026-11-12')).get()).exists, false);
    assert.equal((await chores().doc('legacy-trash-day').get()).exists, false);
    assert.equal((await chores().doc(id('2026-11-14')).get()).get('isCompleted'), true, 'never a completion');
    // Undo puts both back.
    assert.deepEqual(await undoSkipChoreDays(adminDb, HOUSE, { opId: outcome.opId }, 'sk-owner', NOW), { restored: 2, regenerate: 0 });
    assert.equal((await chores().doc('legacy-trash-day').get()).exists, true);
  });

  test('refuses keys of another template, one-time chores and malformed input', async () => {
    assert.equal(await code(skipChoreDays(adminDb, HOUSE, { items: [{ templateId: 'trash', key: 'other|general|2026-11-06' }] }, 'sk-owner', NOW)), 'invalid');
    assert.equal(await code(skipChoreDays(adminDb, HOUSE, { items: [] }, 'sk-owner', NOW)), 'invalid');
    assert.equal(await code(skipChoreDays(adminDb, HOUSE, { items: 'x' }, 'sk-owner', NOW)), 'invalid');
    await seed('2026-11-06', { sourceType: 'template' });
    const outcome = await skipChoreDays(adminDb, HOUSE, { items: [{ templateId: 'trash', key: key('2026-11-06'), choreId: id('2026-11-06') }] }, 'sk-owner', NOW);
    assert.equal(outcome.deleted, 0, 'a one-time assignment is never part of a series');
    assert.equal((await chores().doc(id('2026-11-06')).get()).exists, true);
  });

  test('Undo puts the deleted day back exactly as it was (moved, steps ticked) while its day is free', async () => {
    await seed('2026-11-06', { originalDueDate: '2026-11-09', completedSubTasks: ['Bag'], assignedToDisplayName: 'Olive' });
    await seed('2026-11-07');
    const { opId } = await skipChoreDays(adminDb, HOUSE, { items: [
      { templateId: 'trash', key: key('2026-11-06'), choreId: id('2026-11-06') },
      { templateId: 'trash', key: key('2026-11-07'), choreId: id('2026-11-07') },
    ] }, 'sk-owner', NOW);
    // Meanwhile someone else's chore took Nov 7's occurrence.
    await chores().doc('other').set({ task: 'Trash', templateId: 'trash', occurrenceKey: key('2026-11-07'), originalDueDate: '2026-11-07', isCompleted: false });
    assert.equal(await code(undoSkipChoreDays(adminDb, HOUSE, { opId }, 'sk-other', NOW)), 'invalid', 'only the person who skipped');
    assert.equal(await code(undoSkipChoreDays(adminDb, HOUSE, { opId }, 'sk-owner', new Date(NOW.getTime() + 11 * 60_000))), 'invalid', 'too late');
    assert.deepEqual(await undoSkipChoreDays(adminDb, HOUSE, { opId }, 'sk-owner', NOW), { restored: 1, regenerate: 1 });
    const back = (await chores().doc(id('2026-11-06')).get()).data()!;
    assert.equal(back.originalDueDate, '2026-11-09', 'the moved day stays moved');
    assert.deepEqual(back.completedSubTasks, ['Bag']);
    assert.equal(back.assignedToDisplayName, 'Olive');
    assert.equal((await chores().doc(id('2026-11-07')).get()).exists, false, 'a day taken meanwhile is not doubled');
    assert.deepEqual((await template().get()).get('skippedOccurrences'), []);
    assert.equal(await code(undoSkipChoreDays(adminDb, HOUSE, { opId }, 'sk-owner', NOW)), 'invalid', 'an op is used once');
  });
});
