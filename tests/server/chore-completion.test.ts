import assert from 'node:assert/strict';
import { after, beforeEach, describe, test } from 'node:test';
import { Timestamp } from 'firebase-admin/firestore';
import { adminDb } from '../../src/lib/server/firebase-admin';
import { completeChoresAs, reopenChoreAs, undoChoreCompletionAs, type CompletionCaller } from '../../src/lib/server/chore-completion';
import { runHouseholdReminders } from '../../functions/src/reminders';
import { recurringChoreId } from '../../functions/src/shared/ids';
import { computeChoreStats } from '../../src/lib/chores/stats';
import type { ChoreRecord } from '../../src/lib/chores/dates';

// Shared chore completion (H3: CH-2, CH-12, CH-3, D-7) through the Admin SDK,
// against the Firestore emulator.
const HOUSE = 'server-completion-house';
const house = () => adminDb.collection('households').doc(HOUSE);
const chores = () => house().collection('chores');
const ts = (d: Date) => Timestamp.fromDate(d) as never;

const owner: CompletionCaller = { uid: 'cc-owner', email: 'cc.owner@example.test', displayName: 'Olive Owner' };
const sam: CompletionCaller = { uid: 'cc-sam', email: 'cc.sam@example.test' };

// 23:30 on Thu Nov 5 in Chicago, and 00:30 on Fri Nov 6 (an hour later).
const BEFORE_MIDNIGHT = new Date('2026-11-06T05:30:00Z');
const AFTER_MIDNIGHT = new Date('2026-11-06T06:30:00Z');

const seedChore = (id: string, data: Record<string, unknown> = {}) => chores().doc(id).set({
  task: 'Dishes', assignedToEmail: owner.email, assignedToDisplayName: 'Olive Owner',
  dueDate: '2026-11-05T06:00:00.000Z', originalDueDate: '2026-11-05', isCompleted: false,
  subTasks: [], completedSubTasks: [], roomIds: [], ...data,
});
const read = async (id: string) => (await chores().doc(id).get()).data()!;

beforeEach(async () => {
  await adminDb.recursiveDelete(house());
  await house().set({ name: 'Completion', ownerUid: owner.uid, timeZone: 'America/Chicago', memberEmails: [] });
  await house().collection('members').doc(owner.uid).set({ uid: owner.uid, email: owner.email, role: 'owner', status: 'active', displayName: 'Olive Owner' });
  await house().collection('members').doc(sam.uid).set({ uid: sam.uid, email: sam.email, role: 'child', status: 'active', displayName: 'Sam' });
});

after(async () => {
  await adminDb.recursiveDelete(house());
});

