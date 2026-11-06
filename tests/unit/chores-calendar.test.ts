import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { dayKey, type ChoreRecord } from '../../src/lib/chores/dates';
import { recurringChoreId } from '../../functions/src/shared/ids';
import { stableSlugify } from '../../src/lib/utils';
import {
  choreEvents, groupByDay, maintenanceCalendarItems, occurrenceIds, plannedRecurringEvents, isSameMonth, maintenanceEvents, medicationEvents, monthGrid, overdueRail, rescheduleFields, shiftMonth, sortEvents, weekDays,
} from '../../src/lib/chores/calendar';

const chore = (overrides: Partial<ChoreRecord>): ChoreRecord => ({
  id: 'c1',
  task: 'Reset the kitchen',
  assignedToEmail: 'sam@example.test',
  dueDate: '2026-08-01',
  originalDueDate: '2026-08-01',
  isCompleted: false,
  ...overrides,
});
const members = [{ uid: 'sam-uid', email: 'sam@example.test', name: 'Sam' }];

describe('calendar events', () => {
  it('turns chores into member-colored events and flags overdue ones', () => {
    const events = choreEvents([
      chore({ id: 'late', originalDueDate: '2026-07-30' }),
      chore({ id: 'today', originalDueDate: '2026-08-01' }),
      chore({ id: 'done-late', originalDueDate: '2026-07-29', isCompleted: true }),
      chore({ id: 'stranger', assignedToEmail: 'gone@example.test', assignedToDisplayName: 'Gone' }),
    ], members, '2026-08-01');
    const byId = new Map(events.map(e => [e.choreId, e]));
    assert.equal(byId.get('late')!.overdue, true);
    assert.equal(byId.get('late')!.memberUid, 'sam-uid');
    assert.equal(byId.get('late')!.subtitle, 'Sam');
    assert.equal(byId.get('today')!.overdue, false);
    assert.equal(byId.get('done-late')!.overdue, false);
    assert.equal(byId.get('done-late')!.completed, true);
    assert.equal(byId.get('stranger')!.memberUid, undefined);
    assert.equal(byId.get('stranger')!.subtitle, 'Gone');
  });

  it('keeps maintenance links internal and drops undated items', () => {
    const events = maintenanceEvents([
      { id: 'a', title: 'Filter', relatedName: 'HVAC', day: '2026-07-20', status: 'overdue', deepLink: '/maintenance?asset=a' },
      { id: 'b', title: 'Oil', relatedName: 'Car', day: null, status: 'due_soon', deepLink: '/maintenance' },
      { id: 'c', title: 'Odd', relatedName: 'X', day: '2026-08-09', status: 'upcoming', deepLink: 'https://evil.example' },
    ]);
    assert.equal(events.length, 2);
    assert.equal(events[0].overdue, true);
    assert.equal(events[1].href, '/maintenance');
  });

  it('places medication doses on the local day they were logged', () => {
    const logged = new Date(2026, 6, 31, 20, 0);
    const [event] = medicationEvents([{ id: 'm', petId: 'maple', petName: 'Maple', medication: 'Heartworm', dosage: '1 tab', date: logged.toISOString() }]);
    assert.equal(event.day, dayKey(logged));
    assert.equal(event.title, 'Heartworm (1 tab)');
    assert.equal(event.href, '/pets/maple');
    assert.equal(medicationEvents([{ id: 'x', petId: 'p', petName: 'P', medication: 'M', date: 'nope' }]).length, 0);
  });

  it('groups, sorts and builds the overdue rail', () => {
    const events = [
      ...choreEvents([chore({ id: 'b', task: 'B', originalDueDate: '2026-07-31' }), chore({ id: 'a', task: 'A', originalDueDate: '2026-07-30' })], members, '2026-08-01'),
      ...maintenanceEvents([{ id: 'm', title: 'Gutter', relatedName: 'House', day: '2026-07-31', status: 'overdue', deepLink: '/maintenance' }]),
    ];
    assert.deepEqual(overdueRail(events).map(e => e.title), ['A', 'B', 'Gutter']);
    assert.deepEqual([...groupByDay(events).keys()], ['2026-07-30', '2026-07-31']);
    assert.equal(sortEvents(events)[0].title, 'A');
  });
});

describe('calendar grids', () => {
  it('builds a Monday-first week', () => {
    assert.deepEqual(weekDays('2026-08-01'), ['2026-07-27', '2026-07-28', '2026-07-29', '2026-07-30', '2026-07-31', '2026-08-01', '2026-08-02']);
  });

  it('builds whole weeks covering the month', () => {
    const grid = monthGrid('2026-08-15');
    assert.equal(grid[0][0], '2026-07-27');
    assert.ok(grid.every(week => week.length === 7));
    assert.ok(grid.flat().includes('2026-08-31'));
    assert.equal(grid.length, 6);
    assert.equal(isSameMonth('2026-08-31', '2026-08-01'), true);
    assert.equal(isSameMonth('2026-07-31', '2026-08-01'), false);
  });

  it('shifts months from any day', () => {
    assert.equal(shiftMonth('2026-01-31', 1), '2026-02-01');
    assert.equal(shiftMonth('2026-01-15', -1), '2025-12-01');
  });

  it('reschedules to the chosen day for every reader', () => {
    const fields = rescheduleFields('2026-08-07');
    assert.equal(fields.originalDueDate, '2026-08-07');
    assert.equal(dayKey(new Date(fields.dueDate)), '2026-08-07');
  });
});

