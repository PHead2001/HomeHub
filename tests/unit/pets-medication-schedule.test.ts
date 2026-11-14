/**
 * The shared medication schedule model (functions/src/shared/medication-schedule.ts),
 * used by the Pets pages and the hourly reminders: occurrences of multi-daily,
 * every-N-days and every-N-hours courses in the household zone, midnight and
 * daylight-saving days, the next due occurrence after early, late and
 * backdated doses, and states and labels.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  courseDue,
  coverageAfterEdit,
  formatDoseTime,
  nextDueOccurrence,
  occurrenceAtOrBefore,
  occurrenceByKey,
  occurrencesAfter,
  occurrenceStatus,
  readCourse,
  readSchedule,
  scheduleSummary,
  zonedInstant,
  type CourseSchedule,
} from '../../functions/src/shared/medication-schedule';

const CHI = 'America/Chicago';
const iso = (ms: number) => new Date(ms).toISOString();
const twiceDaily: CourseSchedule = { kind: 'days', everyDays: 1, times: ['08:00', '20:00'] };

const course = (data: Record<string, unknown> = {}) => readCourse('c1', {
  name: 'Apoquel', dosage: '1 tablet', schedule: twiceDaily, startDay: '2026-11-13', status: 'active', ...data,
})!;
const dose = (occurrence: string, occurrenceAt: string) => ({ logId: `log-${occurrence}`, occurrence, occurrenceAt: new Date(occurrenceAt), givenAt: new Date(occurrenceAt), byUid: 'u', byName: 'Sam' });

describe('reading schedules', () => {
  test('valid kinds are normalized (times sorted, unique); anything else is refused', () => {
    assert.deepEqual(readSchedule({ kind: 'days', everyDays: 1, times: ['20:00', '08:00', '08:00'] }), { kind: 'days', everyDays: 1, times: ['08:00', '20:00'] });
    assert.deepEqual(readSchedule({ kind: 'hours', everyHours: 12, firstTime: '07:30' }), { kind: 'hours', everyHours: 12, firstTime: '07:30' });
    for (const bad of [
      null, 'daily', { kind: 'days', everyDays: 0, times: [] }, { kind: 'days', everyDays: 91, times: [] },
      { kind: 'days', everyDays: 1.5, times: [] }, { kind: 'days', everyDays: 1, times: ['8:00'] },
      { kind: 'days', everyDays: 1, times: ['24:00'] }, { kind: 'days', everyDays: 1, times: Array(7).fill('08:00') },
      { kind: 'hours', everyHours: 1, firstTime: '08:00' }, { kind: 'hours', everyHours: 73, firstTime: '08:00' },
      { kind: 'hours', everyHours: 12 }, { kind: 'weeks' },
    ]) assert.equal(readSchedule(bad), null, JSON.stringify(bad));
  });

  test('a course needs a name and a start day; an active one needs a schedule', () => {
    assert.ok(course());
    assert.equal(readCourse('c', { name: '', schedule: twiceDaily, startDay: '2026-11-13', status: 'active' }), null);
    assert.equal(readCourse('c', { name: 'A', schedule: null, startDay: '2026-11-13', status: 'active' }), null);
    assert.equal(readCourse('c', { name: 'A', schedule: twiceDaily, startDay: '2026-02-30', status: 'active' }), null);
    assert.equal(readCourse('c', { name: 'A', schedule: null, startDay: '2026-11-13', status: 'finished', legacyKeys: ['a'] })?.status, 'finished');
    assert.equal(course({ endDay: '2026-11-01' }).endDay, null, 'an end before the start is ignored');
  });
});

describe('household wall time', () => {
  test('a time is its instant in the household zone, whatever the device zone', () => {
    assert.equal(iso(zonedInstant('2026-11-14', 8 * 60, CHI)), '2026-11-14T14:00:00.000Z');
    assert.equal(iso(zonedInstant('2026-11-14', 8 * 60, 'Europe/London')), '2026-11-14T08:00:00.000Z');
  });

  test('daylight saving: a missing time moves forward by the gap, a repeated one is the first', () => {
    // Spring forward (Chicago, 2026-03-08): 2:30 AM does not exist; it becomes 3:30 AM CDT.
    assert.equal(iso(zonedInstant('2026-03-08', 150, CHI)), '2026-03-08T08:30:00.000Z');
    // Fall back (2026-11-01): 1:30 AM happens twice; the first (CDT) is used.
    assert.equal(iso(zonedInstant('2026-11-01', 90, CHI)), '2026-11-01T06:30:00.000Z');
  });
});

describe('occurrences', () => {
  const window = { schedule: twiceDaily, startDay: '2026-11-13', endDay: null };

  test('multi-daily: each set time each day, from the start day', () => {
    assert.deepEqual(occurrencesAfter(window, null, CHI, 4).map(o => o.key), ['2026-11-13T08:00', '2026-11-13T20:00', '2026-11-14T08:00', '2026-11-14T20:00']);
    // The evening dose is 02:00 UTC the next day: still the household's Nov 13.
    const evening = occurrencesAfter(window, null, CHI, 2)[1];
    assert.equal(evening.day, '2026-11-13');
    assert.equal(iso(evening.at), '2026-11-14T02:00:00.000Z');
  });

  test('every N days keeps the start day as its anchor; no set time = due all day from midnight', () => {
    const monthly = { schedule: { kind: 'days' as const, everyDays: 30, times: [] }, startDay: '2026-10-07', endDay: null };
    assert.deepEqual(occurrencesAfter(monthly, null, CHI, 3).map(o => o.key), ['2026-10-07', '2026-11-06', '2026-12-06']);
    const [first] = occurrencesAfter(monthly, null, CHI, 1);
    assert.equal(first.time, null);
    assert.equal(iso(first.at), '2026-10-07T05:00:00.000Z', 'household midnight');
    // After an instant late on Nov 20, the next is Dec 6 (the anchor holds).
    assert.equal(occurrencesAfter(monthly, Date.parse('2026-11-20T23:00:00Z'), CHI, 1)[0].key, '2026-12-06');
  });

  test('every N hours counts real hours, so the wall time moves across daylight saving', () => {
    const hourly = { schedule: { kind: 'hours' as const, everyHours: 12, firstTime: '08:00' }, startDay: '2026-10-31', endDay: null };
    const list = occurrencesAfter(hourly, null, CHI, 4);
    assert.deepEqual(list.map(o => o.key), ['2026-10-31T08:00', '2026-10-31T20:00', '2026-11-01T07:00', '2026-11-01T19:00']);
    assert.ok(list.every((o, i) => i === 0 || o.at - list[i - 1].at === 12 * 3_600_000));
  });

  test('a set time on the spring-forward day still happens once', () => {
    const nightly = { schedule: { kind: 'days' as const, everyDays: 1, times: ['02:30'] }, startDay: '2026-03-07', endDay: null };
    const list = occurrencesAfter(nightly, null, CHI, 3);
    assert.deepEqual(list.map(o => o.key), ['2026-03-07T02:30', '2026-03-08T02:30', '2026-03-09T02:30']);
    assert.ok(list[1].at > list[0].at && list[2].at > list[1].at);
  });

  test('the end day is the last day; nothing after it', () => {
    const short = { ...window, endDay: '2026-11-14' };
    assert.deepEqual(occurrencesAfter(short, null, CHI, 10).map(o => o.key), ['2026-11-13T08:00', '2026-11-13T20:00', '2026-11-14T08:00', '2026-11-14T20:00']);
  });

  test('lookups by key and by time', () => {
    assert.equal(occurrenceByKey(window, '2026-11-14T20:00', CHI)?.key, '2026-11-14T20:00');
    assert.equal(occurrenceByKey(window, '2026-11-14T09:00', CHI), null, 'not a scheduled time');
    assert.equal(occurrenceByKey(window, '2026-11-12T08:00', CHI), null, 'before the start');
    assert.equal(occurrenceAtOrBefore(window, Date.parse('2026-11-14T15:00:00Z'), CHI)?.key, '2026-11-14T08:00');
    assert.equal(occurrenceAtOrBefore(window, Date.parse('2026-11-13T13:00:00Z'), CHI), null);
  });
});

describe('next due', () => {
  test('from the start without a dose; after the covered occurrence with one', () => {
    assert.equal(nextDueOccurrence(course(), CHI)?.key, '2026-11-13T08:00');
    assert.equal(nextDueOccurrence(course({ lastDose: dose('2026-11-14T08:00', '2026-11-14T14:00:00Z') }), CHI)?.key, '2026-11-14T20:00');
  });

  test('early, late and backdated doses: the schedule never moves (PE-24c, PE-24p)', () => {
    // Late: the 8:00 AM dose given at 1 PM still covers 8:00 AM; next is 8:00 PM, not 1 AM.
    const late = course({ lastDose: { ...dose('2026-11-14T08:00', '2026-11-14T14:00:00Z'), givenAt: new Date('2026-11-14T19:00:00Z') } });
    assert.equal(nextDueOccurrence(late, CHI)?.key, '2026-11-14T20:00');
    // Early: the 8:00 PM dose given at 6 PM covers 8:00 PM; next is tomorrow 8:00 AM.
    const early = course({ lastDose: { ...dose('2026-11-14T20:00', '2026-11-15T02:00:00Z'), givenAt: new Date('2026-11-15T00:00:00Z') } });
    assert.equal(nextDueOccurrence(early, CHI)?.key, '2026-11-15T08:00');
  });

  test('a schedule edit recomputes from the latest dose: no duplicate future occurrence (PE-24n)', () => {
    const before = course({ lastDose: dose('2026-11-14T08:00', '2026-11-14T14:00:00Z') });
    // 8:00 AM given, then the times move to 9:00 AM / 9:00 PM: 9:00 AM replaces the
    // given dose, so 9:00 PM is next (not 9:00 AM again an hour later).
    const moved = { schedule: { kind: 'days' as const, everyDays: 1, times: ['09:00', '21:00'] }, startDay: '2026-11-13', endDay: null };
    const coveredUntil = coverageAfterEdit(before, moved, CHI);
    assert.equal(iso(coveredUntil!), '2026-11-14T15:00:00.000Z');
    const edited = course({ ...moved, lastDose: dose('2026-11-14T08:00', '2026-11-14T14:00:00Z'), coveredUntil: new Date(coveredUntil!) });
    assert.equal(nextDueOccurrence(edited, CHI)?.key, '2026-11-14T21:00');
    // Once a day at 9:00 PM instead: that evening dose is still due (12 h away, not a replacement).
    const evening = { schedule: { kind: 'days' as const, everyDays: 1, times: ['21:00'] }, startDay: '2026-11-13', endDay: null };
    assert.equal(coverageAfterEdit(before, evening, CHI), null);
    assert.equal(nextDueOccurrence(course({ ...evening, lastDose: dose('2026-11-14T08:00', '2026-11-14T14:00:00Z') }), CHI)?.key, '2026-11-14T21:00');
    // No dose yet: nothing to carry over.
    assert.equal(coverageAfterEdit(course(), moved, CHI), null);
  });

  test('a finished course or one past its end has no next dose', () => {
    assert.equal(nextDueOccurrence(course({ status: 'finished' }), CHI), null);
    assert.equal(nextDueOccurrence(course({ endDay: '2026-11-13', lastDose: dose('2026-11-13T20:00', '2026-11-14T02:00:00Z') }), CHI), null);
  });
});

describe('state and copy', () => {
  const at = (value: string) => new Date(value);

  test('due on its household day ("Due 8:00 PM", then "Due since"), overdue after it, across midnight', () => {
    const c = course({ lastDose: dose('2026-11-14T08:00', '2026-11-14T14:00:00Z') });
    assert.deepEqual(pick(courseDue(c, at('2026-11-14T20:00:00Z'), CHI)), ['due', 'Due 8:00 PM', false]);
    assert.deepEqual(pick(courseDue(c, at('2026-11-15T03:00:00Z'), CHI)), ['due', 'Due since 8:00 PM', true]);
    // 11:59 PM Chicago: still the household's Nov 14.
    assert.equal(courseDue(c, at('2026-11-15T05:59:00Z'), CHI)?.state, 'due');
    // 12:01 AM Nov 15 Chicago.
    assert.deepEqual(pick(courseDue(c, at('2026-11-15T06:01:00Z'), CHI)), ['overdue', 'Overdue by 1 day', true]);
  });

  test('tomorrow and later', () => {
    const c = course({ lastDose: dose('2026-11-14T20:00', '2026-11-15T02:00:00Z') });
    assert.equal(courseDue(c, at('2026-11-14T22:00:00Z'), CHI)?.label, 'Due tomorrow 8:00 AM');
    const monthly = readCourse('m', { name: 'Heartworm', dosage: '1 chew', schedule: { kind: 'days', everyDays: 30, times: [] }, startDay: '2026-12-06', status: 'active' })!;
    assert.deepEqual(pick(courseDue(monthly, at('2026-11-14T18:00:00Z'), CHI)), ['upcoming', 'Due in 22 days', false]);
    assert.equal(occurrenceStatus({ key: '2026-11-16', day: '2026-11-16', time: null, at: 0 }, at('2026-11-14T18:00:00Z'), CHI).state, 'soon');
  });

  test('labels and summaries', () => {
    assert.equal(formatDoseTime('00:05'), '12:05 AM');
    assert.equal(formatDoseTime('12:00'), '12:00 PM');
    assert.equal(scheduleSummary(twiceDaily), 'Every day at 8:00 AM and 8:00 PM');
    assert.equal(scheduleSummary({ kind: 'days', everyDays: 30, times: [] }), 'Every 30 days');
    assert.equal(scheduleSummary({ kind: 'days', everyDays: 7, times: ['09:00'] }), 'Every week at 9:00 AM');
    assert.equal(scheduleSummary({ kind: 'hours', everyHours: 8, firstTime: '06:00' }), 'Every 8 hours from 6:00 AM');
  });
});

function pick(due: ReturnType<typeof courseDue>) {
  return due ? [due.state, due.label, due.reached] : null;
}