describe('completing chores on the server', () => {
  test('a chore due tomorrow (household time) is refused until the household day starts', async () => {
    await seedChore('friday', { originalDueDate: '2026-11-06', dueDate: '2026-11-06T06:00:00.000Z' });
    const [early] = await completeChoresAs(adminDb, sam, HOUSE, { choreIds: ['friday'] }, BEFORE_MIDNIGHT);
    assert.deepEqual(early, { choreId: 'friday', status: 'refused', refused: 'early', dueDay: '2026-11-06' });
    // The UTC day is already Nov 6, but Chicago is still on Nov 5.
    assert.equal((await read('friday')).isCompleted, false);

    const [done] = await completeChoresAs(adminDb, sam, HOUSE, { choreIds: ['friday'] }, AFTER_MIDNIGHT);
    assert.equal(done.status, 'completed');
    assert.equal((await read('friday')).isCompleted, true);
  });

  test('the completer is recorded from the verified caller and gets the points', async () => {
    await seedChore('dishes', { subTasks: ['Rinse', 'Dry'], completedSubTasks: ['Rinse'] });
    const [outcome] = await completeChoresAs(adminDb, sam, HOUSE, { choreIds: ['dishes'], completeSubTasks: true }, AFTER_MIDNIGHT);
    assert.equal(outcome.status, 'completed');
    const stored = await read('dishes');
    assert.equal(stored.completedByUid, sam.uid);
    assert.equal(stored.completedByEmail, sam.email);
    assert.equal(stored.completedByName, 'Sam', 'the member record names the completer');
    assert.equal(typeof stored.completionId, 'string');
    assert.ok(stored.completedAtServer instanceof Timestamp);
    assert.equal(stored.completedAt, AFTER_MIDNIGHT.toISOString());
    assert.deepEqual(stored.completedSubTasks, ['Rinse', 'Dry']);
    assert.equal(stored.assignedToEmail, owner.email, 'the assignee is unchanged');

    const members = [
      { email: owner.email, uid: owner.uid, name: 'Olive Owner' },
      { email: sam.email, uid: sam.uid, name: 'Sam' },
    ];
    // Stats read the server stamp (real time, not the pinned `now`), so score them as of now.
    const stats = computeChoreStats([{ id: 'dishes', ...stored } as ChoreRecord], members, new Date());
    assert.equal(stats.members.find(m => m.uid === sam.uid)!.totalPoints > 0, true);
    assert.equal(stats.members.find(m => m.uid === owner.uid)!.totalPoints, 0);
  });

  test('two people completing the same chore at once yield one completion', async () => {
    await seedChore('race');
    const [a, b] = await Promise.all([
      completeChoresAs(adminDb, sam, HOUSE, { choreIds: ['race'] }, AFTER_MIDNIGHT),
      completeChoresAs(adminDb, owner, HOUSE, { choreIds: ['race'] }, AFTER_MIDNIGHT),
    ]);
    const statuses = [a[0].status, b[0].status].sort();
    assert.deepEqual(statuses, ['already', 'completed']);
    const stored = await read('race');
    const winner = a[0].status === 'completed' ? sam : owner;
    assert.equal(stored.completedByUid, winner.uid);
    const loser = a[0].status === 'already' ? a[0] : b[0];
    assert.ok(loser.status === 'already');
    assert.equal(loser.completion.completedByUid, winner.uid, 'the second caller learns who did it');
    assert.equal(loser.completion.completionId, stored.completionId);
  });

  test('a missing chore is reported, and bad input is refused', async () => {
    const [missing] = await completeChoresAs(adminDb, sam, HOUSE, { choreIds: ['nope'] }, AFTER_MIDNIGHT);
    assert.deepEqual(missing, { choreId: 'nope', status: 'refused', refused: 'missing' });
    await assert.rejects(completeChoresAs(adminDb, sam, HOUSE, { choreIds: [] }, AFTER_MIDNIGHT));
    await assert.rejects(completeChoresAs(adminDb, sam, HOUSE, { choreIds: ['a/b'] }, AFTER_MIDNIGHT));
    await assert.rejects(completeChoresAs(adminDb, sam, HOUSE, { choreIds: ['__reserved__'] }, AFTER_MIDNIGHT));
    await assert.rejects(completeChoresAs(adminDb, sam, HOUSE, { choreIds: ['a'.repeat(1501)] }, AFTER_MIDNIGHT));
  });

  test('a recurring chore with an ID over 200 characters can be completed, undone and reopened', async () => {
    const template = `${'t'.repeat(60)}-${'A'.repeat(20)}`;
    const room = `${'r'.repeat(60)}-${'B'.repeat(20)}`;
    const id = recurringChoreId(template, room, '2026-11-05', `${'someone.long'.repeat(8)}@example.test`);
    assert.ok(id.length > 200);
    await seedChore(id);
    const [done] = await completeChoresAs(adminDb, sam, HOUSE, { choreIds: [id] }, AFTER_MIDNIGHT);
    assert.ok(done.status === 'completed');
    const undone = await undoChoreCompletionAs(adminDb, HOUSE, { choreId: id, completionId: done.completion.completionId! });
    assert.equal(undone.status, 'undone');
    assert.equal((await completeChoresAs(adminDb, sam, HOUSE, { choreIds: [id] }, AFTER_MIDNIGHT))[0].status, 'completed');
    assert.equal((await reopenChoreAs(adminDb, HOUSE, { choreId: id })).status, 'reopened');
  });
});

