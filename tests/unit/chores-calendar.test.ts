import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { dayKey, type ChoreRecord } from '../../src/lib/chores/dates';
import { occurrenceChoreId, recurringChoreId } from '../../functions/src/shared/ids';
import { stableSlugify } from '../../src/lib/utils';
import {
  choreEvents, groupByDay, maintenanceCalendarItems, occurrenceIds, plannedRecurringEvents, isSameMonth, maintenanceEvents, medicationDueEvents, medicationEvents, monthGrid, overdueRail, rescheduleFields, shiftMonth, sortEvents, weekDays,
} from '../../src/lib/chores/calendar';
import { currentMedicationsOn } from '../../src/lib/pets/care';

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

  it('places medication doses on the household day they were logged (PE-7b)', () => {
    const logged = new Date(2026, 6, 31, 20, 0);
    const [event] = medicationEvents([{ id: 'm', petId: 'maple', petName: 'Maple', medication: 'Heartworm', dosage: '1 tab', date: logged.toISOString() }], 'UTC');
    assert.equal(event.day, logged.toISOString().slice(0, 10));
    // 03:00 UTC on Aug 1 is still Jul 31 in Chicago: the household's day, whatever the device zone.
    const lateDose = [{ id: 'n', petId: 'maple', petName: 'Maple', medication: 'Heartworm', date: '2026-08-01T03:00:00.000Z' }];
    assert.equal(medicationEvents(lateDose, 'America/Chicago')[0].day, '2026-07-31');
    assert.equal(medicationEvents(lateDose, 'Europe/London')[0].day, '2026-08-01');
    assert.equal(event.title, 'Heartworm (1 tab)');
    assert.equal(event.href, '/pets/maple');
    assert.equal(medicationEvents([{ id: 'x', petId: 'p', petName: 'P', medication: 'M', date: 'nope' }]).length, 0);
  });

  it('shows upcoming medication doses from the Pets countdown rule', () => {
    const entries = [
      { id: 'a', petId: 'maple', petName: 'Maple', medication: 'Heartworm', dosage: '1 tab', date: '2026-07-03T10:00:00.000Z', nextDueDate: '2026-08-03' },
      { id: 'b', petId: 'maple', petName: 'Maple', medication: 'Ear drops', dosage: '2 drops', date: '2026-07-20T10:00:00.000Z', nextDueDate: '2026-07-30' },
      // A newer dose without a next date: no countdown for Joint support.
      { id: 'c', petId: 'maple', petName: 'Maple', medication: 'Joint support', dosage: '1', date: '2026-07-01T10:00:00.000Z', nextDueDate: '2026-08-05' },
      { id: 'd', petId: 'maple', petName: 'Maple', medication: 'joint support', dosage: '1', date: '2026-07-31T10:00:00.000Z' },
      { id: 'e', petId: 'pixel', petName: 'Pixel', medication: 'Flea prevention', date: '2026-07-01T10:00:00.000Z', nextDueDate: '2026-08-01' },
    ];
    const events = medicationDueEvents(entries, '2026-08-01');
    assert.deepEqual(events.map(e => [e.subtitle, e.title, e.day, e.overdue, e.completed, e.medicationDue?.label]), [
      ['Maple', 'Ear drops (2 drops)', '2026-07-30', true, false, 'Overdue by 2 days'],
      ['Maple', 'Heartworm (1 tab)', '2026-08-03', false, false, 'Due in 2 days'],
      ['Pixel', 'Flea prevention', '2026-08-01', false, false, 'Due today'],
    ]);
    assert.equal(events[0].href, '/pets/maple?tab=medication');
    // Not a fork: the same doses, labels and order as the pet card chips.
    const maple = currentMedicationsOn(entries.filter(e => e.petId === 'maple').map(e => ({ ...e, dosage: e.dosage ?? '' })), '2026-08-01');
    assert.deepEqual(events.filter(e => e.subtitle === 'Maple').map(e => e.medicationDue?.label), maple.map(due => due.label));
    // Overdue doses join the red rail; logged doses stay separate events.
    assert.deepEqual(overdueRail(events).map(e => e.title), ['Ear drops (2 drops)']);
    assert.equal(medicationEvents(entries).every(e => e.completed && !e.medicationDue), true);
  });

  it('the calendar has a phone day agenda that swipes and answers the arrow keys', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/components/chores/calendar/household-calendar.tsx'), 'utf8');
    assert.match(source, /type View = 'day' \| 'week' \| 'month'/);
    assert.match(source, /matches \? 'day' : 'week'/);
    assert.match(source, /<ToggleGroupItem value="day"/);
    assert.match(source, /e\.key === 'ArrowLeft' \|\| e\.key === 'ArrowRight'/);
    assert.match(source, /addDaysToKey\(selectedDay, direction\)/);
    // Medication days are the household's (PE-7b), not the device's.
    assert.match(source, /medicationEvents\(medication, timeZone\)/);
    assert.match(source, /medicationDueEvents\(medication, householdToday\)/);
    assert.match(source, /<Stagger as="ol"/);
    assert.match(source, /<PeekCard/);
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
    const existing = [chore({ id: occurrenceChoreId('trash', 'general', '2027-02-01'), templateId: 'trash', originalDueDate: '2027-02-01' })];
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
    assert.deepEqual(occurrenceIds(trash, '2026-09-01'), [
      occurrenceChoreId('trash', 'kitchen', '2026-09-01'),
      occurrenceChoreId('trash', 'garage', '2026-09-01'),
    ]);
    assert.deepEqual(occurrenceIds({ id: 'trash' }, '2026-09-01'), [occurrenceChoreId('trash', 'general', '2026-09-01')]);
    // The web slug (used for older browser-generated IDs) matches the server's.
    for (const text of ['daily-kitchen-reset-kitchen-2026-08-01-alex.e2e@example.test', 'Ça va & Co / x_y']) {
      assert.equal(recurringChoreId(text, 'r', '2026-08-01', 'a@b.c'), stableSlugify(`${text}-r-2026-08-01-a@b.c`));
      assert.equal(occurrenceChoreId(text, 'r', '2026-08-01'), stableSlugify(`${text}-r-2026-08-01`));
    }
  });

  it('matches the generator in functions/src/reminders.ts', () => {
    const source = readFileSync(resolve(process.cwd(), 'functions/src/reminders.ts'), 'utf8');
    assert.match(source, /occurrenceChoreId\(templateDoc\.id, roomId, day\)/, 'generator ID changed: update occurrenceIds');
    assert.match(source, /template\.roomIds\.length > 0 \? template\.roomIds : \["general"\]/, 'generator room fallback changed: update occurrenceIds');
  });

  it('does not plan a copy of an occurrence that was moved or completed', () => {
    const id = occurrenceChoreId('trash', 'kitchen', '2026-09-01');
    // Generated for Sep 1, then moved to Sep 3 and completed.
    const moved = chore({ id, templateId: 'trash', roomIds: ['kitchen'], originalDueDate: '2026-09-03', isCompleted: true });
    const events = plannedRecurringEvents([trash], [moved], members, '2026-08-01', '2026-09-01', '2026-09-01');
    // Only the garage room instance is still missing on Sep 1.
    assert.deepEqual(events.map(e => e.id), [`planned:${occurrenceChoreId('trash', 'garage', '2026-09-01')}`]);
  });

  it('does not plan a day whose chore was generated under an id with the assignee (before release E)', () => {
    // Generated before release E under the email-keyed id, then the template was reassigned.
    const legacy = chore({ id: recurringChoreId('trash', 'kitchen', '2026-09-01', 'ana@example.test'), templateId: 'trash', roomIds: ['kitchen'], originalDueDate: '2026-09-01' });
    const keyed = chore({ id: recurringChoreId('trash', 'garage', '2026-09-01', 'uid-ana'), templateId: 'trash', roomIds: ['kitchen'], originalDueDate: '2026-09-04', occurrenceKey: 'trash|garage|2026-09-01', isCompleted: true });
    assert.deepEqual(plannedRecurringEvents([trash], [legacy, keyed], members, '2026-08-01', '2026-09-01', '2026-09-01'), []);
  });
});
