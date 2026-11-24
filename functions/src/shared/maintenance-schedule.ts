// Schedule date math shared by the Maintenance page, the server operations and
// the hourly job: when a completed schedule is next due (completion- or
// calendar-anchored) and when a renewed registration or inspection expires.
// Pure and day-based: every date is a household-local "YYYY-MM-DD" string, so
// no Date timezone drift (DST, the server clock) can move a due day.
import {addDays, diffDays, isDayString} from "./calendar";

export type IntervalUnit = "days" | "weeks" | "months" | "years";

/**
 * "completion" (the default, and every schedule saved before anchoring):
 * next due = completion day + interval. "calendar": next due steps from the
 * previous due day by the interval until it is after the completion day, so
 * gutters due every Oct 1 stay on Oct 1 whether done early or late.
 */
export type ScheduleAnchor = "completion" | "calendar";

export type AnchoredSchedule = {
  unit?: IntervalUnit;
  value?: number;
  anchor?: ScheduleAnchor;
  /** Calendar anchor month (1-12), used when there is no usable due day. */
  anchorMonth?: number;
  /** Calendar anchor day of month (1-31, clamped to short months). */
  anchorDay?: number;
  nextDueDate?: string;
  snoozedUntil?: string;
  /**
   * The due day a snooze moved away from (written with `snoozedUntil`).
   * While the snooze applies it is the exact cycle being completed; older
   * snoozes without it fall back to inferring the cycle from the anchors.
   */
  snoozedFrom?: string;
};

/**
 * A registration or inspection renewed up to this many days after it expired
 * keeps its cycle.
 */
export const RENEWAL_GRACE_DAYS = 60;

const pad = (n: number) => String(n).padStart(2, "0");

const dayOnly = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const day = value.slice(0, 10);
  return isDayString(day) ? day : null;
};

const daysInMonth = (year: number, month: number): number =>
  new Date(Date.UTC(year, month, 0)).getUTCDate();

const validDayOfMonth = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isInteger(value) &&
    value >= 1 && value <= 31 ? value : undefined;

const validMonth = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isInteger(value) &&
    value >= 1 && value <= 12 ? value : undefined;

/**
 * Adds whole months to a day, clamping to the end of a shorter month
 * (Jan 31 + 1 month = Feb 28, or Feb 29 in a leap year).
 * @param {string} day Day string.
 * @param {number} months Months to add (may be negative).
 * @param {number} dayOfMonth Day of month to aim for (default: the day's own).
 * @return {string} Day string.
 */
export const addMonthsToDay = (
  day: string, months: number, dayOfMonth?: number,
): string => {
  const [year, month, date] = day.split("-").map(Number);
  const total = year * 12 + (month - 1) + months;
  const nextYear = Math.floor(total / 12);
  const nextMonth = total - nextYear * 12 + 1;
  const wanted = dayOfMonth ?? date;
  const clamped = Math.min(wanted, daysInMonth(nextYear, nextMonth));
  return `${String(nextYear).padStart(4, "0")}-${pad(nextMonth)}-` +
    pad(clamped);
};

const stepFrom = (
  base: string, unit: IntervalUnit, value: number, k: number,
  dayOfMonth?: number,
): string => {
  if (unit === "days") return addDays(base, value * k);
  if (unit === "weeks") return addDays(base, 7 * value * k);
  const months = (unit === "years" ? 12 : 1) * value * k;
  return addMonthsToDay(base, months, dayOfMonth);
};

const monthIndex = (day: string) => {
  const [year, month] = day.split("-").map(Number);
  return year * 12 + month - 1;
};

/**
 * Days a snooze moves a due day past the later of today and that day
 * (`SNOOZE_DAYS` in src/lib/maintenance/schedules.ts; a unit test keeps the
 * two equal). Used to find the cycle a snooze moved away from.
 */
export const SNOOZE_SHIFT_DAYS = 7;

/**
 * The smallest k (>= 1) for which base + k x interval falls after `after`.
 * @param {string} base Lattice origin.
 * @param {IntervalUnit} unit Interval unit.
 * @param {number} value Interval length (> 0).
 * @param {string} after Day the step must be after.
 * @param {number} dayOfMonth Day of month for month/year steps.
 * @return {number} Step index.
 */
