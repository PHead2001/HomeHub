// Missed days of repeating chores (audit CH-7). The stated rule:
//
// A day of a repeating chore that nobody completed stays in To Do (folded into
// its series' "+N earlier missed") for MISSED_EXPIRY_DAYS after its day. After
// that, upkeep removes it and records it in `stats/missed-recent`, so the work
// that was not done stays visible ("3 missed in the last 2 weeks", with who and
// what) without blocking "House is clean" or growing the chores collection
// forever. Only generated days of a repeating chore expire: a one-time chore
// stays until someone completes or deletes it. Shared by the web app and
// Cloud Functions.

import {addDays, isDayString, toDay} from "./calendar";

/** Days a missed repeating day stays in To Do before upkeep expires it. */
export const MISSED_EXPIRY_DAYS = 7;
/** Days of missed entries `stats/missed-recent` keeps. */
export const MISSED_KEEP_DAYS = 28;
/** Most entries kept (latest days first). */
export const MAX_MISSED_ENTRIES = 300;
/** Days the page's summary counts ("missed in the last 2 weeks"). */
export const MISSED_SUMMARY_DAYS = 14;
export const MISSED_DOC_ID = "missed-recent";

export type MissedEntry = {
  /** Occurrence key ("templateId|roomId|day"); one entry per key. */
  key: string;
  task: string;
  day: string;
  assignedToUid: string | null;
  assignedToDisplayName: string | null;
};

/**
 * Whether an open chore's occurrence day is past the expiry window.
 * @param {string} occurrenceDay Day of the occurrence.
 * @param {string} today Household day.
 * @return {boolean} Expired.
 */
export const missedDayExpired = (
  occurrenceDay: string, today: string,
): boolean => occurrenceDay < addDays(today, -MISSED_EXPIRY_DAYS);

/**
 * The day a chore is due now: its `originalDueDate` (a move updates it), else
 * its `dueDate` read in the household's timezone.
 * @param {object} chore Stored chore fields.
 * @param {string} timeZone Household timezone.
 * @return {string | null} Day, or null when it has none.
 */
export const effectiveDueDay = (
  chore: {originalDueDate?: unknown; dueDate?: unknown},
  timeZone: string,
): string | null =>
  isDayString(chore.originalDueDate) ?
    chore.originalDueDate : toDay(chore.dueDate, timeZone);

/**
 * Stored entries, read defensively.
 * @param {unknown} data Stored document data.
 * @return {MissedEntry[]} Entries.
 */
export const readMissedEntries = (data: unknown): MissedEntry[] => {
  const list = (data as {entries?: unknown} | null | undefined)?.entries;
  if (!Array.isArray(list)) return [];
  return list.flatMap((item): MissedEntry[] => {
    if (!item || typeof item !== "object") return [];
    const e = item as Record<string, unknown>;
    if (typeof e.key !== "string" || !isDayString(e.day)) return [];
    return [{
      key: e.key,
      task: typeof e.task === "string" ? e.task : "Chore",
      day: e.day,
      assignedToUid: typeof e.assignedToUid === "string" ?
        e.assignedToUid : null,
      assignedToDisplayName: typeof e.assignedToDisplayName === "string" ?
        e.assignedToDisplayName : null,
    }];
  });
};

/**
 * Entries after adding `add`: one per key, only the last MISSED_KEEP_DAYS,
 * latest day first, at most MAX_MISSED_ENTRIES.
 * @param {MissedEntry[]} existing Stored entries.
 * @param {MissedEntry[]} add New entries.
 * @param {string} today Household day.
 * @return {MissedEntry[]} Entries to store.
 */
export const withMissedEntries = (
  existing: readonly MissedEntry[],
  add: readonly MissedEntry[],
  today: string,
): MissedEntry[] => {
  const byKey = new Map<string, MissedEntry>();
  for (const entry of [...existing, ...add]) byKey.set(entry.key, entry);
  const from = addDays(today, -MISSED_KEEP_DAYS);
  return [...byKey.values()]
    .filter((entry) => entry.day >= from)
    .sort((a, b) => b.day.localeCompare(a.day) || a.key.localeCompare(b.key))
    .slice(0, MAX_MISSED_ENTRIES);
};

/**
 * Entries whose day falls in the last MISSED_SUMMARY_DAYS.
 * @param {MissedEntry[]} entries Stored entries.
 * @param {string} today Household day.
 * @return {MissedEntry[]} Recent entries, latest first.
 */
export const recentMissed = (
  entries: readonly MissedEntry[], today: string,
): MissedEntry[] => {
  const from = addDays(today, -MISSED_SUMMARY_DAYS);
  return entries.filter((entry) => entry.day >= from);
};
