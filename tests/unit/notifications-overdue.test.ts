import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  decideOverdue, legacyOverdueNotificationIds, overdueNotificationId,
  type OverdueInput, type StoredOverdue,
} from '../../functions/src/shared/overdue-notification';
import { overdueChoresFor, overdueMessage } from '../../functions/src/shared/chore-reminders';
import { pushOnCreate, pushOnUpdate } from '../../functions/src/push-policy';

const TODAY = '2026-11-11';
const stored = (fields: Partial<StoredOverdue> = {}): StoredOverdue => ({
  resolved: false, overdueChoreIds: ['a'], notifiedChoreIds: ['a'], lastPushDay: '2026-11-10',
  nearExpiry: false, seenByRun: true, ...fields,
});
const decide = (fields: Partial<OverdueInput>) => decideOverdue({
  stored: null, overdueIds: [], today: TODAY, alertsAllowed: true, dailyReminderCovers: false, ...fields,
});

describe('overdue notification decision (NO-1)', () => {
  test('one stable id per person, and the dated ids it replaces', () => {
    assert.equal(overdueNotificationId('u1'), 'u1-overdue');
    const legacy = legacyOverdueNotificationIds('u1', TODAY);
    assert.equal(legacy[0], 'u1-overdue-2026-11-11');
    assert.equal(legacy.at(-1), 'u1-overdue-2026-11-03');
    assert.equal(legacy.length, 9);
  });

  test('nothing overdue and no document: nothing to do', () => {
    assert.deepEqual(decide({}), { action: 'none' });
  });

  test('first overdue chore creates it with a push', () => {
    const d = decide({ overdueIds: ['b', 'a', 'a'] });
    assert.equal(d.action, 'write');
    if (d.action !== 'write') return;
    assert.equal(d.create, true);
    assert.equal(d.push, true);
    assert.deepEqual(d.choreIds, ['a', 'b']);
    assert.deepEqual(d.notifiedChoreIds, ['a', 'b']);
    assert.equal(d.lastPushDay, TODAY);
  });

  test('the set grows: updated in place with a push and shown as new', () => {
    const d = decide({ stored: stored(), overdueIds: ['a', 'b'] });
    assert.equal(d.action, 'write');
    if (d.action !== 'write') return;
    assert.equal(d.create, false);
    assert.equal(d.push, true);
    assert.equal(d.fresh, true);
    assert.deepEqual(d.notifiedChoreIds, ['a', 'b']);
  });

  test('the set is unchanged: nothing written, no push', () => {
    assert.deepEqual(decide({ stored: stored(), overdueIds: ['a'] }), { action: 'none' });
  });

  test('the set shrinks: updated in place, no push, read state kept', () => {
    const d = decide({ stored: stored({ overdueChoreIds: ['a', 'b'], notifiedChoreIds: ['a', 'b'] }), overdueIds: ['b'] });
    assert.equal(d.action, 'write');
    if (d.action !== 'write') return;
    assert.equal(d.push, false);
    assert.equal(d.fresh, false);
    assert.deepEqual(d.choreIds, ['b']);
    assert.deepEqual(d.notifiedChoreIds, ['a', 'b']);
  });

  test('the set empties: resolved; resolving again does nothing', () => {
    assert.deepEqual(decide({ stored: stored(), overdueIds: [] }), { action: 'resolve' });
    assert.deepEqual(decide({ stored: stored({ resolved: true }), overdueIds: [] }), { action: 'none' });
  });

  test('at most one push a day: growth after a push the same day updates without a push', () => {
    const d = decide({ stored: stored({ lastPushDay: TODAY }), overdueIds: ['a', 'b'] });
    assert.equal(d.action, 'write');
    if (d.action !== 'write') return;
    assert.equal(d.push, false);
    assert.equal(d.fresh, true, 'still listed as new in the bell');
    assert.equal(d.lastPushDay, TODAY);
  });

  test('the daily reminder carries the overdue count: no separate push, counted as today’s', () => {
    const d = decide({ overdueIds: ['a'], dailyReminderCovers: true });
    assert.equal(d.action, 'write');
    if (d.action !== 'write') return;
    assert.equal(d.create, true);
    assert.equal(d.push, false);
    assert.equal(d.lastPushDay, TODAY);
  });

  test('dismissed then unchanged: never re-notified (dismissal is not part of the decision)', () => {
    // A dismissal is a client write after this run's reads: the run leaves the document alone.
    assert.deepEqual(decide({ stored: stored({ seenByRun: false }), overdueIds: ['a', 'b'] }), { action: 'none' });
    // Next run: same set, nothing to do.
    assert.deepEqual(decide({ stored: stored(), overdueIds: ['a'] }), { action: 'none' });
  });

  test('dismissed then grows: re-notified once (push, unread and undismissed)', () => {
    const d = decide({ stored: stored(), overdueIds: ['a', 'c'] });
    assert.equal(d.action, 'write');
    if (d.action !== 'write') return;
    assert.equal(d.push, true);
    assert.equal(d.fresh, true);
  });

  test('a resolved notification reopens as the same document; with a chore already told about, quietly', () => {
    const same = decide({ stored: stored({ resolved: true, overdueChoreIds: [] }), overdueIds: ['a'] });
    assert.equal(same.action, 'write');
    if (same.action !== 'write') return;
    assert.equal(same.reopen, true);
    assert.equal(same.create, false);
    assert.equal(same.push, false, 'an undone completion is not news');
    assert.equal(same.redate, true);
    const grown = decide({ stored: stored({ resolved: true, overdueChoreIds: [] }), overdueIds: ['c'] });
    assert.equal(grown.action === 'write' && grown.reopen && grown.push, true);
  });

  test('a resolution written after this run read its sources is not undone', () => {
    assert.deepEqual(decide({ stored: stored({ resolved: true, seenByRun: false }), overdueIds: ['c'] }), { action: 'none' });
  });

  test('before the morning threshold nothing new is announced, but the list still shrinks', () => {
    assert.deepEqual(decide({ overdueIds: ['a'], alertsAllowed: false }), { action: 'none' });
    assert.deepEqual(decide({ stored: stored(), overdueIds: ['a', 'b'], alertsAllowed: false }), { action: 'none' });
    assert.deepEqual(decide({ stored: stored(), overdueIds: [], alertsAllowed: false }), { action: 'resolve' });
  });

  test('an unchanged notification close to expiry is re-dated without a push', () => {
    const d = decide({ stored: stored({ nearExpiry: true }), overdueIds: ['a'] });
    assert.equal(d.action, 'write');
    if (d.action !== 'write') return;
    assert.equal(d.push, false);
    assert.equal(d.fresh, false);
    assert.equal(d.redate, true);
  });

  test('a week of hourly runs with one chore overdue pushes once', () => {
    let state: StoredOverdue | null = null;
    let pushes = 0;
    for (let day = 11; day <= 17; day++) {
      for (let hour = 7; hour < 24; hour++) {
        const d = decideOverdue({ stored: state, overdueIds: ['a'], today: `2026-11-${day}`, alertsAllowed: true, dailyReminderCovers: false });
        if (d.action !== 'write') continue;
        if (d.push) pushes++;
        state = { resolved: false, overdueChoreIds: d.choreIds, notifiedChoreIds: d.notifiedChoreIds, lastPushDay: d.lastPushDay, nearExpiry: false, seenByRun: true };
      }
    }
    assert.equal(pushes, 1);
  });
});