describe('undo and reopen', () => {
  test('undo reverts only the completion it names and restores unchanged steps', async () => {
    await seedChore('undo', { subTasks: ['Rinse', 'Dry'], completedSubTasks: ['Rinse'] });
    const [outcome] = await completeChoresAs(adminDb, sam, HOUSE, { choreIds: ['undo'], completeSubTasks: true }, AFTER_MIDNIGHT);
    assert.ok(outcome.status === 'completed');
    const restoreSubTasks = { from: outcome.completion.completedSubTasks, to: outcome.previousCompletedSubTasks! };
    const undone = await undoChoreCompletionAs(adminDb, HOUSE, { choreId: 'undo', completionId: outcome.completion.completionId!, restoreSubTasks });
    assert.equal(undone.status, 'undone');
    const stored = await read('undo');
    assert.equal(stored.isCompleted, false);
    for (const field of ['completedAt', 'completedAtServer', 'completedByUid', 'completedByEmail', 'completedByName', 'completionId']) {
      assert.equal(stored[field], undefined, `${field} cleared`);
    }
    assert.deepEqual(stored.completedSubTasks, ['Rinse']);
    assert.ok(undone.status === 'undone');
    assert.deepEqual(undone.completedSubTasks, ['Rinse'], 'the result carries the restored steps');
    assert.equal(stored.task, 'Dishes', 'other fields untouched');
  });

  test('undo with a stale completion id is a no-op', async () => {
    await seedChore('stale');
    const [first] = await completeChoresAs(adminDb, sam, HOUSE, { choreIds: ['stale'] }, AFTER_MIDNIGHT);
    assert.ok(first.status === 'completed');
    // Someone reopens and completes it again: a new completion with a new id.
    assert.equal((await reopenChoreAs(adminDb, HOUSE, { choreId: 'stale' })).status, 'reopened');
    const [second] = await completeChoresAs(adminDb, owner, HOUSE, { choreIds: ['stale'] }, AFTER_MIDNIGHT);
    assert.ok(second.status === 'completed');
    // Meanwhile the chore was renamed; the late Undo must not revert either change.
    await chores().doc('stale').update({ task: 'Dishes (renamed)' });

    const late = await undoChoreCompletionAs(adminDb, HOUSE, { choreId: 'stale', completionId: first.completion.completionId! });
    assert.equal(late.status, 'stale');
    const stored = await read('stale');
    assert.equal(stored.isCompleted, true);
    assert.equal(stored.completedByUid, owner.uid);
    assert.equal(stored.completionId, second.completion.completionId);
    assert.equal(stored.task, 'Dishes (renamed)');
  });

  test('steps changed after completion are not overwritten by undo', async () => {
    await seedChore('steps', { subTasks: ['Rinse', 'Dry'], completedSubTasks: [] });
    const [outcome] = await completeChoresAs(adminDb, sam, HOUSE, { choreIds: ['steps'], completeSubTasks: true }, AFTER_MIDNIGHT);
    assert.ok(outcome.status === 'completed');
    await chores().doc('steps').update({ completedSubTasks: ['Dry'] });
    const undone = await undoChoreCompletionAs(adminDb, HOUSE, {
      choreId: 'steps', completionId: outcome.completion.completionId!,
      restoreSubTasks: { from: outcome.completion.completedSubTasks, to: outcome.previousCompletedSubTasks! },
    });
    const stored = await read('steps');
    assert.equal(stored.isCompleted, false);
    assert.deepEqual(stored.completedSubTasks, ['Dry']);
    // The result carries the preserved steps, so the page shows them instead of the optimistic list.
    assert.ok(undone.status === 'undone');
    assert.deepEqual(undone.completedSubTasks, ['Dry']);
  });

  test('reopen clears the completion and its attribution', async () => {
    await seedChore('reopen');
    await completeChoresAs(adminDb, sam, HOUSE, { choreIds: ['reopen'] }, AFTER_MIDNIGHT);
    assert.equal((await reopenChoreAs(adminDb, HOUSE, { choreId: 'reopen' })).status, 'reopened');
    const stored = await read('reopen');
    assert.equal(stored.isCompleted, false);
    assert.equal(stored.completedByUid, undefined);
    assert.equal(stored.completedAtServer, undefined);
    assert.equal((await reopenChoreAs(adminDb, HOUSE, { choreId: 'reopen' })).status, 'open');
  });
});

