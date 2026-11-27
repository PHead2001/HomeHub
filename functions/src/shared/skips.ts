// Skipped occurrences of repeating chores (audit CH-3, CA-5): deleting one day
// of a repeating chore records that day's occurrence key on its template, and
// server upkeep and the calendar never generate or plan a recorded key again.
// Shared by the web app and Cloud Functions.

/** Most keys a template keeps. Older days are dropped first. */
export const MAX_SKIPPED_OCCURRENCES = 400;

const KEY_DAY = /\|(\d{4}-\d{2}-\d{2})$/;

/**
 * The day ("YYYY-MM-DD") an occurrence key names, or null.
 * @param {string} key Occurrence key ("templateId|roomId|day").
 * @return {string | null} Day.
 */
export const occurrenceKeyDay = (key: string): string | null =>
  KEY_DAY.exec(key)?.[1] ?? null;

/**
 * The skipped occurrence keys a template holds.
 * @param {object} template Stored template fields.
 * @return {Set<string>} Keys.
 */
export const skippedOccurrenceKeys = (
  template: {skippedOccurrences?: unknown} | null | undefined,
): Set<string> => {
  const list = template?.skippedOccurrences;
  return new Set(Array.isArray(list) ?
    list.filter((key): key is string => typeof key === "string") : []);
};

/**
 * A template's skipped keys after adding `add`: days before `today` are
 * dropped (upkeep never generates a past day), duplicates are removed and the
 * list is capped at MAX_SKIPPED_OCCURRENCES, keeping the latest days.
 * @param {unknown} existing Stored `skippedOccurrences`.
 * @param {string[]} add Keys to add.
 * @param {string} today Household day ("YYYY-MM-DD").
 * @return {string[]} Keys to store, sorted by day.
 */
export const withSkippedOccurrences = (
  existing: unknown,
  add: readonly string[],
  today: string,
): string[] => {
  const keys = new Set([
    ...skippedOccurrenceKeys({skippedOccurrences: existing}), ...add,
  ]);
  const kept = [...keys].filter((key) => {
    const day = occurrenceKeyDay(key);
    return day !== null && day >= today;
  });
  kept.sort((a, b) => {
    const byDay = (occurrenceKeyDay(a) ?? "").localeCompare(
      occurrenceKeyDay(b) ?? "");
    return byDay !== 0 ? byDay : a.localeCompare(b);
  });
  return kept.slice(0, MAX_SKIPPED_OCCURRENCES);
};
