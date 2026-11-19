// Calendar math on plain "YYYY-MM-DD" day strings, independent of the machine's
// timezone. Shared by Cloud Functions and the web app so both agree on "today".

export const DEFAULT_TIME_ZONE = "America/Chicago";

const DAY_MS = 24 * 60 * 60 * 1000;
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const toUtcDate = (day: string): Date => new Date(`${day}T00:00:00Z`);

export const isDayString = (value: unknown): value is string =>
  typeof value === "string" && DAY_PATTERN.test(value) &&
  !Number.isNaN(toUtcDate(value).getTime());

/**
 * Normalizes a stored due date (day string or ISO timestamp) to a day string
 * in the given timezone.
 * @param {unknown} value Stored date.
 * @param {string} timeZone IANA timezone.
 * @return {string | null} Day string, or null when unparseable.
 */
export const toDay = (value: unknown, timeZone: string): string | null => {
  if (typeof value !== "string" || !value) return null;
  if (isDayString(value)) return value;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : localDay(date, timeZone);
};

export const safeTimeZone = (timeZone: unknown): string => {
  if (typeof timeZone !== "string" || !timeZone) return DEFAULT_TIME_ZONE;
  try {
    new Intl.DateTimeFormat("en-US", {timeZone}).format(0);
    return timeZone;
  } catch {
    return DEFAULT_TIME_ZONE;
  }
};

// One formatter per zone: constructing Intl.DateTimeFormat is far costlier
// than formatting with it, and schedules format thousands of instants.
const formatters = new Map<string, Intl.DateTimeFormat>();
const formatterFor = (timeZone: string): Intl.DateTimeFormat => {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
};

const parts = (instant: Date, timeZone: string) => {
  const formatted = formatterFor(timeZone).formatToParts(instant);
  const get = (type: string) =>
    Number(formatted.find((p) => p.type === type)?.value);
  return {
    year: get("year"), month: get("month"), day: get("day"),
    hour: get("hour"), minute: get("minute"),
  };
};

export const localDay = (instant: Date, timeZone: string): string => {
  const p = parts(instant, timeZone);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
};

export const localMinutes = (instant: Date, timeZone: string): number => {
  const p = parts(instant, timeZone);
  return p.hour * 60 + p.minute;
};

export const addDays = (day: string, amount: number): string =>
  new Date(toUtcDate(day).getTime() + amount * DAY_MS)
    .toISOString().slice(0, 10);

export const diffDays = (later: string, earlier: string): number =>
  Math.round((toUtcDate(later).getTime() - toUtcDate(earlier).getTime()) /
    DAY_MS);

export const dayOfWeek = (day: string): number => toUtcDate(day).getUTCDay();
export const dayOfMonth = (day: string): number => toUtcDate(day).getUTCDate();

const HOUR_MS = 60 * 60 * 1000;

// The zone's offset (local wall clock minus UTC) at an instant, in ms.
const offsetAt = (instant: number, timeZone: string): number => {
  const minute = Math.floor(instant / 60000) * 60000;
  const p = parts(new Date(minute), timeZone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - minute;
};

/**
 * The instant a household wall time happens: `minutes` after local midnight
 * of `day`. Offsets run from -12 h to +14 h, so the instant lies within
 * [-14 h, +12 h] of the wall time read as UTC; the offsets just outside that
 * window are the ones on both sides of any transition the time can touch.
 * A time that happens twice (fall back) is the first one; a time that never
 * happens (spring forward) moves forward by the gap.
 * @param {string} day Day string.
 * @param {number} minutes Minutes after local midnight.
 * @param {string} timeZone IANA timezone.
 * @return {number} Epoch milliseconds.
 */
export const zonedWallInstant = (
  day: string, minutes: number, timeZone: string,
): number => {
  const guess = toUtcDate(day).getTime() + minutes * 60000;
  const before = offsetAt(guess - 15 * HOUR_MS, timeZone);
  const after = offsetAt(guess + 13 * HOUR_MS, timeZone);
  const candidates = [guess - before, guess - after];
  const valid = candidates.filter((at) => offsetAt(at, timeZone) ===
    guess - at);
  // In a gap neither reads the wanted time; the offset from before the
  // transition places it the gap's length later.
  return valid.length > 0 ? Math.min(...valid) : guess - before;
};

/**
 * The UTC instant of local midnight for a day in a timezone, as ISO: the
 * day's first instant (a midnight inside a gap moves forward).
 * @param {string} day Day string.
 * @param {string} timeZone IANA timezone.
 * @return {string} ISO timestamp.
 */
export const zonedMidnightIso = (day: string, timeZone: string): string =>
  new Date(zonedWallInstant(day, 0, timeZone)).toISOString();

/**
 * Parses "HH:MM" into minutes after midnight.
 * @param {unknown} value Time string.
 * @return {number | null} Minutes, or null when invalid.
 */
export const parseTimeOfDay = (value: unknown): number | null => {
  if (typeof value !== "string") return null;
  const match = value.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
};
