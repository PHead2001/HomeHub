import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  decideOverdue, legacyOverdueNotificationIds, NOTIFIED_HISTORY_CAP, OVERDUE_LIST_CAP, legacyOverdueState, overdueNotificationId,
  type OverdueInput, type StoredOverdue,
} from '../../functions/src/shared/overdue-notification';
import { overdueChoresFor, overdueMessage } from '../../functions/src/shared/chore-reminders';
import { pushOnCreate, pushOnUpdate } from '../../functions/src/push-policy';
import { recurringChoreId } from '../../functions/src/shared/ids';

const TODAY = '2026-11-11';
const stored = (fields: Partial<StoredOverdue> = {}): StoredOverdue => ({
  resolved: false, overdueChoreIds: ['a'], notifiedChoreIds: ['a'], lastPushDay: '2026-11-10',
  nearExpiry: false, seenByRun: true, ...fields,
});
const EXISTING = new Set(['a', 'b', 'c']);
const decide = (fields: Partial<OverdueInput>) => decideOverdue({
  stored: null, overdueIds: [], today: TODAY, alertsAllowed: true, reminderSentNow: false, reminderPending: false, existingChoreIds: EXISTING, ...fields,
});
const after = (d: ReturnType<typeof decideOverdue>, prev: StoredOverdue | null): StoredOverdue | null => {
  if (d.action === 'none') return prev;
  if (d.action === 'resolve') return { ...prev!, resolved: true, overdueChoreIds: [] };
  return { resolved: false, overdueChoreIds: d.choreIds, notifiedChoreIds: d.notifiedChoreIds, lastPushDay: d.lastPushDay, nearExpiry: false, seenByRun: true };
};

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

  test('a daily reminder later today carries the overdue count: no separate push, counted as today’s', () => {
    const d = decide({ overdueIds: ['a'], reminderPending: true });
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
        const d = decideOverdue({ stored: state, overdueIds: ['a'], today: `2026-11-${day}`, alertsAllowed: true, reminderSentNow: false, reminderPending: false, existingChoreIds: EXISTING });
        if (d.action !== 'write') continue;
        if (d.push) pushes++;
        state = { resolved: false, overdueChoreIds: d.choreIds, notifiedChoreIds: d.notifiedChoreIds, lastPushDay: d.lastPushDay, nearExpiry: false, seenByRun: true };
      }
    }
    assert.equal(pushes, 1);
  });

  test('announce A; A completed and B announced; A’s completion undone: A is not news', () => {
    let state = after(decide({ overdueIds: ['a'], today: '2026-11-11' }), null);
    // Next day: A done, B overdue.
    const b = decide({ stored: state, overdueIds: ['b'], today: '2026-11-12' });
    assert.equal(b.action === 'write' && b.push, true);
    assert.deepEqual(b.action === 'write' && b.notifiedChoreIds, ['a', 'b'], 'A is remembered');
    state = after(b, state);
    // A later day: A's completion is undone.
    const undo = decide({ stored: state, overdueIds: ['a', 'b'], today: '2026-11-14' });
    assert.equal(undo.action, 'write', 'the list changed');
    if (undo.action !== 'write') return;
    assert.equal(undo.push, false);
    assert.equal(undo.fresh, false, 'read and dismissed state kept');
    // Same after a resolution in between (A undone while nothing else is overdue).
    const resolved = after(decide({ stored: state, overdueIds: [], today: '2026-11-13' }), state);
    const reopened = decide({ stored: resolved, overdueIds: ['a'], today: '2026-11-14' });
    assert.equal(reopened.action === 'write' && reopened.reopen && !reopened.push && !reopened.fresh, true);
  });

  test('a recurring chore’s next occurrence has its own ID, so it is news', () => {
    const tue = recurringChoreId('trash', 'general', '2026-11-10', 'uid-sam');
    const wed = recurringChoreId('trash', 'general', '2026-11-11', 'uid-sam');
    assert.notEqual(tue, wed);
    const existing = new Set([tue, wed]);
    const state = after(decideOverdue({ stored: null, overdueIds: [tue], today: '2026-11-11', alertsAllowed: true, reminderSentNow: false, reminderPending: false, existingChoreIds: existing }), null);
    const next = decideOverdue({ stored: state, overdueIds: [wed], today: '2026-11-12', alertsAllowed: true, reminderSentNow: false, reminderPending: false, existingChoreIds: existing });
    assert.equal(next.action === 'write' && next.push && next.fresh, true);
  });

  test('told-about history is bounded: gone chores forgotten, oldest history evicted, listed chores never', () => {
    const gone = decide({ stored: stored({ notifiedChoreIds: ['a', 'deleted'] }), overdueIds: ['a', 'b'] });
    assert.deepEqual(gone.action === 'write' && gone.notifiedChoreIds, ['a', 'b']);
    const history = Array.from({ length: NOTIFIED_HISTORY_CAP + 5 }, (_, i) => `old-${String(i).padStart(3, '0')}`);
    const existing = new Set([...history, 'cur-1', 'cur-2', 'new-1']);
    const d = decideOverdue({
      stored: stored({ overdueChoreIds: ['cur-1', 'cur-2'], notifiedChoreIds: [...history, 'cur-1', 'cur-2'] }),
      overdueIds: ['new-1', 'cur-1', 'cur-2'], today: TODAY, alertsAllowed: true, reminderSentNow: false, reminderPending: false,
      existingChoreIds: existing,
    });
    assert.equal(d.action, 'write');
    if (d.action !== 'write') return;
    assert.equal(d.push, true);
    assert.equal(d.notifiedChoreIds.length, NOTIFIED_HISTORY_CAP + 3);
    assert.equal(d.notifiedChoreIds.includes('old-000'), false, 'oldest history dropped first');
    assert.equal(d.notifiedChoreIds.includes('old-005'), true);
    for (const id of ['cur-1', 'cur-2', 'new-1']) assert.ok(d.notifiedChoreIds.includes(id), id);
  });

  for (const size of [201, 1000]) {
    test(`${size} unchanged overdue chores stay quiet across days`, () => {
      const ids = Array.from({ length: size }, (_, i) => `c-${String(i).padStart(4, '0')}`);
      const existing = new Set(ids);
      let state: StoredOverdue | null = null;
      let pushes = 0;
      let writes = 0;
      for (let day = 11; day <= 16; day++) {
        for (let run = 0; run < 3; run++) {
          const d = decideOverdue({ stored: state, overdueIds: ids, today: `2026-11-${day}`, alertsAllowed: true, reminderSentNow: false, reminderPending: false, existingChoreIds: existing });
          if (d.action !== 'write') continue;
          writes++;
          if (d.push) pushes++;
          assert.equal(d.total, size);
          assert.ok(d.choreIds.length <= OVERDUE_LIST_CAP);
          state = { resolved: false, overdueChoreIds: d.choreIds, notifiedChoreIds: d.notifiedChoreIds, lastPushDay: d.lastPushDay, nearExpiry: false, seenByRun: true };
        }
      }
      assert.equal(pushes, 1);
      assert.equal(writes, 1, 'written once, then unchanged');
    });
  }

  test('past the list cap the newest overdue chores are listed, and a newly overdue one is still news', () => {
    // Caller order: newest due day first.
    const old = Array.from({ length: OVERDUE_LIST_CAP }, (_, i) => `old-${String(i).padStart(4, '0')}`);
    const existing = new Set([...old, 'newest']);
    const first = decideOverdue({ stored: null, overdueIds: old, today: TODAY, alertsAllowed: true, reminderSentNow: false, reminderPending: false, existingChoreIds: existing });
    const next = decideOverdue({ stored: after(first, null), overdueIds: ['newest', ...old], today: '2026-11-12', alertsAllowed: true, reminderSentNow: false, reminderPending: false, existingChoreIds: existing });
    assert.equal(next.action, 'write');
    if (next.action !== 'write') return;
    assert.equal(next.push, true);
    assert.ok(next.choreIds.includes('newest'));
    assert.equal(next.total, OVERDUE_LIST_CAP + 1);
  });

  describe('daily reminder coverage', () => {
    const base = { today: TODAY, existingChoreIds: EXISTING, reminderPending: false };
    test('reminder at 06:00, then the 07:00 run: no second push', () => {
      // 06:00 run: before the threshold, but the reminder created now announced the overdue count.
      const six = decideOverdue({ ...base, stored: null, overdueIds: ['a'], alertsAllowed: false, reminderSentNow: true });
      assert.equal(six.action, 'write');
      if (six.action !== 'write') return;
      assert.equal(six.create, true);
      assert.equal(six.push, false, 'silent');
      assert.equal(six.lastPushDay, TODAY);
      const seven = decideOverdue({ ...base, stored: after(six, null), overdueIds: ['a'], alertsAllowed: true, reminderSentNow: false });
      assert.deepEqual(seven, { action: 'none' });
    });
    test('reminder at 06:00, then a chore newly overdue at 15:00: shown as new, no second push that day, normal rule the next day', () => {
      const six = after(decideOverdue({ ...base, stored: null, overdueIds: ['a'], alertsAllowed: false, reminderSentNow: true }), null);
      const three = decideOverdue({ ...base, stored: six, overdueIds: ['a', 'b'], alertsAllowed: true, reminderSentNow: false });
      assert.equal(three.action === 'write' && three.fresh && !three.push, true);
      const tomorrow = decideOverdue({ ...base, today: '2026-11-12', stored: after(three, six), overdueIds: ['a', 'b', 'c'], alertsAllowed: true, reminderSentNow: false });
      assert.equal(tomorrow.action === 'write' && tomorrow.push, true);
    });
    test('reminder disabled: the 07:00 run pushes', () => {
      const d = decideOverdue({ ...base, stored: null, overdueIds: ['a'], alertsAllowed: true, reminderSentNow: false });
      assert.equal(d.action === 'write' && d.push, true);
    });
    test('reminder exactly at 07:00: the same run creates both, the overdue one silently', () => {
      const d = decideOverdue({ ...base, stored: null, overdueIds: ['a'], alertsAllowed: true, reminderSentNow: true });
      assert.equal(d.action === 'write' && !d.push && d.lastPushDay === TODAY, true);
    });
    test('a reminder sent over an unchanged list records today as pushed', () => {
      const d = decideOverdue({ ...base, stored: stored(), overdueIds: ['a'], alertsAllowed: true, reminderSentNow: true });
      assert.equal(d.action === 'write' && !d.push && !d.fresh && d.lastPushDay === TODAY, true);
    });
  });

  describe('dated documents from earlier versions', () => {
    const view = [{ id: 'a', day: '2026-11-09' }, { id: 'b', day: '2026-11-10' }];
    test('a dated alert from today covers the chores overdue today: silent create', () => {
      const legacy = legacyOverdueState(TODAY, view);
      assert.deepEqual(legacy.notifiedChoreIds, ['a', 'b']);
      const d = decide({ legacy, overdueIds: ['b', 'a'] });
      assert.equal(d.action, 'write');
      if (d.action !== 'write') return;
      assert.equal(d.create && d.fromLegacy, true);
      assert.equal(d.push, false);
      assert.equal(d.fresh, false, 'read and dismissed state carried over');
      assert.equal(d.lastPushDay, TODAY);
    });
    test('a dated alert from today plus one more overdue chore: once a day, so no push today', () => {
      const d = decide({ legacy: legacyOverdueState(TODAY, view), overdueIds: ['c', 'b', 'a'] });
      assert.equal(d.action === 'write' && d.fresh && !d.push, true);
    });
    test('a dated alert from an earlier day: its chores are not news, later ones are', () => {
      const legacy = legacyOverdueState('2026-11-10', view);
      assert.deepEqual(legacy.notifiedChoreIds, ['a'], 'b was not overdue on Nov 10');
      const d = decide({ legacy, overdueIds: ['b', 'a'] });
      assert.equal(d.action === 'write' && d.fresh && d.push, true);
      const quiet = decide({ legacy: legacyOverdueState('2026-11-10', [{ id: 'a', day: '2026-11-09' }]), overdueIds: ['a'] });
      assert.equal(quiet.action === 'write' && !quiet.push && !quiet.fresh, true);
    });
    test('no dated documents: unchanged behaviour', () => {
      const d = decide({ legacy: null, overdueIds: ['a'] });
      assert.equal(d.action === 'write' && d.push && !d.fromLegacy, true);
    });
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
    assert.deepEqual(view.chores, [{ id: 'a', task: 'Trash', day: '2026-11-04' }]);
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
