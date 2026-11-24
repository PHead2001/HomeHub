import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { addDays, localDay } from '../../functions/src/shared/calendar';
import {
  addMonthsToDay,
  firstCalendarDue,
  nextCalendarDue,
  nextDueDay,
  renewedExpiration,
  RENEWAL_GRACE_DAYS,
  SNOOZE_SHIFT_DAYS,
} from '../../functions/src/shared/maintenance-schedule';
import {
  calculateNextAssetDueDate,
  calculateNextVehicleDueDate,
  completedAssetSchedule,
  nextDueAfterCompletion,
  snoozedDueDate,
  SNOOZE_DAYS,
} from '../../src/lib/maintenance/schedules';
import type { HomeAssetSchedule, VehicleServiceSchedule } from '../../src/lib/types';

const CHI = 'America/Chicago';

const gutters: HomeAssetSchedule = {
  id: 'gutters', mode: 'scheduled', scheduleName: 'Clean gutters', frequencyType: 'years', intervalValue: 1,
  anchor: 'calendar', anchorMonth: 10, anchorDay: 1, nextDueDate: '2026-10-01',
};

describe('month math on day strings (MA-11g)', () => {
  it('clamps to month ends and leap days', () => {
    assert.equal(addMonthsToDay('2026-01-31', 1), '2026-02-28');
    assert.equal(addMonthsToDay('2028-01-31', 1), '2028-02-29');
    assert.equal(addMonthsToDay('2028-02-29', 12), '2029-02-28');
    assert.equal(addMonthsToDay('2026-11-30', 3), '2027-02-28');
    assert.equal(addMonthsToDay('2026-03-31', -1), '2026-02-28');
    assert.equal(addMonthsToDay('2026-02-28', 1, 31), '2026-03-31');
  });

  it('steps from the base, never from a clamped step', () => {
    // Monthly on the 31st: after a short month it returns to the 31st.
    assert.equal(nextCalendarDue('2026-01-31', 'months', 1, '2026-02-10'), '2026-02-28');
    assert.equal(nextCalendarDue('2026-01-31', 'months', 1, '2026-03-01'), '2026-03-31');
    assert.equal(nextCalendarDue('2026-01-31', 'months', 1, '2026-04-30'), '2026-05-31');
    assert.equal(nextCalendarDue('2026-11-01', 'weeks', 2, '2027-01-05'), '2027-01-10');
    assert.equal(nextCalendarDue('2020-10-01', 'years', 1, '2026-11-05'), '2027-10-01');
  });
});

