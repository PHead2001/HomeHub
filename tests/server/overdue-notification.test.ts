import assert from 'node:assert/strict';
import { after, beforeEach, describe, test } from 'node:test';
import { Timestamp } from 'firebase-admin/firestore';
import { adminDb } from '../../src/lib/server/firebase-admin';
import { runHouseholdReminders } from '../../functions/src/reminders';
import { parseNotificationDoc } from '../../src/lib/notifications';
import { activeBellNotifications } from '../../src/lib/dashboard/notification-display';

// NO-1: one overdue-chores notification per person, updated in place, against the Firestore emulator.
const HOUSE = 'overdue-house';
const EMAIL = 'overdue-owner@example.test';
const ts = (d: Date) => Timestamp.fromDate(d) as never;
const run = (now: Date) => runHouseholdReminders(adminDb as never, HOUSE, now, ts);
const house = () => adminDb.collection('households').doc(HOUSE);
const notes = () => house().collection('notifications');
const stable = () => notes().doc('o1-overdue');
const chore = (id: string, task: string, day: string, fields: Record<string, unknown> = {}) =>
  house().collection('chores').doc(id).set({
    task, assignedToUid: 'o1', assignedToEmail: EMAIL, originalDueDate: day,
    dueDate: `${day}T06:00:00.000Z`, isCompleted: false, ...fields,
  });
const choreReminders = async () =>
  (await notes().where('sourceType', '==', 'chore-reminder').get()).docs.map(d => d.id).sort();
// Chicago is UTC-6 in November.
const at = (day: string, hour: number) => new Date(`${day}T${String(hour + 6).padStart(2, '0')}:00:00Z`);

beforeEach(async () => {
  await adminDb.recursiveDelete(house());
  await house().set({ name: 'Overdue', ownerUid: 'o1', timeZone: 'America/Chicago', memberEmails: [] });
  await house().collection('members').doc('o1').set({ uid: 'o1', email: EMAIL, role: 'owner', status: 'active', displayName: 'Owner' });
  await adminDb.collection('users').doc(EMAIL).set({ email: EMAIL, choreSettings: { reminderEnabled: false } });
  await chore('sweep', 'Sweep floor', '2026-11-04');
});

after(async () => {
  await adminDb.recursiveDelete(house());
  await adminDb.collection('users').doc(EMAIL).delete();
});

