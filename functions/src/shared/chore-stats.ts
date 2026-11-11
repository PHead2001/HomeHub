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
  /** Resolved to the member's email through `people` (see creditedPerson). */
  assignedToUid?: unknown;
  assignedToEmail?: unknown;
  assignedToDisplayName?: unknown;
  /** Who completed it (D-7: the completer gets the credit). */
  completedByUid?: unknown;
  completedByEmail?: unknown;
  completedByName?: unknown;
  completedAt: string;
};

const filled = (value: unknown): value is string =>
  typeof value === "string" && value.trim() !== "";

/** A household member for crediting: uid and (where known) email. */
export type CreditPerson = {uid: string; email?: string | null};

/**
 * Who a completed chore counts for: the person who completed it when the
 * server recorded them (`completedByEmail`, else `completedByUid` resolved
 * through `people`), else its assignee (completions made before attribution
 * existed, or by an older client): `assignedToEmail`, else `assignedToUid`
 * resolved through `people`. Since member privacy release C chores carry the
 * uid only, so the uid is resolved to the member's email, keeping the stats
 * key (`choreStatsAssigneeKey(email)`) the same for every shape of the same
 * member until release E rekeys the stats by uid.
 * @param {PurgedChore} chore Chore fields.
 * @param {CreditPerson[]} people Household members (emails where known).
 * @return {{email: string, name: unknown} | null} Credited person, or null.
 */
export const creditedPerson = (
  chore: Omit<PurgedChore, "completedAt">,
  people: readonly CreditPerson[] = [],
): {email: string; name: unknown} | null => {
  const emailOf = (uid: unknown): string => {
    if (!filled(uid)) return "";
    const email = people.find((person) => person.uid === uid)?.email;
    return filled(email) ? email : "";
  };
  if (filled(chore.completedByEmail)) {
    return {email: chore.completedByEmail, name: chore.completedByName};
  }
  const completer = emailOf(chore.completedByUid);
  if (completer) return {email: completer, name: chore.completedByName};
  if (filled(chore.completedByUid)) return null;
  if (filled(chore.assignedToEmail)) {
    return {email: chore.assignedToEmail, name: chore.assignedToDisplayName};
  }
  const assignee = emailOf(chore.assignedToUid);
  return assignee ? {email: assignee, name: chore.assignedToDisplayName} : null;
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
 * Adds purged chores to a year's stats. Each counts for its completer, else
 * its assignee (`creditedPerson`).
 * @param {ChoreStatsDoc} stats Current stats.
 * @param {PurgedChore[]} chores Chores being deleted, all in that year.
 * @return {ChoreStatsDoc} New stats.
 */
export const addPurgedChores = (
  stats: ChoreStatsDoc,
  chores: PurgedChore[],
  people: readonly CreditPerson[] = [],
): ChoreStatsDoc => {
  const byAssignee = {...stats.byAssignee};
  const names = {...stats.names};
  for (const chore of chores) {
    const person = creditedPerson(chore, people);
    if (!person) continue;
    const key = choreStatsAssigneeKey(person.email);
    byAssignee[key] = (byAssignee[key] ?? 0) + 1;
    // Labels only, readable by everyone who sees chores: never the email.
    if (filled(person.name) && !person.name.includes("@")) {
      names[key] = person.name.trim();
    }
  }
  return {
    year: stats.year,
    completed: stats.completed + chores.length,
    byAssignee,
    names,
  };
};
