import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { addDays, localDay, localMinutes, safeTimeZone, toDay, zonedMidnightIso } from '../../functions/src/shared/calendar';
import { deterministicNotificationId, recurringChoreId, stableSlugify } from '../../functions/src/shared/ids';
import { normalizeRecurrence, occursOn, upcomingOccurrences } from '../../functions/src/shared/recurrence';
import { actionableReminders, buildMaintenanceReminders } from '../../functions/src/shared/maintenance-reminders';
import { choreNotificationsFor } from '../../functions/src/shared/chore-reminders';
import { getDeterministicNotificationId } from '../../src/lib/notifications';
import { stableSlugify as clientSlugify } from '../../src/lib/utils';

const CHI = 'America/Chicago';

describe('calendar', () => {
  test('local day respects the household timezone, not the server clock', () => {
    // 03:30 UTC on Nov 6 is still Nov 5 in Chicago.
    assert.equal(localDay(new Date('2026-11-06T03:30:00Z'), CHI), '2026-11-05');
    assert.equal(localMinutes(new Date('2026-11-06T03:30:00Z'), CHI), 21 * 60 + 30);
  });

  test('local midnight is correct on both sides of a DST change', () => {
    assert.equal(zonedMidnightIso('2026-11-01', CHI), '2026-11-01T05:00:00.000Z'); // CDT
    assert.equal(zonedMidnightIso('2026-11-02', CHI), '2026-11-02T06:00:00.000Z'); // CST
    assert.equal(addDays('2026-02-28', 1), '2026-03-01');
  });

  test('stored ISO due dates map to the household day; bad zones fall back', () => {
    assert.equal(toDay('2026-11-05T06:00:00.000Z', CHI), '2026-11-05');
    assert.equal(toDay('2026-11-05', CHI), '2026-11-05');
    assert.equal(toDay('nonsense', CHI), null);
    assert.equal(safeTimeZone('Mars/Base'), CHI);
  });
});

describe('ids stay compatible with existing documents', () => {
  test('notification and slug identities match the web app', () => {
    const args = { sourceType: 'maintenance_asset_schedule', sourceId: 'hvac:filter', stateKey: 'overdue|2026-08-01' };
    assert.equal(deterministicNotificationId(args.sourceType, args.sourceId, args.stateKey), getDeterministicNotificationId(args));
    assert.equal(stableSlugify('Kitchen & Bath / Ünit 2'), clientSlugify('Kitchen & Bath / Ünit 2'));
    assert.equal(recurringChoreId('tpl', 'general', '2026-11-05', 'sam@example.test'), clientSlugify('tpl-general-2026-11-05-sam@example.test'));
  });
});

describe('recurrence', () => {
  const today = '2026-11-05'; // Thursday

  test('weekly picks the chosen weekdays starting today', () => {
    const r = normalizeRecurrence({ frequency: 'weekly', weeklyOptions: { daysOfWeek: [1, 4] } }, today)!;
    assert.deepEqual(upcomingOccurrences(r, today, 4), ['2026-11-05', '2026-11-09', '2026-11-12', '2026-11-16']);
  });

  test('biweekly alternates weeks from its anchor', () => {
    const r = normalizeRecurrence({ frequency: 'biweekly', startDate: '2026-11-02', weeklyOptions: { daysOfWeek: [1] } }, today)!;
    assert.deepEqual(upcomingOccurrences(r, today, 3), ['2026-11-16', '2026-11-30', '2026-12-14']);
  });

  test('daily can skip weekends; monthly supports day and nth weekday', () => {
    const weekdays = normalizeRecurrence({ frequency: 'daily', dailyOptions: { excludeWeekends: true } }, today)!;
    assert.deepEqual(upcomingOccurrences(weekdays, today, 3), ['2026-11-05', '2026-11-06', '2026-11-09']);
    const firstOfMonth = normalizeRecurrence({ frequency: 'monthly', monthlyOptions: { dayOfMonth: 1 } }, today)!;
    assert.deepEqual(upcomingOccurrences(firstOfMonth, today, 2), ['2026-12-01', '2027-01-01']);
    const secondTuesday = normalizeRecurrence({ frequency: 'monthly', monthlyOptions: { mode: 'nthWeekday', nthWeekday: { week: 2, dayOfWeek: 2 } } }, today)!;
    assert.equal(occursOn('2026-11-10', secondTuesday), true);
    assert.equal(occursOn('2026-11-03', secondTuesday), false);
  });

  test('unknown frequencies are not recurring', () => {
    assert.equal(normalizeRecurrence({ frequency: 'hourly' }, today), null);
    assert.equal(normalizeRecurrence(null, today), null);
  });
});