describe('calendar-anchored completion (MA-11g)', () => {
  it('keeps gutters on Oct 1 whether done late or early', () => {
    assert.equal(nextDueAfterCompletion(gutters, '2026-11-05'), '2027-10-01');
    assert.equal(nextDueAfterCompletion(gutters, '2026-09-20'), '2027-10-01');
    assert.equal(nextDueAfterCompletion(gutters, '2026-10-01'), '2027-10-01');
    // Skipped a year: the next Oct 1 after the completion.
    assert.equal(nextDueAfterCompletion(gutters, '2027-12-01'), '2028-10-01');
  });

  it('completion-anchored (default) adds the interval to the completion day', () => {
    assert.equal(nextDueAfterCompletion({ ...gutters, anchor: undefined }, '2026-11-05'), '2027-11-05');
    assert.equal(nextDueAfterCompletion({ ...gutters, anchor: 'completion' }, '2026-09-20'), '2027-09-20');
  });

  it('a snoozed due day is not the phase: the anchor month/day are', () => {
    const snoozed = { ...gutters, nextDueDate: '2026-10-08', snoozedUntil: '2026-10-08' };
    assert.equal(nextDueAfterCompletion(snoozed, '2026-10-09'), '2027-10-01');
    // Without anchor fields the snoozed day is all there is.
    assert.equal(nextDueAfterCompletion({ ...snoozed, anchorMonth: undefined, anchorDay: undefined }, '2026-10-09'), '2027-10-08');
  });

  it('places a new calendar schedule by its anchor month, and falls back to completion + interval', () => {
    assert.equal(nextDueAfterCompletion({ ...gutters, nextDueDate: undefined }, '2026-11-24'), '2027-10-01');
    assert.equal(nextDueAfterCompletion({ ...gutters, nextDueDate: undefined }, '2026-09-20'), '2026-10-01');
    // A day-only yearly anchor keeps the completion's month on that day; no anchors at all: completion + interval.
    assert.equal(nextDueAfterCompletion({ ...gutters, nextDueDate: undefined, anchorMonth: undefined }, '2026-09-20'), '2027-09-01');
    assert.equal(nextDueAfterCompletion({ ...gutters, nextDueDate: undefined, anchorMonth: undefined, anchorDay: undefined }, '2026-09-20'), '2027-09-20');
    assert.equal(firstCalendarDue({ unit: 'years', value: 1, anchorMonth: 10, anchorDay: 1 }, '2026-11-24'), '2027-10-01');
    assert.equal(firstCalendarDue({ unit: 'years', value: 1, anchorMonth: 10, anchorDay: 1 }, '2026-10-01'), '2026-10-01');
  });

  it('month-end and leap-year anchors', () => {
    const monthly: HomeAssetSchedule = { mode: 'scheduled', frequencyType: 'months', intervalValue: 1, anchor: 'calendar', anchorDay: 31, nextDueDate: '2026-02-28' };
    assert.equal(nextDueAfterCompletion(monthly, '2026-03-02'), '2026-03-31');
    const leap: HomeAssetSchedule = { mode: 'scheduled', frequencyType: 'years', intervalValue: 1, anchor: 'calendar', anchorMonth: 2, anchorDay: 29, nextDueDate: '2027-02-28' };
    assert.equal(nextDueAfterCompletion(leap, '2027-03-01'), '2028-02-29');
    assert.equal(nextDueAfterCompletion({ ...leap, nextDueDate: '2028-02-29' }, '2028-02-29'), '2029-02-28');
    // Calendar quarterly from Nov 30 through February.
    const quarterly: HomeAssetSchedule = { mode: 'scheduled', frequencyType: 'months', intervalValue: 3, anchor: 'calendar', nextDueDate: '2026-11-30' };
    assert.equal(nextDueAfterCompletion(quarterly, '2026-12-01'), '2027-02-28');
  });

  it('vehicle services anchor on intervalMonths; mileage-only services have no date', () => {
    const inspection: VehicleServiceSchedule = { id: 'i', mode: 'scheduled', serviceName: 'Inspection', intervalMonths: 12, anchor: 'calendar', nextDueDate: '2026-03-31' };
    assert.equal(nextDueAfterCompletion(inspection, '2026-04-15'), '2027-03-31');
    assert.equal(nextDueAfterCompletion({ ...inspection, anchor: undefined }, '2026-04-15'), '2027-04-15');
    assert.equal(nextDueAfterCompletion({ id: 't', serviceName: 'Tires', intervalMiles: 7500 }, '2026-04-15'), undefined);
    assert.equal(nextDueAfterCompletion({ scheduleName: 'No interval' }, '2026-04-15'), undefined);
  });

  it('completion anchoring matches the existing date-fns advancement exactly (parity)', () => {
    const units = [['days', 10], ['weeks', 2], ['months', 1], ['months', 3], ['years', 1]] as const;
    let day = '2027-12-25';
    for (let i = 0; i < 800; i++) {
      day = addDays(day, 1);
      for (const [unit, value] of units) {
        const schedule: HomeAssetSchedule = { frequencyType: unit, intervalValue: value };
        assert.equal(nextDueAfterCompletion(schedule, day), calculateNextAssetDueDate(schedule, day), `${unit} ${value} from ${day}`);
      }
      const service: VehicleServiceSchedule = { serviceName: 'Oil', intervalMonths: 6 };
      assert.equal(nextDueAfterCompletion(service, day), calculateNextVehicleDueDate(service, day), `vehicle from ${day}`);
    }
  });

  it('household days around DST stay on their day (America/Chicago, Mar 8 and Nov 1 2026)', () => {
    // 05:30Z on Mar 8 is still Mar 7 in Chicago (23:30 CST); 07:30Z is Mar 8 after the jump.
    const springDay = localDay(new Date('2026-03-08T05:30:00Z'), CHI);
    assert.equal(springDay, '2026-03-07');
    assert.equal(localDay(new Date('2026-03-08T08:30:00Z'), CHI), '2026-03-08');
    const weekly: HomeAssetSchedule = { frequencyType: 'weeks', intervalValue: 1, anchor: 'calendar', nextDueDate: '2026-03-01' };
    assert.equal(nextDueAfterCompletion(weekly, springDay), '2026-03-08');
    assert.equal(nextDueAfterCompletion(weekly, '2026-03-08'), '2026-03-15');
    // Fall back: 05:30Z Nov 1 is 00:30 CDT Nov 1; 06:30Z Nov 2 is 00:30 CST Nov 2.
    assert.equal(localDay(new Date('2026-11-01T05:30:00Z'), CHI), '2026-11-01');
    assert.equal(localDay(new Date('2026-11-02T06:30:00Z'), CHI), '2026-11-02');
    assert.equal(nextDueAfterCompletion({ frequencyType: 'days', intervalValue: 1 }, '2026-10-31'), '2026-11-01');
    assert.equal(nextDueAfterCompletion({ frequencyType: 'days', intervalValue: 1 }, '2026-11-01'), '2026-11-02');
    assert.equal(nextDueAfterCompletion({ frequencyType: 'days', intervalValue: 1 }, '2026-03-07'), '2026-03-08');
  });

  it('rejects bad input', () => {
    assert.equal(nextDueDay({ unit: 'months', value: 0 }, '2026-01-01'), undefined);
    assert.equal(nextDueDay({ unit: 'months', value: 1 }, 'not a day'), undefined);
    // ISO completion timestamps are read as their first ten characters.
    assert.equal(nextDueDay({ unit: 'months', value: 1 }, '2026-01-31T18:00:00.000Z'), '2026-02-28');
  });
});

