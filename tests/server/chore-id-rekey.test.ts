import assert from 'node:assert/strict';
import { after, beforeEach, describe, test } from 'node:test';
import { Timestamp } from 'firebase-admin/firestore';
import { adminDb } from '../../src/lib/server/firebase-admin';
import { runHouseholdReminders } from '../../functions/src/reminders';
import { occurrenceChoreId, recurringChoreId } from '../../functions/src/shared/ids';
import { choreIdRekeyPlan } from '../../scripts/ops/chore-id-rekey.mjs';
import { moveChoreToOccurrenceId } from '../../scripts/ops/chore-id-move.mjs';

// The write of scripts/ops/rekey-chore-ids.mjs (member privacy release E)
// against the Firestore emulator: one chore per transaction, every field kept.
const HOUSE = 'chore-id-rekey-house';
const house = () => adminDb.collection('households').doc(HOUSE);
const chores = () => house().collection('chores');
const ts = (d: Date) => Timestamp.fromDate(d) as never;
const EMAIL = 'owner@example.test';

const plan = (id: string, data: Record<string, unknown>) => {
  const decided = choreIdRekeyPlan(id, data);
  assert.equal(decided.kind, 'rekey');
  return decided as { kind: 'rekey'; base: string; suffix: 'uid' | 'other'; occurrenceKey: string | null };
};
const move = async (id: string) => {
  const snap = await chores().doc(id).get();
  return moveChoreToOccurrenceId(adminDb as never, snap.ref as never, snap.updateTime as never, plan(id, snap.data()!));
};

beforeEach(async () => {
  await adminDb.recursiveDelete(house());
  await house().set({ name: 'Rekey', ownerUid: 'o1', timeZone: 'America/Chicago' });
  await house().collection('members').doc('o1').set({ uid: 'o1', role: 'owner', status: 'active', displayName: 'Owner' });
  await house().collection('chore-templates').doc('trash').set({
    task: 'Trash', assignedToUid: 'o1', roomIds: [], recurrence: { frequency: 'weekly', weeklyOptions: { daysOfWeek: [4] } },
  });
});

after(async () => {
  await adminDb.recursiveDelete(house());
});

describe('moving chores to email-free ids', () => {
  test('a completed chore moves with every field, and upkeep then sees its day as done', async () => {
    const id = recurringChoreId('trash', 'general', '2026-11-05', EMAIL);
    const completedAtServer = Timestamp.fromDate(new Date('2026-11-05T14:00:00Z'));
    const data = {
      task: 'Trash', templateId: 'trash', roomIds: [], assignedToUid: 'o1', assignedToDisplayName: 'Owner',
      originalDueDate: '2026-11-06', dueDate: '2026-11-06T06:00:00.000Z', occurrenceKey: 'trash|general|2026-11-05',
      isCompleted: true, completedAt: '2026-11-05T14:00:00.000Z', completedAtServer,
      completedByUid: 'o1', completedByName: 'Owner', completionId: 'c-1', completedSubTasks: ['a'], subTasks: ['a'],
    };
    await chores().doc(id).set(data);
    assert.equal(await move(id), 'moved');
    const target = occurrenceChoreId('trash', 'general', '2026-11-05');
    assert.equal((await chores().doc(id).get()).exists, false, 'the old id is gone');
    const moved = (await chores().doc(target).get()).data()!;
    assert.deepEqual({ ...moved, completedAtServer: null }, { ...data, completedAtServer: null });
    assert.ok((moved.completedAtServer as Timestamp).isEqual(completedAtServer), 'the server stamp is kept as a timestamp');

    const result = await runHouseholdReminders(adminDb as never, HOUSE, new Date('2026-11-05T15:00:00Z'), ts);
    assert.equal(result.generatedChores, 29, 'the moved day is not generated again');
    assert.equal((await chores().where('occurrenceKey', '==', 'trash|general|2026-11-05').get()).size, 1);
  });

  test('a chore without a key gets the one its id names', async () => {
    const id = recurringChoreId('trash', 'general', '2026-11-12', EMAIL);
    await chores().doc(id).set({ task: 'Trash', templateId: 'trash', roomIds: [], originalDueDate: '2026-11-12', isCompleted: false });
    assert.equal(await move(id), 'moved');
    assert.equal((await chores().doc(occurrenceChoreId('trash', 'general', '2026-11-12')).get()).data()?.occurrenceKey, 'trash|general|2026-11-12');
  });

  test('a second chore for the same day goes to a numbered id; nothing is overwritten', async () => {
    const day = '2026-11-19';
    const fields = { task: 'Trash', templateId: 'trash', roomIds: [], originalDueDate: day, occurrenceKey: `trash|general|${day}` };
    const byEmail = recurringChoreId('trash', 'general', day, EMAIL);
    const byUid = recurringChoreId('trash', 'general', day, 'o1');
    await chores().doc(byEmail).set({ ...fields, isCompleted: true, completedAt: '2026-11-19T12:00:00.000Z' });
    await chores().doc(byUid).set({ ...fields, isCompleted: false });
    assert.equal(await move(byEmail), 'moved');
    assert.equal(await move(byUid), 'duplicate');
    const base = occurrenceChoreId('trash', 'general', day);
    assert.equal((await chores().doc(base).get()).data()?.isCompleted, true);
    assert.equal((await chores().doc(`${base}-2`).get()).data()?.isCompleted, false);
    assert.deepEqual(choreIdRekeyPlan(`${base}-2`, fields), { kind: 'current' }, 'a re-run leaves it alone');
  });

  test('a chore changed since it was read is skipped, and nothing is written for a household being deleted', async () => {
    const id = recurringChoreId('trash', 'general', '2026-11-26', EMAIL);
    const fields = { task: 'Trash', templateId: 'trash', roomIds: [], originalDueDate: '2026-11-26', occurrenceKey: 'trash|general|2026-11-26', isCompleted: false };
    await chores().doc(id).set(fields);
    const read = await chores().doc(id).get();
    await chores().doc(id).update({ isCompleted: true });
    const decided = plan(id, read.data()!);
    assert.equal(await moveChoreToOccurrenceId(adminDb as never, read.ref as never, read.updateTime as never, decided), 'changed');
    assert.equal((await chores().doc(id).get()).exists, true);

    await house().update({ deletingAt: '2026-11-05T00:00:00.000Z' });
    assert.equal(await move(id), 'stopped');
    assert.equal((await chores().doc(id).get()).exists, true);
    assert.equal((await chores().doc(occurrenceChoreId('trash', 'general', '2026-11-26')).get()).exists, false);
  });
});
