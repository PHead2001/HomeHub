import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { normalizeRecurrence, occursOn, upcomingOccurrences, weekStartOf } from '../../functions/src/shared/recurrence';
import { buildRecurrence, defaultRecurrenceState, scheduleText } from '../../src/components/chores/recurrence-fields';

const norm = (r: object, today = '2026-11-27') => normalizeRecurrence(r as never, today)!;

describe('repeat steps, starts and ends (CH-10, CH-25)', () => {
  test('every N days counts from the start day', () => {
    const r = norm({ frequency: 'daily', interval: 3, startDate: '2026-11-27' });
    assert.deepEqual(upcomingOccurrences(r, '2026-11-27', 4), ['2026-11-27', '2026-11-30', '2026-12-03', '2026-12-06']);
  });

  test('every N weeks counts calendar weeks from the start week', () => {
    const r = norm({ frequency: 'weekly', interval: 3, startDate: '2026-11-23', weeklyOptions: { daysOfWeek: [1, 5] } });
    assert.deepEqual(upcomingOccurrences(r, '2026-11-23', 4), ['2026-11-23', '2026-11-27', '2026-12-14', '2026-12-18']);
  });

  test('a start day and an end day bound every rule; no end repeats for good', () => {
    const r = norm({ frequency: 'weekly', weeklyOptions: { daysOfWeek: [4] }, startDate: '2026-12-01', endDate: '2026-12-17' });
    assert.deepEqual(upcomingOccurrences(r, '2026-11-27', 5), ['2026-12-03', '2026-12-10', '2026-12-17']);
    assert.equal(occursOn('2026-11-26', norm({ frequency: 'weekly', weeklyOptions: { daysOfWeek: [4] } })), true, 'older schedules without a start are unchanged');
  });

  test('a stepped weekly schedule is stored from the Monday of the picked week, so Mon and Fri share a week', () => {
    assert.equal(weekStartOf('2026-11-27'), '2026-11-23');
    assert.equal(weekStartOf('2026-11-23'), '2026-11-23');
    assert.equal(weekStartOf('2026-11-29'), '2026-11-23', 'Sunday ends the week');
    const built = buildRecurrence({ ...defaultRecurrenceState(), frequency: 'biweekly', daysOfWeek: ['1', '5'], biweeklyStartDate: new Date('2026-11-27T12:00:00') });
    assert.ok('recurrence' in built);
    assert.equal(built.recurrence.startDate, '2026-11-23');
    const r = norm(built.recurrence);
    assert.deepEqual(upcomingOccurrences(r, '2026-11-23', 4), ['2026-11-23', '2026-11-27', '2026-12-07', '2026-12-11']);
  });

  test('the builder writes the step and the end, and refuses an end before the start', () => {
    const daily = buildRecurrence({ ...defaultRecurrenceState(), frequency: 'daily', interval: 2, excludeWeekends: true, biweeklyStartDate: new Date('2026-11-27T12:00:00'), endDate: new Date('2027-01-31T12:00:00') });
    assert.ok('recurrence' in daily);
    assert.deepEqual({ i: daily.recurrence.interval, s: daily.recurrence.startDate, e: daily.recurrence.endDate, w: daily.recurrence.dailyOptions?.excludeWeekends }, { i: 2, s: '2026-11-27', e: '2027-01-31', w: false });
    const bad = buildRecurrence({ ...defaultRecurrenceState(), frequency: 'weekly', daysOfWeek: ['1'], biweeklyStartDate: new Date('2026-11-27T12:00:00'), endDate: new Date('2026-11-01T12:00:00') });
    assert.ok('errors' in bad && bad.errors.endDate);
    assert.equal(scheduleText({ frequency: 'daily', interval: 3, startDate: '2026-11-27', endDate: '2027-01-31' } as never), 'Every 3 days from Nov 27, 2026 until Jan 31, 2027');
  });
});