describe('renewed registration or inspection (MA-11h)', () => {
  it('renews from the current expiration when it is ahead or recently past, else from today', () => {
    assert.equal(RENEWAL_GRACE_DAYS, 60);
    assert.equal(renewedExpiration('2026-12-15', '2026-11-24'), '2027-12-15');
    assert.equal(renewedExpiration('2026-10-01', '2026-11-24'), '2027-10-01'); // 54 days past
    assert.equal(renewedExpiration('2026-09-25', '2026-11-24'), '2027-09-25'); // exactly 60 days past
    assert.equal(renewedExpiration('2026-09-24', '2026-11-24'), '2027-11-24'); // 61 days past
    assert.equal(renewedExpiration(undefined, '2026-11-24'), '2027-11-24');
    assert.equal(renewedExpiration('2028-02-29', '2028-02-01'), '2029-02-28');
    assert.equal(renewedExpiration('2026-12-15T06:00:00.000Z', '2026-11-24'), '2027-12-15');
  });
});

describe('review fixes (PR #209)', () => {
  it('a snoozed anchored schedule completes the cycle the snooze moved away from', () => {
    const snoozed = { ...gutters, nextDueDate: '2026-10-08', snoozedUntil: '2026-10-08' };
    // Completed before the original Oct 1: still the 2026 cycle, as without the snooze.
    assert.equal(nextDueAfterCompletion(snoozed, '2026-09-30'), '2027-10-01');
    assert.equal(nextDueAfterCompletion({ ...gutters }, '2026-09-30'), '2027-10-01');
    assert.equal(nextDueAfterCompletion(snoozed, '2026-10-08'), '2027-10-01');
    // Snoozed while overdue (today Oct 20, due Oct 1): moved to Oct 27.
    const late = { ...gutters, nextDueDate: '2026-10-27', snoozedUntil: '2026-10-27' };
    assert.equal(nextDueAfterCompletion(late, '2026-10-21'), '2027-10-01');
  });

  it('day-only anchors place the first calendar due day', () => {
    assert.equal(firstCalendarDue({ unit: 'months', value: 1, anchorDay: 31 }, '2026-11-24'), '2026-11-30');
    assert.equal(firstCalendarDue({ unit: 'months', value: 1, anchorDay: 31 }, '2026-12-01'), '2026-12-31');
    assert.equal(firstCalendarDue({ unit: 'months', value: 1, anchorDay: 15 }, '2026-11-15'), '2026-11-15');
    assert.equal(firstCalendarDue({ unit: 'years', value: 1, anchorDay: 1 }, '2026-11-24'), '2027-11-01');
    assert.equal(nextDueAfterCompletion({ frequencyType: 'months', intervalValue: 1, anchor: 'calendar', anchorDay: 31 }, '2027-02-10'), '2027-02-28');
  });

  it('the shared snooze shift equals the page snooze', () => {
    assert.equal(SNOOZE_SHIFT_DAYS, SNOOZE_DAYS);
  });

  // Deterministic PRNG (mulberry32).
  const rng = (seed: number) => () => {
    seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  it('finding 1: a day-only yearly anchor initialised on the first of a month keeps that month', () => {
    assert.equal(firstCalendarDue({ unit: 'years', value: 1, anchorDay: 1 }, '2026-11-01'), '2026-11-01');
    assert.equal(firstCalendarDue({ unit: 'months', value: 1, anchorDay: 1 }, '2026-11-01'), '2026-11-01');
    assert.equal(firstCalendarDue({ unit: 'months', value: 1, anchorDay: 31 }, '2026-10-31'), '2026-10-31');
    assert.equal(firstCalendarDue({ unit: 'years', value: 1, anchorMonth: 10, anchorDay: 1 }, '2026-10-01'), '2026-10-01');
  });

  it('finding 2: snoozedFrom keeps the exact cycle of a day-only multi-month schedule snoozed into another month', () => {
    const bimonthly: HomeAssetSchedule = { frequencyType: 'months', intervalValue: 2, anchor: 'calendar', anchorDay: 31 };
    const plain = nextDueAfterCompletion({ ...bimonthly, nextDueDate: '2026-01-31' }, '2026-02-02');
    assert.equal(plain, '2026-03-31');
    // Snoozed on Feb 1 (overdue) to Feb 8, completed Feb 2.
    assert.equal(nextDueAfterCompletion({ ...bimonthly, nextDueDate: '2026-02-08', snoozedUntil: '2026-02-08', snoozedFrom: '2026-01-31' }, '2026-02-02'), plain);
    // A stale snoozedFrom (the snooze no longer applies) is ignored.
    assert.equal(nextDueAfterCompletion({ ...bimonthly, nextDueDate: '2026-03-31', snoozedUntil: '2026-02-08', snoozedFrom: '2026-01-31' }, '2026-04-02'), '2026-05-31');
    // Completion clears both snooze fields.
    const done = completedAssetSchedule({ ...bimonthly, nextDueDate: '2026-02-08', snoozedUntil: '2026-02-08', snoozedFrom: '2026-01-31' }, { completedDate: '2026-02-02' });
    assert.equal('snoozedFrom' in done, false);
    assert.equal('snoozedUntil' in done, false);
  });


  it('property: first due, snoozes in other months and completion all keep the cycle', () => {
    const random = rng(209);
    const int = (min: number, max: number) => min + Math.floor(random() * (max - min + 1));
    const pick = <T,>(items: readonly T[]) => items[Math.floor(random() * items.length)];
    const anyDay = () => addDays('2025-01-01', int(0, 1500));
    const monthEdge = () => {
      const day = anyDay();
      const first = `${day.slice(0, 7)}-01`;
      return random() < 0.5 ? first : addDays(addMonthsToDay(first, 1), -1);
    };
    for (let i = 0; i < 6000; i++) {
      const unit = pick(['months', 'years'] as const);
      const intervalValue = unit === 'years' ? int(1, 3) : int(1, 12);
      const kind = pick(['day', 'month+day', 'month'] as const);
      const anchorDay = kind === 'month' ? undefined : int(1, 31);
      const anchorMonth = kind === 'day' ? undefined : int(1, 12);
      const anchors = { anchorDay, anchorMonth };
      const base: HomeAssetSchedule = { frequencyType: unit, intervalValue, anchor: 'calendar', ...anchors };

      // First due: on or after today, on the anchor day, and today itself when today is an anchor day.
      const created = random() < 0.5 ? monthEdge() : anyDay();
      const due = firstCalendarDue({ unit, value: intervalValue, ...anchors }, created)!;
      const where = JSON.stringify({ base, created, due });
      assert.ok(due >= created, where);
      const [y, m] = due.split('-').map(Number);
      assert.equal(Number(due.slice(8)), Math.min(anchorDay ?? 1, new Date(Date.UTC(y, m, 0)).getUTCDate()), where);
      if (anchorMonth && (unit === 'years' || 12 % intervalValue === 0) && intervalValue * (unit === 'years' ? 12 : 1) <= 12) {
        assert.equal((m - anchorMonth) % (unit === 'years' ? 12 : intervalValue) === 0 || (m - anchorMonth + 12) % (unit === 'years' ? 12 : intervalValue) === 0, true, where);
      }
      const createdMonth = Number(created.slice(5, 7));
      const createdDay = Number(created.slice(8));
      const createdDim = new Date(Date.UTC(Number(created.slice(0, 4)), createdMonth, 0)).getUTCDate();
      const isAnchorDay = (anchorDay === undefined ? createdDay === 1 : createdDay === Math.min(anchorDay, createdDim));
      if (isAnchorDay && (!anchorMonth ? (unit === 'months' || unit === 'years') : (anchorMonth === createdMonth && (unit === 'years' || 12 % intervalValue === 0)))) {
        assert.equal(due, created, where);
      }

      // Snooze from 14 days before the due day to months after it (other months), then complete.
      const today = addDays(due, int(-14, 120));
      const snoozedTo = snoozedDueDate(due, today);
      const completed = addDays(due, int(-60, 500));
      const plain = nextDueAfterCompletion({ ...base, nextDueDate: due }, completed)!;
      const exact = nextDueAfterCompletion({ ...base, nextDueDate: snoozedTo, snoozedUntil: snoozedTo, snoozedFrom: due }, completed)!;
      const context = JSON.stringify({ base, due, today, snoozedTo, completed });
      assert.ok(plain > completed, context);
      assert.equal(exact, plain, context);
      // Legacy snoozes (no snoozedFrom): exact when the anchors fix the phase and completion follows the snooze.
      const fixedPhase = (unit === 'months' && intervalValue === 1 && anchorDay !== undefined)
        || (anchorMonth !== undefined && ((unit === 'months' && 12 % intervalValue === 0) || (unit === 'years' && intervalValue === 1)));
      if (fixedPhase && anchorDay !== undefined) {
        const after = today <= due ? completed : addDays(today, int(0, 400));
        assert.equal(
          nextDueAfterCompletion({ ...base, nextDueDate: snoozedTo, snoozedUntil: snoozedTo }, after),
          nextDueAfterCompletion({ ...base, nextDueDate: due }, after),
          JSON.stringify({ base, due, today, snoozedTo, after }),
        );
      }
    }
    // Any schedule (any unit, anchor or none, stale or live snooze): strictly after the completion day.
    for (let i = 0; i < 4000; i++) {
      const unit = pick(['days', 'weeks', 'months', 'years'] as const);
      const nextDueDate = random() < 0.8 ? anyDay() : undefined;
      const schedule: HomeAssetSchedule = {
        frequencyType: unit,
        intervalValue: int(1, 12),
        anchor: pick(['calendar', 'completion', undefined] as const),
        anchorDay: random() < 0.5 ? int(1, 31) : undefined,
        anchorMonth: random() < 0.5 ? int(1, 12) : undefined,
        nextDueDate,
        snoozedUntil: random() < 0.4 ? (random() < 0.7 ? nextDueDate : anyDay()) : undefined,
        snoozedFrom: random() < 0.3 ? anyDay() : undefined,
      };
      const completed = anyDay();
      const next = nextDueAfterCompletion(schedule, completed);
      assert.ok(next && next > completed, JSON.stringify({ schedule, completed, next }));
    }
  });
});
