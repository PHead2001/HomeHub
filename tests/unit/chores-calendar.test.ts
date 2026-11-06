import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { dayKey, type ChoreRecord } from '../../src/lib/chores/dates';
import {
  choreEvents, groupByDay, isSameMonth, maintenanceEvents, medicationEvents, monthGrid, overdueRail, rescheduleFields, shiftMonth, sortEvents, weekDays,
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
