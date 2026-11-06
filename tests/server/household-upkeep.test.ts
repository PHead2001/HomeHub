import assert from 'node:assert/strict';
import { after, beforeEach, describe, test } from 'node:test';
import { Timestamp } from 'firebase-admin/firestore';
import { adminDb } from '../../src/lib/server/firebase-admin';
import { runHouseholdReminders } from '../../functions/src/reminders';

// The hourly Cloud Function's per-household step, against the Firestore emulator.
const HOUSE = 'upkeep-house';
const ts = (d: Date) => Timestamp.fromDate(d) as never;
const run = (now: Date) => runHouseholdReminders(adminDb as never, HOUSE, now, ts);
const house = () => adminDb.collection('households').doc(HOUSE);

beforeEach(async () => {
  await adminDb.recursiveDelete(house());
  await house().set({ name: 'Upkeep', ownerUid: 'o1', timeZone: 'America/Chicago', memberEmails: [] });
  await house().collection('members').doc('o1').set({ uid: 'o1', email: 'owner@example.test', role: 'owner', status: 'active', displayName: 'Owner' });
  await house().collection('members').doc('p1').set({ uid: 'p1', email: 'pending@example.test', role: 'newuser', status: 'pending' });
  await adminDb.collection('users').doc('owner@example.test').set({ email: 'owner@example.test', choreSettings: { reminderEnabled: true, reminderTime: '17:00' } });
  await house().collection('chore-templates').doc('trash').set({
    task: 'Trash', assignedToEmail: 'owner@example.test', roomIds: [],
    recurrence: { frequency: 'weekly', weeklyOptions: { daysOfWeek: [4] }, assignedToEmail: 'owner@example.test' },
  });
  await house().collection('chore-templates').doc('ghost').set({
    task: 'Ghost', assignedToEmail: 'pending@example.test',
    recurrence: { frequency: 'daily', assignedToEmail: 'pending@example.test' },
  });
  await house().collection('home-assets').doc('hvac').set({ name: 'Main HVAC', schedules: [{ id: 's1', scheduleName: 'Replace filter', nextDueDate: '2026-10-01' }] });
});

after(async () => {
  await adminDb.recursiveDelete(house());
  await adminDb.collection('users').doc('owner@example.test').delete();
});

describe('household upkeep', () => {
  test('generates recurring chores for approved members only, idempotently', async () => {
    const now = new Date('2026-11-05T15:00:00Z'); // Thursday 9am Chicago
    const first = await run(now);
    assert.equal(first.generatedChores, 30);
    const chores = await house().collection('chores').get();
    assert.equal(chores.size, 30);
    assert.ok(chores.docs.every(d => d.data().task === 'Trash'), 'nothing generated for a pending member');
    const firstDue = chores.docs.map(d => d.data().originalDueDate).sort()[0];
    assert.equal(firstDue, '2026-11-05');
    assert.equal(chores.docs.find(d => d.data().originalDueDate === '2026-11-05')?.data().dueDate, '2026-11-05T06:00:00.000Z');

    const second = await run(now);
    assert.equal(second.generatedChores, 0);
    assert.equal((await house().collection('chores').get()).size, 30);
  });

  test('maintenance reminders are created once and refreshed while still overdue', async () => {
    const now = new Date('2026-11-05T15:00:00Z');
    await run(now);
    const notes = await house().collection('notifications').where('category', '==', 'maintenance').get();
    assert.equal(notes.size, 1);
    assert.equal(notes.docs[0].data().message, 'Replace filter for Main HVAC is overdue.');
    assert.equal((await run(now)).createdNotifications, 0);

    const eightDaysLater = new Date(now.getTime() + 8 * 86400000);
    const later = await run(eightDaysLater);
    assert.equal(later.refreshedNotifications, 1, 'an expired but still-overdue reminder stays visible');
    const refreshed = await house().collection('notifications').where('category', '==', 'maintenance').get();
    assert.equal(refreshed.size, 1);
    // Clients list the last 7 days by createdAt, so the refresh must move it.
    assert.equal(refreshed.docs[0].data().createdAt.toDate().toISOString(), eightDaysLater.toISOString());
  });

  test('chore reminders respect the member’s reminder time and never duplicate', async () => {
    await run(new Date('2026-11-05T15:00:00Z')); // 9am: before the 5pm reminder
    const morning = await house().collection('notifications').where('sourceType', '==', 'chore-reminder').get();
    assert.equal(morning.size, 0);
    await run(new Date('2026-11-05T23:30:00Z')); // 5:30pm
    await run(new Date('2026-11-05T23:45:00Z'));
    const evening = await house().collection('notifications').where('sourceType', '==', 'chore-reminder').get();
    assert.deepEqual(evening.docs.map(d => d.id), ['o1-reminder-2026-11-05']);
    assert.equal(evening.docs[0].data().targetUserUid, 'o1');
  });

  test('a run after the reminder time includes the chores it just generated', async () => {
    // First run ever, at 5:30pm Thursday: the Thursday trash chore does not exist yet.
    await run(new Date('2026-11-05T23:30:00Z'));
    const reminder = await house().collection('notifications').doc('o1-reminder-2026-11-05').get();
    assert.equal(reminder.exists, true, 'reminder sent in the same run that generated the chore');
    assert.equal(reminder.data()?.message, '1 chore due today.');
  });

  test('completed chores older than 90 days are removed; recent ones are kept', async () => {
    await house().collection('chores').doc('old').set({ task: 'Old', isCompleted: true, completedAt: '2026-07-01T12:00:00.000Z' });
    await house().collection('chores').doc('recent').set({ task: 'Recent', isCompleted: true, completedAt: '2026-10-30T12:00:00.000Z' });
    const result = await run(new Date('2026-11-05T15:00:00Z'));
    assert.equal(result.purgedChores, 1);
    assert.equal((await house().collection('chores').doc('old').get()).exists, false);
    assert.equal((await house().collection('chores').doc('recent').get()).exists, true);
  });
});
