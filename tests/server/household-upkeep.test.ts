import assert from 'node:assert/strict';
import { after, beforeEach, describe, test } from 'node:test';
import { Timestamp } from 'firebase-admin/firestore';
import { adminDb } from '../../src/lib/server/firebase-admin';
import { runHouseholdReminders } from '../../functions/src/reminders';
import { choreStatsAssigneeKey } from '../../functions/src/shared/ids';

// The hourly Cloud Function's per-household step, against the Firestore emulator.
const HOUSE = 'upkeep-house';
const ts = (d: Date) => Timestamp.fromDate(d) as never;
const run = (now: Date) => runHouseholdReminders(adminDb as never, HOUSE, now, ts);
const house = () => adminDb.collection('households').doc(HOUSE);

// The real database, except that listing one of this household's subcollections
// returns a stale result: the view of a run that read before someone else committed.
const bind = <T extends object>(target: T, override: (key: PropertyKey) => unknown) =>
  new Proxy(target, {
    get(obj, key) {
      const replaced = override(key);
      if (replaced !== undefined) return replaced;
      const value = Reflect.get(obj, key, obj);
      return typeof value === 'function' ? value.bind(obj) : value;
    },
  });
const staleListingDb = (staleSub: string, listing: unknown) => bind(adminDb, key => key === 'collection'
  ? (name: string) => bind(adminDb.collection(name), k => k === 'doc'
    ? (id: string) => bind(adminDb.collection(name).doc(id), d => d === 'collection'
      ? (sub: string) => sub === staleSub
        ? bind(adminDb.collection(name).doc(id).collection(sub), c => c === 'get' ? async () => listing : undefined)
        : adminDb.collection(name).doc(id).collection(sub)
      : undefined)
    : undefined)
  : undefined);