const firstStepAfter = (
  base: string, unit: IntervalUnit, value: number, after: string,
  dayOfMonth?: number,
): number => {
  let k = 1;
  if (stepFrom(base, unit, value, 1, dayOfMonth) <= after) {
    if (unit === "days" || unit === "weeks") {
      const length = (unit === "weeks" ? 7 : 1) * value;
      k = Math.max(1, Math.floor(diffDays(after, base) / length));
    } else {
      const length = (unit === "years" ? 12 : 1) * value;
      k = Math.max(1, Math.floor((monthIndex(after) - monthIndex(base)) /
        length));
    }
    while (stepFrom(base, unit, value, k, dayOfMonth) <= after) k++;
  }
  return k;
};

/**
 * The first of base + k x interval (k >= 1) that falls after `after`. Every
 * step is computed from `base`, never from a clamped earlier step, so a
 * schedule due on the 31st returns to the 31st after a short month.
 * @param {string} base Day the cycle is anchored to (the previous due day).
 * @param {IntervalUnit} unit Interval unit.
 * @param {number} value Interval length (> 0).
 * @param {string} after Day the result must be after.
 * @param {number} dayOfMonth Day of month for month/year steps.
 * @return {string} Day string.
 */
export const nextCalendarDue = (
  base: string, unit: IntervalUnit, value: number, after: string,
  dayOfMonth?: number,
): string => stepFrom(base, unit, value,
  firstStepAfter(base, unit, value, after, dayOfMonth), dayOfMonth);

/**
 * The anchor lattice of a month/year schedule with an anchor month and/or
 * day: an origin at least a year before `reference` and the day of month
 * every step keeps. The lattice passes through the anchor month of the
 * reference's year (or, with a day-only anchor, the reference's own month),
 * so a new schedule's cycle includes today's month. Null without anchor
 * fields or for day/week intervals.
 * @param {AnchoredSchedule} schedule Interval and anchors.
 * @param {string} reference A day the origin must be before.
 * @return {{base: string, day: number} | null} Lattice.
 */
const anchorLattice = (
  schedule: AnchoredSchedule, reference: string,
): {base: string; day: number} | null => {
  const unit = schedule.unit;
  if (unit !== "months" && unit !== "years") return null;
  const anchorMonth = validMonth(schedule.anchorMonth);
  const anchorDay = validDayOfMonth(schedule.anchorDay);
  if (!anchorMonth && !anchorDay) return null;
  const interval = Math.max(1, Math.round(schedule.value ?? 1));
  const year = Number(reference.slice(0, 4));
  const month = anchorMonth ?? Number(reference.slice(5, 7));
  const day = anchorDay ?? 1;
  const pivot = `${String(year).padStart(4, "0")}-${pad(month)}-` +
    pad(Math.min(day, daysInMonth(year, month)));
  const stepMonths = (unit === "years" ? 12 : 1) * interval;
  const back = Math.ceil(12 / stepMonths) + 1;
  return {base: addMonthsToDay(pivot, -stepMonths * back, day), day};
};

/**
 * The next due day of a schedule completed on `completedDay`.
 *
 * - Completion-anchored (default): completion day + interval.
 * - Calendar-anchored: steps from the previous due day (`nextDueDate`) until
 *   after the completion day.
 * - Snoozed (`snoozedUntil` equal to `nextDueDate`): the snoozed day is not
 *   the schedule's real cycle. A snooze sets it SNOOZE_SHIFT_DAYS after the
 *   later of that day's today and the due day, so with an anchor month/day
 *   the completed cycle is the last anchor day on or before
 *   snoozed - SNOOZE_SHIFT_DAYS, and the result is the same as completing
 *   the unsnoozed schedule. Without anchor fields the snoozed day is used.
 * - No due day: the anchor month/day place the cycle (a day-only anchor uses
 *   every month, or the completion's month for yearly schedules); with
 *   neither it falls back to completion + interval.
 *
 * `anchorDay` (when set) keeps month/year steps on that day of the month.
 * @param {AnchoredSchedule} schedule Interval and anchor.
 * @param {string} completedDay Completion day (household day).
 * @return {string | undefined} Next due day, or undefined without an
 *   interval or a valid completion day.
 */