describe('overdue view and message', () => {
  const person = { uid: 'u1', email: 'sam@example.test', timeZone: 'America/Chicago', reminderEnabled: true, reminderTime: '17:00' };
  const chores = [
    { id: 'a', task: 'Trash', assignedToUid: 'u1', originalDueDate: '2026-11-04' },
    { id: 'b', task: 'Dishes', assignedToUid: 'u1', originalDueDate: '2026-11-05' },
    { id: 'c', task: 'Done', assignedToUid: 'u1', originalDueDate: '2026-11-01', isCompleted: true },
    { id: 'd', task: 'Other', assignedToUid: 'u2', originalDueDate: '2026-11-01' },
  ];

  test('only the person’s incomplete chores due before their today', () => {
    const view = overdueChoresFor(person, chores, new Date('2026-11-05T14:00:00Z')); // 8am Chicago
    assert.deepEqual(view.chores, [{ id: 'a', task: 'Trash' }]);
    assert.equal(view.today, '2026-11-05');
    assert.equal(view.alertsAllowed, true);
    assert.equal(view.dailyReminderPending, true, '5pm reminder still to come');
    const night = overdueChoresFor(person, chores, new Date('2026-11-05T08:00:00Z')); // 2am
    assert.equal(night.alertsAllowed, false);
    const evening = overdueChoresFor(person, chores, new Date('2026-11-05T23:30:00Z'));
    assert.equal(evening.dailyReminderPending, false);
    assert.equal(overdueChoresFor({ ...person, reminderEnabled: false }, chores, new Date('2026-11-05T14:00:00Z')).dailyReminderPending, false);
  });

  test('message', () => {
    assert.equal(overdueMessage(['Trash']), '"Trash" is overdue.');
    assert.equal(overdueMessage(['Trash', 'Dishes']), 'You have 2 overdue chores.');
  });
});

describe('push on create and on renotify', () => {
  const at = (seconds: number) => ({ seconds, nanoseconds: 0 });
  test('silent creations are not pushed', () => {
    assert.equal(pushOnCreate({}), true);
    assert.equal(pushOnCreate({ silent: true }), false);
  });
  test('an update is pushed only when renotifyAt moves on an active notification', () => {
    assert.equal(pushOnUpdate({}, { readBy: { u1: {} } }), false, 'read/dismiss');
    assert.equal(pushOnUpdate({ renotifyAt: at(1) }, { renotifyAt: at(1), message: 'x' }), false, 'shrink or refresh');
    assert.equal(pushOnUpdate({}, { renotifyAt: at(1) }), true);
    assert.equal(pushOnUpdate({ renotifyAt: at(1) }, { renotifyAt: at(2) }), true);
    assert.equal(pushOnUpdate({ renotifyAt: at(1) }, { renotifyAt: at(2), resolvedAt: at(3) }), false);
  });
});
