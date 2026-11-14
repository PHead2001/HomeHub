/**
 * Enumeration of scheduled doses is bounded by a time range relative to `now`
 * or the visible range, never by "the first N after some old point" (hydra
 * rule, Codex round 1 A and B): the Calendar shows every occurrence in its
 * range however dense the schedule or however old an outstanding dose, and
 * Give dose prefills the most recent missed dose however many were missed.
 * A property test checks the shared enumerator and the prefill over random
 * schedules, start days and clocks against a brute-force walk.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  latestOccurrencesUpTo,
  occurrencesAfter,
  occurrencesBetween,
  readCourse,
  zonedInstant,
  doseChoices,
  type CourseSchedule,
} from '../../src/lib/pets/medication-course';
import { courseDueEvents } from '../../src/lib/chores/calendar';
import { addDays } from '../../functions/src/shared/calendar';

const CHI = 'America/Chicago';
const DAY = 86_400_000;
const at = (value: string) => new Date(value);
const pointer = (occurrence: string, occurrenceAt: number) => ({ logId: `log-${occurrence}`, occurrence, occurrenceAt: new Date(occurrenceAt), givenAt: new Date(occurrenceAt), byUid: 'sam', byName: 'Sam' });

describe('the Calendar shows every occurrence in its visible range (A)', () => {
  test('an every-2-hours course fills the whole month, even with an old outstanding dose', () => {
    const course = readCourse('c', {
      name: 'Antibiotic', dosage: '1 ml', schedule: { kind: 'hours', everyHours: 2, firstTime: '00:00' },
      startDay: '2026-10-01', status: 'active',
      // Last given Oct 20: the next dose (Oct 20, 2:00 AM) is long overdue.
      lastDose: pointer('2026-10-20T00:00', zonedInstant('2026-10-20', 0, CHI)),
    })!;
    // The visible month: Nov 2026 (Nov 1 is the fall-back day: 25 hours, 13 doses).
    const events = courseDueEvents([{ petId: 'rex', petName: 'Rex', course }], at('2026-11-15T18:00:00Z'), CHI, '2026-11-30', '2026-11-01');
    const inMonth = events.filter((event) => event.day >= '2026-11-01' && event.day <= '2026-11-30');
    assert.equal(inMonth.length, 30 * 12 + 1, 'every dose of every day of the month');
    assert.equal(new Set(inMonth.map((event) => event.id)).size, inMonth.length);
    // The overdue next dose still leads (for the red rail), once.
    assert.equal(events[0].day, '2026-10-20');
    assert.equal(events[0].overdue, true);
    assert.equal(events.filter((event) => event.day < '2026-11-01').length, 1);
  });
});

describe('Give dose prefills the most recent missed dose (B)', () => {
  test('with hundreds of missed doses, the prefill is the latest passed one, not an old one', () => {
    // UTC keeps the even hours (in Chicago real 2-hour steps shift by the fall-back hour).
    const course = readCourse('c', {
      name: 'Antibiotic', dosage: '1 ml', schedule: { kind: 'hours', everyHours: 2, firstTime: '00:00' },
      startDay: '2026-09-01', status: 'active',
      lastDose: pointer('2026-09-30T00:00', zonedInstant('2026-09-30', 0, 'UTC')),
    })!;
    const now = at('2026-11-14T09:30:00Z'); // 540+ doses missed since Sep 30
    const { prefill, choices } = doseChoices(course, now, 'UTC');
    assert.equal(prefill?.key, '2026-11-14T08:00');
    const missed = choices.filter((choice) => !choice.covered && choice.at <= now.getTime());
    assert.deepEqual(missed.map((choice) => choice.key), ['2026-11-14T04:00', '2026-11-14T06:00', '2026-11-14T08:00']);
  });
});

/* ------------------------------------------------------------------------- */
/* Property test against a brute-force walk                                    */
/* ------------------------------------------------------------------------- */

function random(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

const TIMES = ['00:00', '01:30', '02:30', '06:15', '08:00', '12:00', '18:45', '20:00', '23:59'];

function randomSchedule(rand: () => number): CourseSchedule {
  if (rand() < 0.5) {
    return { kind: 'hours', everyHours: 2 + Math.floor(rand() * 23), firstTime: TIMES[Math.floor(rand() * TIMES.length)] };
  }
  const count = Math.floor(rand() * 4);
  const times = [...new Set(Array.from({ length: count }, () => TIMES[Math.floor(rand() * TIMES.length)]))].sort();
  return { kind: 'days', everyDays: 1 + Math.floor(rand() * (rand() < 0.5 ? 3 : 40)), times };
}

describe('property: the enumerator never drops an occurrence inside its range, the prefill is the most recent missed one', () => {
  const zones = [CHI, 'Europe/London', 'Australia/Sydney', 'UTC'];
  test('150 random schedules, start days, ranges and clocks', () => {
    const rand = random(20261115);
    for (let run = 0; run < 150; run++) {
      const zone = zones[run % zones.length];
      const schedule = randomSchedule(rand);
      // Start days around both 2026 daylight-saving changes and in between.
      const startDay = addDays('2026-02-20', Math.floor(rand() * 300));
      const endDay = rand() < 0.2 ? addDays(startDay, Math.floor(rand() * 60)) : null;
      const window = { schedule, startDay, endDay };
      const startAt = zonedInstant(startDay, 0, zone);
      const from = startAt + Math.floor(rand() * 40 * DAY) - 5 * DAY;
      const to = from + Math.floor(rand() * 35 * DAY);
      const now = from + Math.floor(rand() * 30 * DAY);
      // Brute force: every occurrence from the start, filtered afterwards.
      const all = occurrencesAfter(window, null, zone, 100_000).filter((occurrence) => occurrence.at <= Math.max(to, now) + DAY);
      const expected = all.filter((occurrence) => occurrence.at > from && occurrence.at <= to).map((occurrence) => occurrence.key);
      const label = `${zone} ${JSON.stringify(window)} (${from}, ${to}]`;
      assert.deepEqual(occurrencesBetween(window, from, to, zone).map((occurrence) => occurrence.key), expected, label);

      // The most recent missed occurrences: after the last covered dose, at or before now.
      const covered = rand() < 0.3 ? null : from + Math.floor(rand() * (now - from + 1)) - DAY;
      const missed = all.filter((occurrence) => occurrence.at <= now && (covered === null || occurrence.at > covered));
      assert.deepEqual(
        latestOccurrencesUpTo(window, covered, now, zone, 3).map((occurrence) => occurrence.key),
        missed.slice(-3).map((occurrence) => occurrence.key),
        `${label} now ${now} covered ${covered}`,
      );
      // Give dose prefills the latest of them when any was missed.
      if (missed.length > 0) {
        const course = readCourse('c', {
          name: 'X', dosage: '1', schedule, startDay, endDay, status: 'active',
          ...(covered === null ? {} : { coveredUntil: new Date(covered) }),
        })!;
        assert.equal(doseChoices(course, new Date(now), zone).prefill?.key, missed[missed.length - 1].key, `${label} prefill`);
      }
    }
  });
});
