import assert from 'node:assert/strict';
import { after, beforeEach, describe, test } from 'node:test';
import { Timestamp } from 'firebase-admin/firestore';
import { adminDb } from '../../src/lib/server/firebase-admin';
import { runHouseholdReminders } from '../../functions/src/reminders';
import { choreOccurrenceKey } from '../../functions/src/shared/ids';

// CH-28: upkeep assigns each generated day of a rotating chore by occurrence number.
const HOUSE = 'rotation-house';
const ts = (d: Date) => Timestamp.fromDate(d) as never;
const run = (iso: string) => runHouseholdReminders(adminDb as never, HOUSE, new Date(iso), ts);
const house = () => adminDb.collection('households').doc(HOUSE);
const member = (uid: string, extra: Record<string, unknown> = {}) =>
  house().collection('members').doc(uid).set({ uid, role: 'member', status: 'active', displayName: uid.toUpperCase(), ...extra });
const byDay = async () => new Map((await house().collection('chores').get()).docs
  .map(d => [d.get('originalDueDate') as string, d.get('assignedToUid') as string]));

beforeEach(async () => {
  await adminDb.recursiveDelete(house());
  await house().set({ name: 'Rotation', ownerUid: 'a', timeZone: 'America/Chicago', memberEmails: [] });
  await member('a', { role: 'owner' });
  await member('b');
  await member('c');
  // Mon/Wed/Fri, taking turns a -> b -> c from Monday Nov 2, 2026.
  await house().collection('chore-templates').doc('trash').set({
    task: 'Trash', assignedToUid: 'a', roomIds: [],
    recurrence: { frequency: 'weekly', weeklyOptions: { daysOfWeek: [1, 3, 5] } },
    rotation: ['a', 'b', 'c'], rotationStart: '2026-11-02',
  });
});

after(async () => {
  await adminDb.recursiveDelete(house());
});

describe('rotating repeating chores', () => {
  test('each occurrence goes to whoever\'s turn it is, counted from rotationStart', async () => {
    await run('2026-11-02T15:00:00Z'); // Monday 9am Chicago
    const days = await byDay();
    assert.deepEqual(['2026-11-02', '2026-11-04', '2026-11-06', '2026-11-09', '2026-11-11'].map(day => days.get(day)), ['a', 'b', 'c', 'a', 'b']);
    const chore = (await house().collection('chores').where('originalDueDate', '==', '2026-11-04').get()).docs[0];
    assert.equal(chore.get('occurrenceKey'), choreOccurrenceKey('trash', 'general', '2026-11-04'));
    assert.equal(chore.get('assignedToDisplayName'), 'B');
  });

  test('a later run (after skips and an open day deleted) gives every day the same person', async () => {
    await run('2026-11-02T15:00:00Z');
    const first = await byDay();
    // Skip Wednesday (CH-3) and delete Friday's open chore: Friday comes back, Wednesday does not.
    const wednesday = (await house().collection('chores').where('originalDueDate', '==', '2026-11-04').get()).docs[0];
    await wednesday.ref.delete();
    await house().collection('chore-templates').doc('trash').update({ skippedOccurrences: [choreOccurrenceKey('trash', 'general', '2026-11-04')] });
    const friday = (await house().collection('chores').where('originalDueDate', '==', '2026-11-06').get()).docs[0];
    await friday.ref.delete();
    await run('2026-11-04T15:00:00Z');
    const second = await byDay();
    assert.equal(second.has('2026-11-04'), false, 'the skipped day stays skipped');
    assert.equal(second.get('2026-11-06'), 'c', 'the skip does not shift anyone');
    for (const [day, uid] of second) if (first.has(day)) assert.equal(uid, first.get(day), day);
  });

  test('a completed day keeps its person and is never generated twice', async () => {
    await run('2026-11-02T15:00:00Z');
    const monday = (await house().collection('chores').where('originalDueDate', '==', '2026-11-02').get()).docs[0];
    await monday.ref.update({ isCompleted: true, completedAt: '2026-11-02T16:00:00.000Z', completedByUid: 'a' });
    await house().collection('chore-templates').doc('trash').update({ rotation: ['c', 'b', 'a'], rotationStart: '2026-11-02' });
    await run('2026-11-02T17:00:00Z');
    const mondays = (await house().collection('chores').where('originalDueDate', '==', '2026-11-02').get()).docs;
    assert.equal(mondays.length, 1);
    assert.equal(mondays[0].get('assignedToUid'), 'a');
  });

  test('someone who left, or a kid profile, passes the turn to the next person', async () => {
    await house().collection('members').doc('b').delete();
    await member('c', { kind: 'identity', role: 'child' });
    await run('2026-11-02T15:00:00Z');
    const days = await byDay();
    assert.deepEqual(['2026-11-02', '2026-11-04', '2026-11-06'].map(day => days.get(day)), ['a', 'a', 'a']);
  });
});
