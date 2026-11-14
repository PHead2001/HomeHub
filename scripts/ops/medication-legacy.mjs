// Pure classification for report-legacy-medication.mjs (D-P8). No Firebase
// imports. It is the plain-JavaScript twin of `pendingLegacyGroups` in
// functions/src/shared/medication-schedule.ts (these scripts run without a
// TypeScript loader); tests/unit/pets-medication-legacy-ops.test.ts checks
// that both classify the same synthetic histories the same way.

import { localDay, safeTimeZone, toDate } from './feeding-state.mjs';

export const MAX_EVERY_DAYS = 90;

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A real `yyyy-MM-dd` calendar day.
 * @param {unknown} value
 * @returns {value is string}
 */
export function isCalendarDay(value) {
  if (typeof value !== 'string' || !DAY.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

const diffDays = (later, earlier) =>
  Math.round((Date.parse(`${later}T00:00:00Z`) - Date.parse(`${earlier}T00:00:00Z`)) / 86_400_000);

/**
 * A legacy (name-keyed) entry: no course and not a one-off dose.
 * @param {{ courseId?: unknown, oneOff?: unknown }} log
 */
export function isLegacyLog(log) {
  return !(typeof log.courseId === 'string' && log.courseId) && log.oneOff !== true;
}

/** @param {unknown} name */
export function legacyMedicationKey(name) {
  return typeof name === 'string' ? name.trim().toLowerCase() : '';
}

/**
 * Legacy names taken over by a course (its `legacyKeys`).
 * @param {Array<{ legacyKeys?: unknown }>} courses
 * @returns {Set<string>}
 */
export function takenLegacyKeys(courses) {
  return new Set(courses.flatMap(course => (Array.isArray(course.legacyKeys) ? course.legacyKeys.map(legacyMedicationKey).filter(Boolean) : [])));
}

/**
 * Every legacy medication name of one pet, classified:
 * - `taken`: a course took it over (confirmed, merged or finished);
 * - `ended`: its latest entry has no next due date (no countdown, nothing to confirm);
 * - `consistent`: pending, every entry with a next due date gave the same gap (a suggestion is shown);
 * - `conflicting` / `no-interval`: pending and genuinely ambiguous (no suggestion).
 * @param {Array<Record<string, unknown>>} logs every medication entry of the pet
 * @param {Set<string>} taken
 * @param {unknown} timeZone `household.timeZone`
 * @returns {Array<{ key: string, status: 'taken' | 'ended' | 'consistent' | 'conflicting' | 'no-interval', everyDays: number | null }>}
 */
export function classifyLegacyMedication(logs, taken, timeZone) {
  const zone = safeTimeZone(timeZone);
  const groups = new Map();
  for (const log of logs) {
    if (!isLegacyLog(log)) continue;
    const key = legacyMedicationKey(log.medication);
    const date = toDate(log.date);
    if (!key || !date) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ at: date.getTime(), log });
  }
  const out = [];
  for (const [key, list] of groups) {
    if (taken.has(key)) {
      out.push({ key, status: 'taken', everyDays: null });
      continue;
    }
    list.sort((a, b) => a.at - b.at);
    const latest = list[list.length - 1].log;
    if (!isCalendarDay(latest.nextDueDate)) {
      out.push({ key, status: 'ended', everyDays: null });
      continue;
    }
    const gaps = new Set();
    let usable = true;
    for (const { at, log } of list) {
      if (!isCalendarDay(log.nextDueDate)) continue;
      const gap = diffDays(log.nextDueDate, localDay(new Date(at), zone));
      if (gap < 1 || gap > MAX_EVERY_DAYS) usable = false;
      else gaps.add(gap);
    }
    const status = !usable || gaps.size === 0 ? 'no-interval' : gaps.size > 1 ? 'conflicting' : 'consistent';
    out.push({ key, status, everyDays: status === 'consistent' ? [...gaps][0] : null });
  }
  return out.sort((a, b) => a.key.localeCompare(b.key));
}
