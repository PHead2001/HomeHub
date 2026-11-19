/**
 * Household wall time → instant in every kind of zone (Codex round 3): the
 * resolver (`zonedWallInstant` in functions/src/shared/calendar.ts, used by
 * `zonedInstant`, `zonedMidnightIso` and every household-day helper) must use
 * the offsets on both sides of the real local transition, whatever the zone's
 * offset (−11 to +14, 30- and 45-minute offsets, a 30-minute daylight-saving
 * shift). Checked against a brute-force resolver that scans the day minute by
 * minute, on every 2026 transition of the extreme zones (every 15 minutes of
 * the day) and on ordinary days of zones without daylight saving; then the
 * schedule walker over those days (strictly increasing, nothing lost).
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { zonedMidnightIso, zonedWallInstant } from '../../functions/src/shared/calendar';
import { occurrencesAfter, zonedInstant } from '../../functions/src/shared/medication-schedule';
import { bruteDay, hhmm, transitions } from './zoned-brute';

const ZONES = [
  'Pacific/Auckland', 'Pacific/Chatham', 'Australia/Lord_Howe', 'Pacific/Kiritimati', 'Pacific/Pago_Pago',
  'Asia/Kathmandu', 'America/St_Johns', 'America/Santiago', 'America/Chicago', 'Europe/London', 'Australia/Sydney',
];

describe('the resolver uses the offsets on both sides of the local transition (round 3)', () => {
  test('Pacific/Auckland: the missing 2:30 moves forward to 3:30; the repeated 2:30 is the first one', () => {
    // Spring forward 2026-09-27 at 2:00 NZST → 3:00 NZDT.
    assert.equal(new Date(zonedInstant('2026-09-27', 150, 'Pacific/Auckland')).toISOString(), '2026-09-26T14:30:00.000Z');
    // Fall back 2026-04-05 at 3:00 NZDT → 2:00 NZST: 2:30 happens twice; the first is NZDT (+13).
    assert.equal(new Date(zonedInstant('2026-04-05', 150, 'Pacific/Auckland')).toISOString(), '2026-04-04T13:30:00.000Z');
    // A 1:30 / 2:30 / 3:00 schedule keeps three doses on the spring-forward day.
    const list = occurrencesAfter({ schedule: { kind: 'days', everyDays: 1, times: ['01:30', '02:30', '03:00'] }, startDay: '2026-09-27', endDay: '2026-09-27' }, null, 'Pacific/Auckland', 10);
    assert.deepEqual(list.map((o) => o.key), ['2026-09-27T01:30', '2026-09-27T03:00', '2026-09-27T02:30']);
    assert.equal(new Set(list.map((o) => o.at)).size, 3);
  });

  for (const zone of ZONES) {
    test(`${zone}: every 2026 transition (or ordinary days) agrees with the minute-by-minute resolver`, () => {
      const found = transitions(zone);
      const days = found.length > 0 ? found.map((t) => t.day) : ['2026-03-08', '2026-06-21', '2026-11-01'];
      for (const day of days) {
        const brute = bruteDay(day, zone);
        for (let minutes = 0; minutes < 24 * 60; minutes += 15) {
          assert.equal(zonedWallInstant(day, minutes, zone), brute(minutes), `${zone} ${day} ${hhmm(minutes)}`);
        }
        // Around the transition, every minute.
        const t = found.find((entry) => entry.day === day);
        if (t) {
          for (let minutes = Math.max(0, Math.min(t.before, t.after) - 5); minutes < Math.min(24 * 60, Math.max(t.before, t.after) + 65); minutes++) {
            assert.equal(zonedWallInstant(day, minutes, zone), brute(minutes), `${zone} ${day} ${hhmm(minutes)}`);
          }
        }
        // Household midnight is the day's first instant.
        assert.equal(Date.parse(zonedMidnightIso(day, zone)), brute(0), `${zone} ${day} midnight`);
      }
    });
  }

  test('the walker on every transition day: strictly increasing, one dose per distinct instant', () => {
    for (const zone of ZONES) {
      for (const t of transitions(zone)) {
        const lo = Math.min(t.before, t.after);
        const hi = Math.max(t.before, t.after);
        const times = [...new Set([lo - 30, lo, lo + 15, Math.floor((lo + hi) / 2), hi, hi + 15].filter((m) => m >= 0 && m < 24 * 60).map(hhmm))].sort();
        const window = { schedule: { kind: 'days' as const, everyDays: 1, times }, startDay: t.day, endDay: t.day };
        const list = occurrencesAfter(window, null, zone, 50);
        for (let i = 1; i < list.length; i++) assert.ok(list[i].at > list[i - 1].at, `${zone} ${t.day}: ${list[i - 1].key} then ${list[i].key}`);
        const brute = bruteDay(t.day, zone);
        const expected = new Set(times.map((time) => brute(Number(time.slice(0, 2)) * 60 + Number(time.slice(3)))));
        assert.equal(list.length, expected.size, `${zone} ${t.day}: one dose per distinct instant`);
      }
    }
  });
});
