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
): string => {
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
  return stepFrom(base, unit, value, k, dayOfMonth);
};

/**
 * The next due day of a schedule completed on `completedDay`.
 *
 * - Completion-anchored (default): completion day + interval.
 * - Calendar-anchored: steps from the previous due day (`nextDueDate`) until
 *   after the completion day. A snoozed due day (`snoozedUntil` equal to it)
 *   is not the schedule's real phase, so then the anchor month/day is used
 *   when set; without them the snoozed day is used. With no due day at all,
 *   the anchor month/day place the cycle; with neither it falls back to
 *   completion + interval.
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
  const previous = dayOnly(schedule.nextDueDate);
  const snoozed = Boolean(previous) &&
    dayOnly(schedule.snoozedUntil) === previous;
  if (previous && !snoozed) {
    return nextCalendarDue(previous, unit, interval, completed, anchorDay);
  }
  const anchorMonth = byMonth ? validMonth(schedule.anchorMonth) : undefined;
  if (anchorMonth) {
    const year = Number(completed.slice(0, 4)) - 1;
    const day = Math.min(anchorDay ?? 1, daysInMonth(year, anchorMonth));
    const base = `${String(year).padStart(4, "0")}-${pad(anchorMonth)}-` +
      pad(day);
    return nextCalendarDue(base, unit, interval, completed, anchorDay ?? 1);
  }
  if (previous) {
    return nextCalendarDue(previous, unit, interval, completed, anchorDay);
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
  return nextDueDay(
    {...schedule, anchor: "calendar", nextDueDate: undefined},
    addDays(today, -1));
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