describe('maintenance reminders', () => {
  const today = '2026-11-05';
  const assets = [
    { id: 'hvac', name: 'Main HVAC', schedules: [{ id: 's1', scheduleName: 'Replace filter', nextDueDate: '2026-10-01' }], warrantyExpiration: '2026-11-05' },
    { id: 'old', name: 'Old fridge', status: 'retired', schedules: [{ id: 's2', scheduleName: 'Clean coils', nextDueDate: '2026-01-01' }] },
    { id: 'list', name: 'Checklist only', schedules: [{ id: 's3', mode: 'checklist' as const, scheduleName: 'Look at it' }] },
  ];
  const vehicles = [
    { id: 'suv', nickname: 'Family SUV', currentMileage: 48100, serviceSchedules: [{ id: 'oil', serviceName: 'Oil change', nextDueMileage: 48500 }], registrationExpiration: '2026-12-31' },
    { id: 'sold', nickname: 'Old car', status: 'sold', registrationExpiration: '2020-01-01' },
  ];

  test('overdue, due today and due soon are actionable; retired, sold and checklists are not', () => {
    const reminders = actionableReminders(buildMaintenanceReminders(assets, vehicles, today, CHI));
    assert.deepEqual(reminders.map(r => `${r.sourceType}:${r.status}`), [
      'maintenance_asset_schedule:overdue',
      'maintenance_asset_warranty:due_today',
      'maintenance_vehicle_service:due_soon',
    ]);
  });

  test('warranties expire rather than become overdue', () => {
    const [, warranty] = buildMaintenanceReminders(assets, [], today, CHI);
    assert.equal(warranty.message, 'The Main HVAC warranty expires today.');
  });
});