describe('occurrence identity in upkeep (CH-3)', () => {
  test('reassigning a template never regenerates a completed day', async () => {
    const now = new Date('2026-11-05T15:00:00Z'); // Thursday 9am Chicago
    await house().collection('chore-templates').doc('trash').set({
      task: 'Trash', assignedToEmail: owner.email, roomIds: [],
      recurrence: { frequency: 'daily', assignedToEmail: owner.email },
    });
    await runHouseholdReminders(adminDb as never, HOUSE, now, ts);
    const todayId = recurringChoreId('trash', 'general', '2026-11-05', owner.email);
    assert.equal((await read(todayId)).occurrenceKey, 'trash|general|2026-11-05');
    const [done] = await completeChoresAs(adminDb, sam, HOUSE, { choreIds: [todayId] }, now);
    assert.equal(done.status, 'completed');

    // Reassign to Sam the way the app does: the template changes and its open chores go.
    const open = await chores().where('templateId', '==', 'trash').where('isCompleted', '==', false).get();
    await Promise.all(open.docs.map(d => d.ref.delete()));
    await house().collection('chore-templates').doc('trash').update({
      assignedToEmail: sam.email, recurrence: { frequency: 'daily', assignedToEmail: sam.email },
    });
    await runHouseholdReminders(adminDb as never, HOUSE, now, ts);

    const today = await chores().where('originalDueDate', '==', '2026-11-05').get();
    assert.equal(today.size, 1, 'the completed day is not regenerated for the new assignee');
    assert.equal(today.docs[0].id, todayId);
    const tomorrow = await chores().where('originalDueDate', '==', '2026-11-06').get();
    assert.equal(tomorrow.size, 1);
    // Generated by uid only (member privacy release C).
    assert.equal(tomorrow.docs[0].data().assignedToUid, sam.uid);
    assert.equal(tomorrow.docs[0].data().assignedToEmail, undefined);
  });

  test('a chore generated before occurrence keys still blocks its day', async () => {
    const now = new Date('2026-11-05T15:00:00Z');
    const legacyId = recurringChoreId('bins', 'garage', '2026-11-05', owner.email);
    // Written by an older upkeep (no occurrenceKey), completed, then moved to Friday.
    await seedChore(legacyId, {
      task: 'Bins', templateId: 'bins', roomIds: ['garage'], originalDueDate: '2026-11-06', isCompleted: true,
      completedAt: '2026-11-05T14:00:00.000Z',
    });
    await house().collection('chore-templates').doc('bins').set({
      task: 'Bins', assignedToEmail: sam.email, roomIds: ['garage'],
      recurrence: { frequency: 'daily', assignedToEmail: sam.email },
    });
    await runHouseholdReminders(adminDb as never, HOUSE, now, ts);
    const thursday = (await chores().where('templateId', '==', 'bins').get()).docs
      .filter(d => d.data().occurrenceKey === 'bins|garage|2026-11-05');
    assert.equal(thursday.length, 0, 'Thursday is recovered from the legacy id and not regenerated');
    const friday = (await chores().where('occurrenceKey', '==', 'bins|garage|2026-11-06').get()).docs;
    assert.equal(friday.length, 1, 'Friday still gets its own occurrence');
  });
});