describe('calendar reads every date in the visible range', () => {
  const tz = 'America/Chicago';

  it('includes expirations beyond the 14-day reminder window', () => {
    const items = maintenanceCalendarItems(
      [{ id: 'hvac', name: 'HVAC', status: 'active', warrantyExpiration: '2027-03-01' }],
      [{ id: 'car', nickname: 'Car', status: 'active', registrationExpiration: '2026-12-15', inspectionExpiration: '2026-11-20' }],
      '2026-08-01',
      tz,
    );
    const days = new Map(items.map(i => [i.id, i]));
    assert.equal(days.get('asset-warranty-hvac')!.day, '2027-03-01');
    assert.equal(days.get('vehicle-registration-car')!.day, '2026-12-15');
    assert.equal(days.get('vehicle-inspection-car')!.day, '2026-11-20');
    assert.equal(days.get('vehicle-registration-car')!.title, 'Registration expires');
  });

  it('treats an expired warranty as information, an expired registration as overdue', () => {
    const items = maintenanceCalendarItems(
      [{ id: 'hvac', name: 'HVAC', status: 'active', warrantyExpiration: '2026-07-01' }],
      [{ id: 'car', nickname: 'Car', status: 'active', registrationExpiration: '2026-07-15' }],
      '2026-08-01',
      tz,
    );
    const events = new Map(maintenanceEvents(items).map(e => [e.id, e]));
    assert.equal(events.get('maintenance:asset-warranty-hvac')!.overdue, false);
    assert.equal(events.get('maintenance:asset-warranty-hvac')!.title, 'Warranty expired');
    assert.equal(events.get('maintenance:vehicle-registration-car')!.overdue, true);
  });

  it('includes far-off scheduled services and skips retired or sold items', () => {
    const items = maintenanceCalendarItems(
      [
        { id: 'filter', name: 'Furnace', status: 'active', schedules: [{ id: 's', mode: 'scheduled', scheduleName: 'Filter', nextDueDate: '2027-01-10' }] },
        { id: 'old', name: 'Old', status: 'retired', warrantyExpiration: '2027-01-01' },
      ],
      [{ id: 'sold', nickname: 'Sold', status: 'sold', registrationExpiration: '2027-01-01' }],
      '2026-08-01',
      tz,
    );
    assert.deepEqual(items.map(i => i.day), ['2027-01-10']);
  });

  it('plans repeating chores beyond the generated lookahead, from today on', () => {
    const templates = [{ id: 'trash', task: 'Trash', assignedToEmail: 'sam@example.test', recurrence: { frequency: 'weekly', interval: 1, weeklyOptions: { daysOfWeek: [1] } } }];
    const existing = [chore({ id: recurringChoreId('trash', 'general', '2027-02-01', 'sam@example.test'), templateId: 'trash', originalDueDate: '2027-02-01' })];
    const events = plannedRecurringEvents(templates, existing, members, '2026-08-01', '2027-01-25', '2027-02-14');
    // Mondays in range: Jan 25, Feb 1 (already generated), Feb 8.
    assert.deepEqual(events.map(e => e.day), ['2027-01-25', '2027-02-08']);
    assert.ok(events.every(e => e.planned && !e.choreId && e.memberUid === 'sam-uid'));
    // Never in the past, never for non-members.
    assert.equal(plannedRecurringEvents(templates, [], members, '2026-08-01', '2026-07-01', '2026-07-31').length, 0);
    assert.equal(plannedRecurringEvents([{ ...templates[0], assignedToEmail: 'gone@example.test' }], [], members, '2026-08-01', '2026-08-01', '2026-08-31').length, 0);
  });
});

describe('planned occurrences use the server occurrence identity', () => {
  const trash = { id: 'trash', task: 'Trash', roomIds: ['kitchen', 'garage'], assignedToEmail: 'sam@example.test', recurrence: { frequency: 'daily', interval: 1 } };

  it('builds exactly the IDs the server generator uses', () => {
    assert.deepEqual(occurrenceIds(trash, '2026-09-01', 'sam@example.test'), [
      recurringChoreId('trash', 'kitchen', '2026-09-01', 'sam@example.test'),
      recurringChoreId('trash', 'garage', '2026-09-01', 'sam@example.test'),
    ]);
    assert.deepEqual(occurrenceIds({ id: 'trash' }, '2026-09-01', 'sam@example.test'), [recurringChoreId('trash', 'general', '2026-09-01', 'sam@example.test')]);
    // The web slug (used for older browser-generated IDs) matches the server's.
    for (const text of ['daily-kitchen-reset-kitchen-2026-08-01-alex.e2e@example.test', 'Ça va & Co / x_y']) {
      assert.equal(recurringChoreId(text, 'r', '2026-08-01', 'a@b.c'), stableSlugify(`${text}-r-2026-08-01-a@b.c`));
    }
  });

  it('matches the generator in functions/src/reminders.ts', () => {
    const source = readFileSync(resolve(process.cwd(), 'functions/src/reminders.ts'), 'utf8');
    assert.match(source, /recurringChoreId\(templateDoc\.id, roomId, day, assignee\)/, 'generator ID changed: update occurrenceIds');
    assert.match(source, /template\.roomIds\.length > 0 \? template\.roomIds : \["general"\]/, 'generator room fallback changed: update occurrenceIds');
  });

  it('does not plan a copy of an occurrence that was moved or completed', () => {
    const id = recurringChoreId('trash', 'kitchen', '2026-09-01', 'sam@example.test');
    // Generated for Sep 1, then moved to Sep 3 and completed.
    const moved = chore({ id, templateId: 'trash', roomIds: ['kitchen'], originalDueDate: '2026-09-03', isCompleted: true });
    const events = plannedRecurringEvents([trash], [moved], members, '2026-08-01', '2026-09-01', '2026-09-01');
    // Only the garage room instance is still missing on Sep 1.
    assert.deepEqual(events.map(e => e.id), [`planned:${recurringChoreId('trash', 'garage', '2026-09-01', 'sam@example.test')}`]);
  });
});
