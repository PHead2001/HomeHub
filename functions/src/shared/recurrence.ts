// Recurring chore rules on day strings. A faithful port of the web app's
// original browser-local logic so server and client generate identical chores.
import {
  addDays, dayOfMonth, dayOfWeek, diffDays, isDayString,
} from "./calendar";

export type RecurrenceFrequency = "daily" | "weekly" | "biweekly" | "monthly";

export type RecurrenceInput = {
  frequency?: string;
  interval?: number;
  assignedToEmail?: string;
  startDate?: string;
  dailyOptions?: {excludeWeekends?: boolean};
  weeklyOptions?: {daysOfWeek?: number[]};
  monthlyOptions?: {
    mode?: "dayOfMonth" | "nthWeekday";
    dayOfMonth?: number;
    nthWeekday?: {week: number; dayOfWeek: number};
  };
};

export type NormalizedRecurrence = RecurrenceInput & {
  frequency: RecurrenceFrequency;
};

const FREQUENCIES = ["daily", "weekly", "biweekly", "monthly"];

const weekdays = (r: RecurrenceInput, today: string): number[] => {
  const days = (r.weeklyOptions?.daysOfWeek || [])
    .filter((d) => Number.isInteger(d) && d >= 0 && d <= 6);
  if (days.length > 0) return days;
  const anchor = isDayString(r.startDate) ? r.startDate : today;
  return [dayOfWeek(anchor)];
};

/**
 * Normalizes a stored recurrence, or returns null if it is not recurring.
 * @param {RecurrenceInput | null | undefined} r Stored recurrence.
 * @param {string} today Today's day string in the household timezone.
 * @return {NormalizedRecurrence | null} Normalized recurrence.
 */
export const normalizeRecurrence = (
  r: RecurrenceInput | null | undefined,
  today: string,
): NormalizedRecurrence | null => {
  if (!r || !r.frequency || !FREQUENCIES.includes(r.frequency)) return null;
  const frequency = r.frequency as RecurrenceFrequency;
  const normalized: NormalizedRecurrence = {
    ...r,
    frequency,
    interval: frequency === "biweekly" ? 2 : (r.interval || 1),
  };
  if (frequency === "daily") {
    normalized.dailyOptions = {
      excludeWeekends: Boolean(r.dailyOptions?.excludeWeekends),
    };
  }
  if (frequency === "weekly" || frequency === "biweekly") {
    normalized.weeklyOptions = {daysOfWeek: weekdays(r, today)};
  }
  if (frequency === "biweekly") {
    normalized.startDate = isDayString(r.startDate) ? r.startDate : today;
  }
  if (frequency === "monthly") {
    const nth = r.monthlyOptions?.nthWeekday;
    normalized.monthlyOptions = r.monthlyOptions?.mode === "nthWeekday" && nth ?
      {mode: "nthWeekday", nthWeekday: nth} :
      {mode: "dayOfMonth", dayOfMonth: r.monthlyOptions?.dayOfMonth || 1};
  }
  return normalized;
};

export const occursOn = (day: string, r: NormalizedRecurrence): boolean => {
  if (r.frequency === "daily") {
    const weekday = dayOfWeek(day);
    return !r.dailyOptions?.excludeWeekends || (weekday > 0 && weekday < 6);
  }
  if (r.frequency === "weekly" || r.frequency === "biweekly") {
    if (!(r.weeklyOptions?.daysOfWeek || []).includes(dayOfWeek(day))) {
      return false;
    }
    if (r.frequency === "weekly") return true;
    const since = diffDays(day, r.startDate as string);
    return since >= 0 && Math.floor(since / 7) % 2 === 0;
  }
  const monthly = r.monthlyOptions;
  if (!monthly) return false;
  if (monthly.mode === "nthWeekday" && monthly.nthWeekday) {
    const week = Math.floor((dayOfMonth(day) - 1) / 7) + 1;
    return week === monthly.nthWeekday.week &&
      dayOfWeek(day) === monthly.nthWeekday.dayOfWeek;
  }
  return dayOfMonth(day) === (monthly.dayOfMonth || 1);
};

/**
 * The next `limit` occurrence days starting today (inclusive).
 * @param {NormalizedRecurrence} r Recurrence.
 * @param {string} today Today's day string.
 * @param {number} limit Number of occurrences.
 * @return {string[]} Occurrence days.
 */
export const upcomingOccurrences = (
  r: NormalizedRecurrence,
  today: string,
  limit: number,
): string[] => {
  const days: string[] = [];
  // Bound the scan: monthly rules need at most ~31 days per occurrence.
  for (let i = 0; days.length < limit && i < limit * 40; i++) {
    const day = addDays(today, i);
    if (occursOn(day, r)) days.push(day);
  }
  return days;
};