describe('overdue chores notification (NO-1)', () => {
  test('one stable document per person, addressed to them, never a new one per day', async () => {
    assert.equal((await run(at('2026-11-05', 2))).createdNotifications, 0, 'nothing at night');
    assert.equal((await run(at('2026-11-05', 8))).createdNotifications, 1);
    const first = (await stable().get()).data()!;
    assert.equal(first.targetUserUid, 'o1');
    assert.deepEqual(first.audience, ['o1']);
    assert.equal(first.title, 'Overdue chores');
    assert.equal(first.message, '"Sweep floor" is overdue.');
    assert.equal(first.deepLink, '/chores?due=overdue');
    assert.equal(first.silent, undefined, 'created with a push');
    assert.equal(first.lastPushDay, '2026-11-05');
    assert.equal('targetUserEmail' in first, false);

    for (const day of ['2026-11-06', '2026-11-07', '2026-11-08']) {
      await run(at(day, 8));
      await run(at(day, 15));
    }
    assert.deepEqual(await choreReminders(), ['o1-overdue']);
    const later = (await stable().get()).data()!;
    assert.equal(later.renotifyAt, undefined, 'the same set never pushes again');
    assert.equal(later.createdAt.toMillis(), first.createdAt.toMillis(), 'not re-dated while unchanged');
  });

  test('a newly overdue chore re-notifies once a day; the bell shows it once', async () => {
    await run(at('2026-11-05', 8));
    await stable().update({ 'readBy.o1': { at: 'x' }, 'dismissedBy.o1': { at: 'x' } });
    await chore('dishes', 'Dishes', '2026-11-05');
    const now = at('2026-11-06', 8);
    await run(now);
    let data = (await stable().get()).data()!;
    assert.equal(data.message, 'You have 2 overdue chores.');
    assert.equal(data.renotifyAt.toMillis(), now.getTime(), 'push requested');
    assert.deepEqual(data.readBy, {}, 'unread again');
    assert.deepEqual(data.dismissedBy, {}, 'undismissed');
    assert.deepEqual(data.overdueChoreIds, ['dishes', 'sweep']);

    // Another one the same day: listed, but no second push today.
    await chore('mop', 'Mop', '2026-11-05');
    await run(at('2026-11-06', 12));
    data = (await stable().get()).data()!;
    assert.equal(data.message, 'You have 3 overdue chores.');
    assert.equal(data.renotifyAt.toMillis(), now.getTime(), 'no second push the same day');

    const bell = activeBellNotifications(
      (await notes().get()).docs.map(d => parseNotificationDoc(d as never)), { uid: 'o1', email: EMAIL }, at('2026-11-06', 13));
    assert.equal(bell.filter(n => n.sourceType === 'chore-reminder').length, 1);
  });

  test('a dismissal holds while the set is unchanged or shrinks', async () => {
    await chore('dishes', 'Dishes', '2026-11-04');
    await run(at('2026-11-05', 8));
    await stable().update({ 'dismissedBy.o1': { at: 'x' } });
    await run(at('2026-11-05', 9));
    await house().collection('chores').doc('dishes').update({ isCompleted: true });
    await run(at('2026-11-05', 10));
    const data = (await stable().get()).data()!;
    assert.equal(data.message, '"Sweep floor" is overdue.', 'shrunk in place');
    assert.deepEqual(data.dismissedBy, { o1: { at: 'x' } });
    assert.equal(data.renotifyAt, undefined);
  });

  test('resolved when nothing is overdue, reopened as the same document when something is again', async () => {
    await run(at('2026-11-05', 8));
    await house().collection('chores').doc('sweep').update({ isCompleted: true });
    assert.equal((await run(at('2026-11-05', 9))).resolvedNotifications, 1);
    let data = (await stable().get()).data()!;
    assert.ok(data.resolvedAt);
    assert.deepEqual(data.overdueChoreIds, []);
    assert.equal(activeBellNotifications([parseNotificationDoc((await stable().get()) as never)], { uid: 'o1', email: EMAIL }, at('2026-11-05', 9)).length, 0);

    // The completion is undone: same chore, already told about, so no push.
    await house().collection('chores').doc('sweep').update({ isCompleted: false });
    assert.equal((await run(at('2026-11-05', 10))).reopenedNotifications, 1);
    data = (await stable().get()).data()!;
    assert.equal(data.resolvedAt, null);
    assert.equal(data.renotifyAt, undefined);

    // Resolved again; the next day a different chore is overdue: same document, with a push.
    await house().collection('chores').doc('sweep').update({ isCompleted: true });
    await run(at('2026-11-05', 11));
    await chore('dishes', 'Dishes', '2026-11-05');
    const now = at('2026-11-06', 8);
    assert.equal((await run(now)).reopenedNotifications, 1);
    data = (await stable().get()).data()!;
    assert.equal(data.resolvedAt, null);
    assert.equal(data.message, '"Dishes" is overdue.');
    assert.equal(data.renotifyAt.toMillis(), now.getTime());
    assert.deepEqual(await choreReminders(), ['o1-overdue']);
  });

  test('the daily reminder carries the overdue count: the overdue notification is created silently', async () => {
    await adminDb.collection('users').doc(EMAIL).set({ email: EMAIL, choreSettings: { reminderEnabled: true, reminderTime: '17:00' } });
    await run(at('2026-11-05', 8));
    const data = (await stable().get()).data()!;
    assert.equal(data.silent, true, 'no push: the 5pm reminder says "1 overdue"');
    assert.equal(data.lastPushDay, '2026-11-05');
    await run(at('2026-11-05', 17));
    const reminder = (await notes().doc('o1-reminder-2026-11-05').get()).data()!;
    assert.equal(reminder.message, '1 chore still overdue.');
    assert.equal((await stable().get()).data()!.renotifyAt, undefined);
  });

  test('dated overdue documents from earlier versions are removed for that person only', async () => {
    const dated = (id: string, uid: string, day: string) => notes().doc(id).set({
      householdId: HOUSE, category: 'chores', title: 'Overdue chores', message: '"Sweep floor" is overdue.',
      sourceType: 'chore-reminder', sourceId: `overdue-${day}`, targetUserUid: uid, audience: [uid],
      createdAt: Timestamp.fromDate(new Date(`${day}T14:00:00Z`)), expiresAt: Timestamp.fromDate(new Date('2026-11-20T00:00:00Z')),
      readBy: {}, dismissedBy: {},
    });
    await dated('o1-overdue-2026-11-04', 'o1', '2026-11-04');
    await dated('o1-overdue-2026-11-05', 'o1', '2026-11-05');
    await dated('x1-overdue-2026-11-05', 'x1', '2026-11-05');
    await run(at('2026-11-05', 8));
    assert.deepEqual(await choreReminders(), ['o1-overdue', 'x1-overdue-2026-11-05']);

    // Without a write, they are also swept in the first hour of the person's day.
    await dated('o1-overdue-2026-11-06', 'o1', '2026-11-06');
    await run(at('2026-11-06', 0));
    assert.deepEqual(await choreReminders(), ['o1-overdue', 'x1-overdue-2026-11-05']);
  });

  test('a household being deleted gets no overdue notification', async () => {
    await house().update({ deletingAt: Timestamp.now() });
    await run(at('2026-11-05', 8));
    assert.deepEqual(await choreReminders(), []);
  });
});
