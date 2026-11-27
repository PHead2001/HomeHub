// When a push may be sent (NO-3, NO-24; audit 16.3). Pure: no Firebase
// imports. Notifications are always written at once (the bell shows them);
// only the push waits:
// - a day-based reminder (`holdUntilMorning`: maintenance and medication
//   reminders whose state changes at local midnight) is not pushed before
//   MORNING_PUSH_MINUTES in the household's zone;
// - a household-wide notice is not pushed during household quiet hours;
// - nothing is pushed to a member during their own quiet hours.
// Every time is in the household's zone (D-6). A held push is recorded on the
// notification (`pushHeld.<uid>`) and sent by hourly upkeep once its time
// has come (functions/src/held-pushes.ts).
import {
  addDays, localDay, localMinutes, parseTimeOfDay, zonedWallInstant,
} from "./calendar";

/** Day-based reminders are not pushed before 07:00 household time. */
export const MORNING_PUSH_MINUTES = 7 * 60;

/** A daily window in the household's zone ("HH:mm"); may cross midnight. */
export type LocalWindow = {start: string; end: string};

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * A stored window, or null when absent or malformed.
 * @param {unknown} value Stored value.
 * @return {LocalWindow | null} The window.
 */
export const readLocalWindow = (value: unknown): LocalWindow | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const {start, end} = value as {start?: unknown; end?: unknown};
  if (typeof start !== "string" || typeof end !== "string" ||
      !TIME.test(start) || !TIME.test(end) || start === end) return null;
  return {start, end};
};

/**
 * Whether `now` falls inside the window (start inside, end not).
 * @param {LocalWindow | null} window The window.
 * @param {string} timeZone Household zone.
 * @param {Date} now Instant.
 * @return {boolean} True inside.
 */
export const inLocalWindow = (
  window: LocalWindow | null, timeZone: string, now: Date,
): boolean => {
  if (!window) return false;
  const start = parseTimeOfDay(window.start);
  const end = parseTimeOfDay(window.end);
  if (start === null || end === null || start === end) return false;
  const minute = localMinutes(now, timeZone);
  return start < end ? minute >= start && minute < end :
    minute >= start || minute < end;
};

/**
 * The next instant at or after `now` when the household's wall clock reads
 * `minutes` after midnight.
 * @param {Date} now Instant.
 * @param {string} timeZone Household zone.
 * @param {number} minutes Minutes after local midnight.
 * @return {Date} That instant.
 */
export const nextLocalTime = (
  now: Date, timeZone: string, minutes: number,
): Date => {
  const today = localDay(now, timeZone);
  const at = zonedWallInstant(today, minutes, timeZone);
  if (at >= now.getTime()) return new Date(at);
  // When clocks go back, a wall time happens twice and zonedWallInstant gives
  // the first; the second (30 or 60 minutes later) may still be ahead today.
  for (const shift of [30, 60]) {
    const again = at + shift * 60000;
    const when = new Date(again);
    if (again >= now.getTime() && localDay(when, timeZone) === today &&
        localMinutes(when, timeZone) === minutes) {
      return new Date(again);
    }
  }
  return new Date(zonedWallInstant(addDays(today, 1), minutes, timeZone));
};

export type HoldInput = {
  now: Date;
  /** Household zone. */
  timeZone: string;
  /** The notification is addressed to the whole household (`['*']`). */
  householdWide: boolean;
  /** A day-based reminder (`holdUntilMorning: true` on the document). */
  morningHold: boolean;
  /** Household quiet hours (`households/{h}.quietHours`). */
  householdQuiet: LocalWindow | null;
  /** The recipient's own quiet hours (NO-24), if any. */
  memberQuiet?: LocalWindow | null;
};

const windowEnd = (w: LocalWindow): number => parseTimeOfDay(w.end) ?? 0;

/**
 * Until when a push to one recipient must wait, or null to send it now.
 * Holds can follow one another (quiet hours ending before the morning
 * hour), so the latest applies; it is re-checked a few times so a hold that
 * ends inside another window waits for that one too.
 * @param {HoldInput} input Time, zone, notification and windows.
 * @return {Date | null} When it may be sent, or null.
 */
export const pushHoldUntil = (input: HoldInput): Date | null => {
  let at = input.now;
  for (let step = 0; step < 4; step++) {
    const holds: Date[] = [];
    if (input.morningHold &&
        localMinutes(at, input.timeZone) < MORNING_PUSH_MINUTES) {
      holds.push(nextLocalTime(at, input.timeZone, MORNING_PUSH_MINUTES));
    }
    if (input.householdWide && input.householdQuiet &&
        inLocalWindow(input.householdQuiet, input.timeZone, at)) {
      holds.push(nextLocalTime(at, input.timeZone,
        windowEnd(input.householdQuiet)));
    }
    if (input.memberQuiet &&
        inLocalWindow(input.memberQuiet, input.timeZone, at)) {
      holds.push(nextLocalTime(at, input.timeZone,
        windowEnd(input.memberQuiet)));
    }
    if (holds.length === 0) break;
    at = new Date(Math.max(...holds.map((d) => d.getTime())));
  }
  return at.getTime() === input.now.getTime() ? null : at;
};

/**
 * How long FCM keeps a push for a device that is off (NO-11): a day-based
 * reminder only until the household's midnight (a phone off for two days
 * never gets yesterday's "due today"), anything else a day. At least an hour.
 * @param {boolean} dayBased The notification has `holdUntilMorning`.
 * @param {Date} now Instant.
 * @param {string} timeZone Household zone.
 * @return {number} Seconds.
 */
export const pushTtlSeconds = (
  dayBased: boolean, now: Date, timeZone: string,
): number => {
  const day = 24 * 60 * 60;
  if (!dayBased) return day;
  const midnight = nextLocalTime(now, timeZone, 24 * 60 - 1).getTime() + 60000;
  return Math.max(60 * 60,
    Math.min(day, Math.round((midnight - now.getTime()) / 1000)));
};

/** What upkeep does with a notification's held pushes. */
export type HeldRelease = {
  /** Send to these now. */
  release: string[];
  /** Still waiting: uid → epoch ms. */
  remaining: Record<string, number>;
  /** Earliest remaining time, or null when none wait. */
  next: number | null;
};

/**
 * Splits held pushes into those due now and those still waiting. Nothing is
 * released for a resolved or expired notification, or to someone who has
 * already read or dismissed it in the bell.
 * @param {Record<string, number>} held uid → epoch ms of the hold.
 * @param {number} now Epoch ms.
 * @param {object} state What the notification says now.
 * @return {HeldRelease} The split.
 */
export const releaseHeld = (
  held: Record<string, number>,
  now: number,
  state: {closed: boolean; seenBy: ReadonlySet<string>},
): HeldRelease => {
  const release: string[] = [];
  const remaining: Record<string, number> = {};
  for (const [uid, at] of Object.entries(held)) {
    if (state.closed || state.seenBy.has(uid)) continue;
    if (at <= now) release.push(uid);
    else remaining[uid] = at;
  }
  const times = Object.values(remaining);
  return {
    release: release.sort(),
    remaining,
    next: times.length > 0 ? Math.min(...times) : null,
  };
};
