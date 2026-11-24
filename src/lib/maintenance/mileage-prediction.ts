// Mileage-based due date estimate (MA-29). From dated odometer readings it fits
// miles per day and estimates when a vehicle reaches a service's next-due
// mileage. It is an estimate shown next to the reminder; the authoritative due
// date and mileage trigger (functions/src/shared/maintenance-reminders.ts) are
// unchanged. Pure, unit tested (tests/unit/maintenance-insights-prediction.test.ts).
import { format } from 'date-fns';
import { addDays, diffDays, isDayString, toDay } from '../../../functions/src/shared/calendar';
import type { MaintenanceLog } from '../types';
import { linkedLogs, type LinkFields } from './links';

export type MileageReading = { day: string; miles: number };

/** Only readings from this many days before today are used. */
export const READING_WINDOW_DAYS = 365;
/** Fewest readings (after cleaning) for an estimate. */
export const MIN_READINGS = 3;
/** Fewest days the cleaned readings must span. */
export const MIN_SPAN_DAYS = 30;
/** A rise faster than this between two readings is a typo, not driving. */
export const MAX_MILES_PER_DAY = 1000;
/** Estimates further out than this are not shown (too far to extrapolate from a year of data). */
export const MAX_ESTIMATE_DAYS = 730;

export type InsufficientReason =
  | 'no-due-mileage'
  | 'too-few-readings'
  | 'too-short-span'
  | 'no-increase'
  | 'already-reached'
  | 'too-far';

export type MileagePrediction =
  | {
      /** Estimated day the due mileage is reached. */
      date: string;
      /** Earliest likely day (faster driving). */
      low: string;
      /** Latest likely day (slower driving). */
      high: string;
      /** Number of readings the estimate is based on. */
      basis: number;
      milesPerDay: number;
    }
  | { insufficient: InsufficientReason };

const isMiles = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;

/**
 * Dated readings for a vehicle: each linked log with a mileage and a readable
 * date, plus the vehicle's current mileage when `mileageUpdatedAt` says when it
 * was read (a current mileage without that date is not a dated reading).
 */
export function vehicleReadings(
  vehicle: { id: string; currentMileage?: number | null; mileageUpdatedAt?: string | null },
  logs: readonly (LinkFields & Pick<MaintenanceLog, 'date' | 'mileage'>)[],
  timeZone: string,
): MileageReading[] {
  const readings: MileageReading[] = [];
  for (const log of linkedLogs(logs, { type: 'vehicle', id: vehicle.id })) {
    const day = toDay(log.date, timeZone);
    if (day && isMiles(log.mileage)) readings.push({ day, miles: log.mileage });
  }
  const updated = toDay(vehicle.mileageUpdatedAt, timeZone);
  if (updated && isMiles(vehicle.currentMileage)) readings.push({ day: updated, miles: vehicle.currentMileage });
  return readings;
}

/**
 * Miles per day from `a` to the later-or-same-day `b` (a same-day step counts
 * as one day), or null when the step is implausible: backwards, or faster than
 * 1,000 mi/day.
 */
const stepRate = (a: MileageReading, b: MileageReading): number | null => {
  const rise = b.miles - a.miles;
  if (rise < 0) return null;
  const rate = rise / Math.max(1, diffDays(b.day, a.day));
  return rate <= MAX_MILES_PER_DAY ? rate : null;
};

/**
 * Removes backdated readings and typos: sorts by day and keeps the longest chain
 * in which each reading is at or above the one before and rises no faster than
 * 1,000 mi/day. A single wrong reading (too high or too low, early or late)
 * therefore drops out instead of discarding the readings around it. Between
 * chains of the same length, the one whose fastest step is slower wins (a typo
 * makes one step very fast), then the earliest. Readings outside the last 365 days or after today are left out.
 */
export function cleanReadings(readings: readonly MileageReading[], today: string): MileageReading[] {
  const inWindow = readings
    .filter((reading) => isDayString(reading.day) && isMiles(reading.miles))
    .filter((reading) => {
      const age = diffDays(today, reading.day);
      return age >= 0 && age <= READING_WINDOW_DAYS;
    })
    .sort((a, b) => a.day.localeCompare(b.day) || a.miles - b.miles);
  const n = inWindow.length;
  if (n === 0) return [];
  const length = new Array<number>(n).fill(1);
  const fastest = new Array<number>(n).fill(0);
  const previous = new Array<number>(n).fill(-1);
  const better = (len: number, worst: number, i: number) => len > length[i] || (len === length[i] && worst < fastest[i]);
  for (let i = 0; i < n; i += 1) {
    for (let j = 0; j < i; j += 1) {
      const rate = stepRate(inWindow[j], inWindow[i]);
      if (rate === null) continue;
      const worst = Math.max(fastest[j], rate);
      if (better(length[j] + 1, worst, i)) {
        length[i] = length[j] + 1;
        fastest[i] = worst;
        previous[i] = j;
      }
    }
  }
  let end = 0;
  for (let i = 1; i < n; i += 1) if (length[i] > length[end] || (length[i] === length[end] && fastest[i] < fastest[end])) end = i;
  const chain: MileageReading[] = [];
  for (let i = end; i >= 0; i = previous[i]) chain.unshift(inWindow[i]);
  return chain;
}

