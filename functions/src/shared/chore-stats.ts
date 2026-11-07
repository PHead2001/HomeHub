// Yearly chore totals that survive the 90-day retention of completed chores.
// When upkeep deletes an old completed chore it adds it here first, in the
// same transaction, so Home Wrapped can still count the whole year. Pure.
import {localDay} from "./calendar";
import {choreStatsAssigneeKey} from "./ids";
import {choreCompletionInstant, type CompletionFields} from "./completion";

export type ChoreStatsDoc = {
  year: number;
  completed: number;
  /** Purged completions per assignee key (see choreStatsAssigneeKey). */
  byAssignee: Record<string, number>;
  /** Display name per assignee key, for labels only. */
  names: Record<string, string>;
};

export type PurgedChore = {
  assignedToEmail?: unknown;
  assignedToDisplayName?: unknown;
  completedAt: string;
};

/**
 * Stats document id for a calendar year.
 * @param {number} year Calendar year.
 * @return {string} Document id under households/{id}/stats.
 */
export const choreStatsDocId = (year: number): string => `chores-${year}`;

/**
 * Calendar year, in the household's timezone, of a chore's authoritative
 * completion instant (`choreCompletionInstant`: the server stamp when present,
 * else `completedAt`), the same rule the Chores page uses.
 * @param {CompletionFields} chore Chore fields.
 * @param {string} timeZone IANA timezone.
 * @return {number | null} Year, or null when not completed or unreadable.
 */
export const completionYear = (
  chore: CompletionFields,
  timeZone: string,
): number | null => {
  const date = choreCompletionInstant(chore);
  return date ? Number(localDay(date, timeZone).slice(0, 4)) : null;
};

/**
 * Reads a stored stats document defensively.
 * @param {unknown} data Firestore data (or undefined).
 * @param {number} year Year the document is for.
 * @return {ChoreStatsDoc} Normalized stats.
 */
export const readChoreStats = (data: unknown, year: number): ChoreStatsDoc => {
  const raw = (data && typeof data === "object" ? data : {}) as
    Record<string, unknown>;
  const numbers = (value: unknown): Record<string, number> =>
    Object.fromEntries(Object.entries(
      value && typeof value === "object" ? value : {})
      .filter(([, n]) => typeof n === "number" && Number.isFinite(n) && n > 0)
      .map(([key, n]) => [key, n as number]));
  const strings = (value: unknown): Record<string, string> =>
    Object.fromEntries(Object.entries(
      value && typeof value === "object" ? value : {})
      .filter(([, s]) => typeof s === "string")
      .map(([key, s]) => [key, s as string]));
  return {
    year,
    completed: typeof raw.completed === "number" && raw.completed > 0 ?
      raw.completed : 0,
    byAssignee: numbers(raw.byAssignee),
    names: strings(raw.names),
  };
};

/**
 * Adds purged chores to a year's stats.
 * @param {ChoreStatsDoc} stats Current stats.
 * @param {PurgedChore[]} chores Chores being deleted, all in that year.
 * @return {ChoreStatsDoc} New stats.
 */
export const addPurgedChores = (
  stats: ChoreStatsDoc,
  chores: PurgedChore[],
): ChoreStatsDoc => {
  const byAssignee = {...stats.byAssignee};
  const names = {...stats.names};
  for (const chore of chores) {
    if (typeof chore.assignedToEmail !== "string" ||
        !chore.assignedToEmail.trim()) continue;
    const key = choreStatsAssigneeKey(chore.assignedToEmail);
    byAssignee[key] = (byAssignee[key] ?? 0) + 1;
    if (typeof chore.assignedToDisplayName === "string" &&
        chore.assignedToDisplayName.trim()) {
      names[key] = chore.assignedToDisplayName.trim();
    } else if (!names[key]) {
      names[key] = chore.assignedToEmail.trim().toLowerCase();
    }
  }
  return {
    year: stats.year,
    completed: stats.completed + chores.length,
    byAssignee,
    names,
  };
};