describe('chore reminders', () => {
  const person = { uid: 'u1', email: 'sam@example.test', timeZone: CHI, reminderEnabled: true, reminderTime: '17:00' };
  const chores = [
    { id: 'a', task: 'Trash', assignedToEmail: 'sam@example.test', dueDate: '2026-11-04T06:00:00.000Z' },
    { id: 'b', task: 'Dishes', assignedToEmail: 'sam@example.test', dueDate: '2026-11-05T06:00:00.000Z' },
    { id: 'c', task: 'Done', assignedToEmail: 'sam@example.test', dueDate: '2026-11-01T05:00:00.000Z', isCompleted: true },
    { id: 'd', task: 'Someone else', assignedToEmail: 'alex@example.test', dueDate: '2026-11-01T05:00:00.000Z' },
  ];

  test('nothing at night; no dated overdue alert; daily reminder after the chosen time counts overdue', () => {
    assert.deepEqual(choreNotificationsFor(person, chores, new Date('2026-11-05T08:00:00Z')), []); // 2am CST
    // Overdue chores have one stable notification per person (overdueChoresFor), not one per day.
    assert.deepEqual(choreNotificationsFor(person, chores, new Date('2026-11-05T14:00:00Z')), []); // 8am
    const evening = choreNotificationsFor(person, chores, new Date('2026-11-05T23:30:00Z')); // 5:30pm
    assert.deepEqual(evening.map(n => n.id), ['u1-reminder-2026-11-05']);
    assert.equal(evening[0].message, '1 chore due today and 1 overdue.');
  });

  test('a reminder time after the last hourly run still fires exactly once', () => {
    const late = { ...person, reminderTime: '23:30' };
    const sent = new Map<string, string>();
    // Every hourly run from local midnight Nov 5 through local midnight Nov 6 (CST = UTC-6).
    for (let hour = 0; hour <= 24; hour++) {
      const now = new Date(Date.UTC(2026, 10, 5, 6 + hour));
      for (const note of choreNotificationsFor(late, chores, now)) {
        if (note.id.includes('reminder-2026-11-05') && !sent.has(note.id)) sent.set(note.id, now.toISOString());
      }
    }
    assert.deepEqual([...sent.keys()], ['u1-reminder-2026-11-05']);
    assert.equal(sent.get('u1-reminder-2026-11-05'), '2026-11-06T06:00:00.000Z', 'sent by the first run of the next day');
    const midnight = choreNotificationsFor(late, chores, new Date('2026-11-06T06:00:00Z'));
    assert.equal(midnight.find(n => n.id === 'u1-reminder-2026-11-05')?.message, '1 chore due yesterday and 1 overdue.');
  });

  test('a member west of the household keeps the occurrence day', () => {
    const la = { ...person, timeZone: 'America/Los_Angeles', householdTimeZone: CHI };
    // A Thursday Chicago occurrence, stored as Chicago midnight (Wednesday 22:00 in LA).
    const thursday = [{ id: 't', task: 'Trash', assignedToEmail: 'sam@example.test', dueDate: '2026-11-05T06:00:00.000Z', originalDueDate: '2026-11-05' }];
    assert.deepEqual(choreNotificationsFor(la, thursday, new Date('2026-11-05T01:30:00Z')), [], 'not reminded a day early (Wed 17:30 LA)');
    assert.deepEqual(choreNotificationsFor(la, thursday, new Date('2026-11-05T16:00:00Z')), [], 'not overdue on its own day (Thu 08:00 LA)');
    const thursdayEvening = choreNotificationsFor(la, thursday, new Date('2026-11-06T01:30:00Z')); // Thu 17:30 LA
    assert.equal(thursdayEvening.find(n => n.id === 'u1-reminder-2026-11-05')?.message, '1 chore due today.');
    // Older records without originalDueDate fall back to the household zone, not the member's.
    const legacy = [{ ...thursday[0], originalDueDate: undefined }];
    assert.deepEqual(choreNotificationsFor(la, legacy, new Date('2026-11-05T01:30:00Z')), []);
  });

  test('disabled reminders and no pending chores stay quiet', () => {
    const quiet = choreNotificationsFor({ ...person, reminderEnabled: false }, chores.slice(1, 2), new Date('2026-11-05T23:30:00Z'));
    assert.deepEqual(quiet, []);
  });
});

describe('snoozed maintenance reminders (D16)', () => {
  const today = '2026-11-05';
  const asset = (schedule: Record<string, unknown>) => [{ id: 'hvac', name: 'Main HVAC', schedules: [{ id: 's1', scheduleName: 'Replace filter', ...schedule }] }];

  test('a snoozed due-soon reminder is still built but not notified until its due day', () => {
    const snoozed = buildMaintenanceReminders(asset({ nextDueDate: '2026-11-12', snoozedUntil: '2026-11-12' }), [], today, CHI);
    assert.equal(snoozed.length, 1);
    assert.equal(snoozed[0].status, 'due_soon');
    assert.equal(snoozed[0].snoozed, true);
    assert.deepEqual(actionableReminders(snoozed), []);

    const dueDay = buildMaintenanceReminders(asset({ nextDueDate: '2026-11-12', snoozedUntil: '2026-11-12' }), [], '2026-11-12', CHI);
    assert.equal(dueDay[0].status, 'due_today');
    assert.equal(actionableReminders(dueDay).length, 1);
  });

  test('a stale snooze (due date changed by completion or edit) no longer applies', () => {
    const stale = buildMaintenanceReminders(asset({ nextDueDate: '2026-11-10', snoozedUntil: '2026-11-12' }), [], today, CHI);
    assert.equal(stale[0].snoozed, false);
    assert.equal(actionableReminders(stale).length, 1);
  });

  test('a vehicle service due by mileage still notifies even if its date was snoozed', () => {
    const vehicles = [{ id: 'car', nickname: 'Family car', currentMileage: 49_800, serviceSchedules: [{ id: 'oil', serviceName: 'Oil change', nextDueDate: '2026-11-12', snoozedUntil: '2026-11-12', nextDueMileage: 50_000 }] }];
    const reminders = buildMaintenanceReminders([], vehicles, today, CHI);
    assert.equal(reminders[0].status, 'due_soon');
    assert.equal(reminders[0].snoozed, false);
    assert.equal(actionableReminders(reminders).length, 1);
  });
});
