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
} from '../../functions/src/shared/maintenance-schedule';
import {
  calculateNextAssetDueDate,
  calculateNextVehicleDueDate,
  nextDueAfterCompletion,
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
    assert.equal(nextDueAfterCompletion({ ...gutters, nextDueDate: undefined, anchorMonth: undefined }, '2026-09-20'), '2027-09-20');
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