const staleChoresDb = () => staleListingDb('chores', { docs: [] });

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

  test('a still-overdue reminder is refreshed before TTL could delete it, keeping its state', async () => {
    const now = new Date('2026-11-05T15:00:00Z');
    await run(now);
    const ref = (await house().collection('notifications').where('category', '==', 'maintenance').get()).docs[0].ref;
    await ref.update({ 'dismissedBy.o1': true, 'readBy.o1': true });
    // Five days in: not expired yet (expiry is day 7) but within the 2-day margin.
    assert.equal((await run(new Date(now.getTime() + 4 * 86400000))).refreshedNotifications, 0, 'not refreshed early');
    const fiveDays = new Date(now.getTime() + 5.5 * 86400000);
    assert.equal((await run(fiveDays)).refreshedNotifications, 1, 'refreshed before expiry');
    const data = (await ref.get()).data()!;
    assert.ok(data.expiresAt.toDate() > new Date(fiveDays.getTime() + 6 * 86400000), 'expiry pushed out');
    assert.equal(data.dismissedBy.o1, true, 'dismissal kept');
    assert.equal(data.readBy.o1, true, 'read state kept');
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

  test('a run with a stale view never resets a chore completed in the meantime', async () => {
    const now = new Date('2026-11-05T15:00:00Z');
    await run(now);
    const thursday = (await house().collection('chores').where('originalDueDate', '==', '2026-11-05').get()).docs[0];
    await thursday.ref.update({ isCompleted: true, completedAt: '2026-11-05T15:05:00.000Z' });
    // A second, overlapping run that read the chores before the first one committed.
    const result = await runHouseholdReminders(staleChoresDb() as never, HOUSE, now, ts);
    assert.equal(result.generatedChores, 0, 'nothing re-created');
    const after = (await thursday.ref.get()).data();
    assert.equal(after?.isCompleted, true);
    assert.equal(after?.completedAt, '2026-11-05T15:05:00.000Z');
  });

  test('a run with a stale template never recreates a cancelled or edited recurrence', async () => {
    const now = new Date('2026-11-05T15:00:00Z');
    const trash = () => house().collection('chores').where('templateId', '==', 'trash').get();
    // Cancelled after the run read the templates.
    let stale = await house().collection('chore-templates').get();
    await house().collection('chore-templates').doc('trash').delete();
    let result = await runHouseholdReminders(staleListingDb('chore-templates', stale) as never, HOUSE, now, ts);
    assert.equal(result.generatedChores, 0);
    assert.equal((await trash()).size, 0, 'a cancelled recurrence is not repopulated');
    // Edited (reassigned) after the run read the templates.
    await house().collection('chore-templates').doc('trash').set({
      task: 'Trash', assignedToEmail: 'owner@example.test', roomIds: [],
      recurrence: { frequency: 'weekly', weeklyOptions: { daysOfWeek: [4] }, assignedToEmail: 'owner@example.test' },
    });
    stale = await house().collection('chore-templates').get();
    await house().collection('chore-templates').doc('trash').update({ task: 'Trash and recycling' });
    result = await runHouseholdReminders(staleListingDb('chore-templates', stale) as never, HOUSE, now, ts);
    assert.equal((await trash()).size, 0, 'nothing generated from the pre-edit template');
    // The next run sees the current template and generates from it.
    await run(now);
    const fresh = await trash();
    assert.equal(fresh.size, 30);
    assert.ok(fresh.docs.every(d => d.data().task === 'Trash and recycling'));
  });

  test('a household being deleted gets no upkeep writes', async () => {
    await house().update({ deletingAt: new Date() });
    const result = await run(new Date('2026-11-05T23:30:00Z'));
    assert.equal(result.generatedChores, 0);
    assert.equal((await house().collection('chores').get()).size, 0);
    assert.equal((await house().collection('notifications').get()).size, 0);
  });

  test('completed chores older than 90 days are removed; recent ones are kept', async () => {
    await house().collection('chores').doc('old').set({ task: 'Old', isCompleted: true, completedAt: '2026-07-01T12:00:00.000Z' });
    await house().collection('chores').doc('recent').set({ task: 'Recent', isCompleted: true, completedAt: '2026-10-30T12:00:00.000Z' });
    const result = await run(new Date('2026-11-05T15:00:00Z'));
    assert.equal(result.purgedChores, 1);
    assert.equal((await house().collection('chores').doc('old').get()).exists, false);
    assert.equal((await house().collection('chores').doc('recent').get()).exists, true);
  });

  test("a purged chore is added to its year's stats exactly once, even when upkeep runs twice", async () => {
    const chores = house().collection('chores');
    await chores.doc('old-sam').set({ task: 'Old', isCompleted: true, completedAt: '2026-07-01T12:00:00.000Z', assignedToEmail: 'Sam.Member@example.test', assignedToDisplayName: 'Sam Member' });
    await chores.doc('old-sam-2').set({ task: 'Older', isCompleted: true, completedAt: '2026-06-01T12:00:00.000Z', assignedToEmail: 'sam.member@example.test', assignedToDisplayName: 'Sam Member' });
    // Completed just after New Year in UTC, but still Dec 31 in the household's timezone (Chicago).
    await chores.doc('new-year').set({ task: 'Party', isCompleted: true, completedAt: '2026-01-01T03:00:00.000Z', assignedToEmail: 'owner@example.test' });
    await chores.doc('recent').set({ task: 'Recent', isCompleted: true, completedAt: '2026-10-30T12:00:00.000Z', assignedToEmail: 'owner@example.test' });
    const key = choreStatsAssigneeKey('sam.member@example.test');

    const first = await run(new Date('2026-11-05T15:00:00Z'));
    assert.equal(first.purgedChores, 3);
    const stats2026 = (await house().collection('stats').doc('chores-2026').get()).data();
    assert.equal(stats2026?.year, 2026);
    assert.equal(stats2026?.completed, 2);
    assert.deepEqual(stats2026?.byAssignee, { [key]: 2 });
    assert.equal(stats2026?.names?.[key], 'Sam Member');
    const stats2025 = (await house().collection('stats').doc('chores-2025').get()).data();
    assert.equal(stats2025?.completed, 1);

    // Nothing left to purge: a second run counts nothing again.
    const second = await run(new Date('2026-11-05T16:00:00Z'));
    assert.equal(second.purgedChores, 0);
    assert.equal((await house().collection('stats').doc('chores-2026').get()).data()?.completed, 2);
    assert.equal((await house().collection('chores').doc('recent').get()).exists, true);
  });
});