export const nextDueDay = (
  schedule: AnchoredSchedule, completedDay: string,
): string | undefined => {
  const completed = dayOnly(completedDay);
  const {unit} = schedule;
  const value = schedule.value;
  if (!completed || !unit || typeof value !== "number" ||
    !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  const interval = Math.round(value);
  if (interval <= 0) return undefined;
  const byMonth = unit === "months" || unit === "years";
  const anchorDay = byMonth ? validDayOfMonth(schedule.anchorDay) : undefined;
  if (schedule.anchor !== "calendar") {
    return stepFrom(completed, unit, interval, 1);
  }
  const anchored = {...schedule, unit, value: interval};
  const previous = dayOnly(schedule.nextDueDate);
  const snoozed = Boolean(previous) &&
    dayOnly(schedule.snoozedUntil) === previous;
  if (previous && !snoozed) {
    return nextCalendarDue(previous, unit, interval, completed, anchorDay);
  }
  const snoozedFrom = snoozed ? dayOnly(schedule.snoozedFrom) : null;
  if (previous && snoozedFrom && snoozedFrom <= previous) {
    // Exact: the cycle the snooze moved away from, as if never snoozed.
    return nextCalendarDue(snoozedFrom, unit, interval, completed, anchorDay);
  }
  if (previous) {
    // Snoozed before `snoozedFrom` existed: infer the cycle the snooze moved
    // away from (exact when the anchors fix the phase: an anchor month with
    // an interval dividing a year, or a monthly day-only anchor).
    const movedFrom = addDays(previous, -SNOOZE_SHIFT_DAYS);
    const lattice = anchorLattice(anchored, movedFrom);
    if (!lattice) {
      return nextCalendarDue(previous, unit, interval, completed, anchorDay);
    }
    const k = firstStepAfter(lattice.base, unit, interval, movedFrom,
      lattice.day);
    const cycle = stepFrom(lattice.base, unit, interval, k - 1, lattice.day);
    return nextCalendarDue(cycle, unit, interval, completed, lattice.day);
  }
  const lattice = anchorLattice(anchored, completed);
  if (lattice) {
    return nextCalendarDue(lattice.base, unit, interval, completed,
      lattice.day);
  }
  return stepFrom(completed, unit, interval, 1);
};

/**
 * First due day of a new calendar-anchored schedule: the first anchor
 * occurrence on or after `today` (gutters every October, created Nov 24
 * 2026: Oct 1 2027; created Sep 20 2026: Oct 1 2026).
 * @param {AnchoredSchedule} schedule Interval and anchor month/day.
 * @param {string} today Household day.
 * @return {string | undefined} Day string.
 */
export const firstCalendarDue = (
  schedule: AnchoredSchedule, today: string,
): string | undefined => {
  if (!isDayString(today)) return undefined;
  const {unit, value} = schedule;
  const yesterday = addDays(today, -1);
  if (!unit || typeof value !== "number" || !Number.isFinite(value) ||
    Math.round(value) <= 0) {
    return undefined;
  }
  const interval = Math.round(value);
  // The lattice comes from today (an implicit anchor month is today's
  // month), then the first anchor day on or after today.
  const lattice = anchorLattice({...schedule, value: interval}, today);
  if (lattice) {
    return nextCalendarDue(lattice.base, unit, interval, yesterday,
      lattice.day);
  }
  return stepFrom(yesterday, unit, interval, 1);
};

/**
 * The new expiration of a registration or inspection marked "Renewed":
 * one year after the current expiration when that is in the future or no
 * more than RENEWAL_GRACE_DAYS past (renewing late keeps the cycle);
 * otherwise (long expired, or no valid date) one year after today.
 * Feb 29 renews to Feb 28.
 * @param {string | null | undefined} current Current expiration.
 * @param {string} today Household day.
 * @return {string} New expiration day.
 */
export const renewedExpiration = (
  current: string | null | undefined, today: string,
): string => {
  const day = dayOnly(current);
  const base = day && diffDays(today, day) <= RENEWAL_GRACE_DAYS ? day : today;
  return addMonthsToDay(base, 12);
};
