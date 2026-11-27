import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { decideOverdue } from '../../functions/src/shared/overdue-notification';
import { runHouseholdReminders } from '../../functions/src/reminders';
import { choreNotificationsFor, dailyDigestFor, dailyReminderTitle, overdueChoresFor, overdueTitle } from '../../functions/src/shared/chore-reminders';

// Section 7 "stop the noise": NO-4 (overdue pushes respect a setting) and NO-19 (specific titles).
const TODAY = '2026-11-11';
const EXISTING = new Set(['a', 'b']);
const CHI = 'America/Chicago';
const person = { uid: 'u1', email: 'sam@example.test', timeZone: CHI };
const chore = (id: string, task: string, day: string) => ({ id, task, assignedToUid: 'u1', originalDueDate: day, isCompleted: false });
// 09:00 in Chicago on TODAY.
const NINE = new Date('2026-11-11T15:00:00Z');

describe('NO-4: overdue pushes respect the member setting', () => {
  test('the setting defaults to on', () => {
    assert.equal(overdueChoresFor(person, [], NINE).pushAllowed, true);
    assert.equal(overdueChoresFor({ ...person, overdueAlerts: true }, [], NINE).pushAllowed, true);
  });

  test('off: the chore is still listed and counted as told, but nothing is pushed', () => {
    const view = overdueChoresFor({ ...person, overdueAlerts: false }, [chore('a', 'Sweep', '2026-11-09')], NINE);
    assert.equal(view.pushAllowed, false);
    const d = decideOverdue({
      stored: null, overdueIds: view.chores.map((c) => c.id), today: TODAY, alertsAllowed: true,
      reminderSentNow: false, reminderPending: false, existingChoreIds: EXISTING, pushAllowed: view.pushAllowed,
    });
    assert.equal(d.action, 'write');
    if (d.action !== 'write') return;
    assert.equal(d.push, false);
    assert.equal(d.fresh, true, 'still new in the bell');
    assert.deepEqual(d.choreIds, ['a']);
    assert.equal(d.lastPushDay, TODAY, 'counted as told today, so turning alerts back on later does not replay it');
  });

  test('on: the same news pushes', () => {
    const d = decideOverdue({
      stored: null, overdueIds: ['a'], today: TODAY, alertsAllowed: true,
      reminderSentNow: false, reminderPending: false, existingChoreIds: EXISTING, pushAllowed: true,
    });
    assert.equal(d.action === 'write' && d.push, true);
  });
});

describe('NO-19: specific titles', () => {
  test('overdue: the chore by name, or how many', () => {
    assert.equal(overdueTitle(['Sweep floor']), 'Sweep floor is overdue');
    assert.equal(overdueTitle(['Sweep floor', 'Dishes']), '2 overdue chores');
    assert.equal(overdueTitle(['Sweep floor'], 501), '501 overdue chores');
    assert.equal(overdueTitle(['x'.repeat(300)]).length <= 120, true, 'fits the 120-character title bound');
  });

  test('daily reminder: what is due, else what is still overdue', () => {
    assert.equal(dailyReminderTitle(2, 1, 'today'), '2 chores due today');
    assert.equal(dailyReminderTitle(1, 0, 'yesterday'), '1 chore due yesterday');
    assert.equal(dailyReminderTitle(0, 3, 'today'), '3 chores still overdue');
  });

  test('the daily reminder carries the specific title', () => {
    const at17 = new Date('2026-11-11T23:00:00Z');
    const notes = choreNotificationsFor({ ...person, reminderEnabled: true, reminderTime: '17:00' },
      [chore('a', 'Sweep', TODAY), chore('b', 'Dishes', '2026-11-09')], at17);
    assert.equal(notes.length, 1);
    assert.equal(notes[0].title, '1 chore due today');
    assert.equal(notes[0].message, '1 chore due today and 1 overdue.');
  });
});

describe('upkeep refuses an invalid instant', () => {
  test('a bad Date is rejected before any read, never reaching localDay', async () => {
    await assert.rejects(runHouseholdReminders(null as never, 'h', new Date('2026-11-05T26:00:00Z'), (d) => d as never), RangeError);
  });
});

describe('NO-22: the daily reminder is a digest', () => {
  const at17 = new Date('2026-11-11T23:00:00Z');
  const withReminder = { ...person, reminderEnabled: true, reminderTime: '17:00' };

  test('pet doses join the chores', () => {
    const notes = choreNotificationsFor(withReminder, [chore('a', 'Sweep', TODAY)], at17, undefined, 2);
    assert.equal(notes[0].title, '1 chore due today');
    assert.equal(notes[0].message, '1 chore due today. 2 pet doses due today.');
  });

  test('doses alone still make a digest; nothing at all makes none', () => {
    const notes = choreNotificationsFor(withReminder, [], at17, undefined, 1);
    assert.equal(notes.length, 1);
    assert.equal(notes[0].title, '1 pet dose due today');
    assert.equal(notes[0].message, '1 pet dose due today.');
    assert.equal(choreNotificationsFor(withReminder, [], at17).length, 0);
  });

  test('the digest follows what is left, so upkeep can rewrite or resolve it in place', () => {
    const both = [chore('a', 'Sweep', TODAY), chore('b', 'Dishes', TODAY)];
    assert.equal(dailyDigestFor(person, both, TODAY, TODAY)?.title, '2 chores due today');
    const one = [{ ...both[0], isCompleted: true }, both[1]];
    const after = dailyDigestFor(person, one, TODAY, TODAY);
    assert.equal(after?.id, 'u1-reminder-2026-11-11', 'the same document');
    assert.equal(after?.title, '1 chore due today');
    assert.equal(dailyDigestFor(person, one.map((c) => ({ ...c, isCompleted: true })), TODAY, TODAY), null, 'all done: resolved');
  });

  test("yesterday's late reminder carries chores only", () => {
    // Reminder time 23:30 is after the day's last hourly run; the 00:00 run sends yesterday's.
    const midnight = new Date('2026-11-12T06:00:00Z');
    const notes = choreNotificationsFor({ ...person, reminderEnabled: true, reminderTime: '23:30' }, [chore('a', 'Sweep', TODAY)], midnight, undefined, 3);
    const late = notes.find((n) => n.sourceId === 'reminder-2026-11-11');
    assert.equal(late?.message, '1 chore due yesterday.');
  });
});