const quantile = (sorted: readonly number[], q: number) => {
  const position = (sorted.length - 1) * q;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
};

export type MileageFit = { milesPerDay: number; lowRate: number; highRate: number; basis: number; last: MileageReading };

/**
 * Theil-Sen fit of miles per day over the cleaned readings: the median of the
 * slopes between every pair of readings on different days, which one odd reading
 * cannot pull far. `lowRate`/`highRate` are the 25th and 75th percentile slopes
 * (the low one never below half the median). Insufficient when, after
 * cleaning, there are fewer than three readings or they span fewer than 30 days,
 * or when the median slope is not above zero.
 */
export function fitMilesPerDay(readings: readonly MileageReading[], today: string): MileageFit | { insufficient: InsufficientReason } {
  const clean = cleanReadings(readings, today);
  if (clean.length < MIN_READINGS) return { insufficient: 'too-few-readings' };
  const first = clean[0];
  const last = clean[clean.length - 1];
  if (diffDays(last.day, first.day) < MIN_SPAN_DAYS) return { insufficient: 'too-short-span' };
  const slopes: number[] = [];
  for (let i = 0; i < clean.length; i += 1) {
    for (let j = i + 1; j < clean.length; j += 1) {
      const days = diffDays(clean[j].day, clean[i].day);
      if (days > 0) slopes.push((clean[j].miles - clean[i].miles) / days);
    }
  }
  slopes.sort((a, b) => a - b);
  const milesPerDay = quantile(slopes, 0.5);
  if (!(milesPerDay > 0)) return { insufficient: 'no-increase' };
  return {
    milesPerDay,
    lowRate: Math.max(quantile(slopes, 0.25), milesPerDay / 2),
    highRate: Math.max(quantile(slopes, 0.75), milesPerDay),
    basis: clean.length,
    last,
  };
}

/**
 * When the vehicle should reach `nextDueMileage`, counted from the latest
 * cleaned reading at the fitted rate. `low` ≤ `date` ≤ `high`. A mileage that
 * the latest reading has already reached is 'already-reached' (the reminder
 * itself says it is due); an estimate before today is moved to today. An
 * estimate more than 730 days out is 'too-far', decided on the day count before
 * any date is built; the range's late end is capped at that horizon.
 */
export function predictDueDate(
  nextDueMileage: number | null | undefined,
  readings: readonly MileageReading[],
  today: string,
): MileagePrediction {
  if (!isMiles(nextDueMileage)) return { insufficient: 'no-due-mileage' };
  const fit = fitMilesPerDay(readings, today);
  if ('insufficient' in fit) return fit;
  const remaining = nextDueMileage - fit.last.miles;
  if (remaining <= 0) return { insufficient: 'already-reached' };
  // Days from today, worked out as numbers and checked against the horizon
  // before any date is built: a tiny rate gives a huge (or infinite) count that
  // would overflow the calendar helpers' four-digit years.
  const lastOffset = diffDays(fit.last.day, today);
  const daysFromToday = (rate: number) => Math.max(0, lastOffset + Math.ceil(remaining / rate));
  const days = daysFromToday(fit.milesPerDay);
  if (!Number.isFinite(days) || days > MAX_ESTIMATE_DAYS) return { insufficient: 'too-far' };
  // The slow end of the range is capped at the horizon (still on or after `date`).
  const highDays = daysFromToday(fit.lowRate);
  const lowDays = daysFromToday(fit.highRate);
  return {
    date: addDays(today, days),
    low: addDays(today, Math.min(lowDays, days)),
    high: addDays(today, Number.isFinite(highDays) ? Math.min(Math.max(highDays, days), MAX_ESTIMATE_DAYS) : MAX_ESTIMATE_DAYS),
    basis: fit.basis,
    milesPerDay: fit.milesPerDay,
  };
}

const dayLabel = (day: string, today: string) =>
  format(new Date(`${day}T12:00:00`), day.slice(0, 4) === today.slice(0, 4) ? 'MMM d' : 'MMM d, yyyy');

/**
 * Copy for an estimate: "Estimated around Mar 12, based on 6 readings" (the
 * year is added when it is not this year). Null when there is no estimate: the
 * page then shows only the authoritative due line.
 */
export function predictionText(prediction: MileagePrediction, today: string): string | null {
  if ('insufficient' in prediction) return null;
  return `Estimated around ${dayLabel(prediction.date, today)}, based on ${prediction.basis} readings`;
}
