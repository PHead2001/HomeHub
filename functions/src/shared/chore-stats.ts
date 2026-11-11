// Yearly chore totals that survive the 90-day retention of completed chores.
// When upkeep deletes an old completed chore it adds it here first, in the
// same transaction, so Home Wrapped can still count the whole year. Pure.
import {localDay} from "./calendar";
import {choreStatsAssigneeKey, choreStatsMemberKey} from "./ids";
import {choreCompletionInstant, type CompletionFields} from "./completion";

export type ChoreStatsDoc = {
  year: number;
  completed: number;
  /**
   * Purged completions per member key (`choreStatsMemberKey(uid)`). Documents
   * written before the move may still hold legacy email-derived keys
   * (`choreStatsAssigneeKey`) until scripts/ops/rekey-chore-stats.mjs runs.
   */
  byAssignee: Record<string, number>;
  /** Display name per assignee key, for labels only. */
  names: Record<string, string>;
};

export type PurgedChore = {
  /** See creditedPerson. */
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

const lower = (value: unknown): string =>
  typeof value === "string" ? value.trim().toLowerCase() : "";

/**
 * A household member for crediting: uid and, where the reader knows it, the
 * email (only to match chores written before uids were stored).
 */
export type CreditPerson = {uid: string; email?: string | null};

/**
 * Who a completed chore counts for, by account ID: the person who completed
 * it when the server recorded them (`completedByUid`; an older
 * `completedByEmail` without a uid is matched through `people`), else its
 * assignee (completions made before attribution existed, or by an older
 * client): an `assignedToEmail` that names one of `people`, else
 * `assignedToUid`, unless a known email of that uid's member contradicts the
 * stored email (an older build reassigned it by email only). Upkeep (with
 * every member's email from their contact document) and Home Wrapped
 * (usually without emails) credit the same uid for every chore stored since
 * the uid was written.
 * @param {PurgedChore} chore Chore fields.
 * @param {CreditPerson[]} people Household members (emails where known).
 * @return {{uid: string, name: unknown} | null} Credited person, or null.
 */
export const creditedPerson = (
  chore: Omit<PurgedChore, "completedAt">,
  people: readonly CreditPerson[] = [],
): {uid: string; name: unknown} | null => {
  const uidOf = (email: unknown): string =>
    people.find((person) => lower(person.email) === lower(email))?.uid ?? "";
  if (filled(chore.completedByUid)) {
    return {uid: chore.completedByUid.trim(), name: chore.completedByName};
  }
  if (filled(chore.completedByEmail)) {
    const uid = uidOf(chore.completedByEmail);
    return uid ? {uid, name: chore.completedByName} : null;
  }
  const name = chore.assignedToDisplayName;
  if (filled(chore.assignedToEmail)) {
    const uid = uidOf(chore.assignedToEmail);
    if (uid) return {uid, name};
  }
  if (!filled(chore.assignedToUid)) return null;
  const uid = chore.assignedToUid.trim();
  const known = lower(people.find((person) => person.uid === uid)?.email);
  if (filled(chore.assignedToEmail) && known &&
    known !== lower(chore.assignedToEmail)) return null;
  return {uid, name};
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
 * Whether crediting a completed chore in the yearly stats may depend on
 * members' emails: it has no `completedByUid` and carries an email
 * (`completedByEmail`, or `assignedToEmail`, which can also overrule a stale
 * `assignedToUid`). Upkeep purges such a chore only when it could read the
 * members' contact documents; otherwise the credit would be lost with it.
 * @param {object} chore Chore fields.
 * @return {boolean} True when emails are needed to credit it.
 */
export const purgeNeedsMemberEmails = (
  chore: Omit<PurgedChore, "completedAt">,
): boolean => !filled(chore.completedByUid) &&
  (filled(chore.completedByEmail) || filled(chore.assignedToEmail));

/**
 * Moves the counts and labels kept under a legacy email-derived key
 * (`choreStatsAssigneeKey(email)`) to the member's uid key, for every person
 * whose email the reader knows. Legacy keys of anyone else are left as they
 * are (scripts/ops/rekey-chore-stats.mjs replaces them).
 * @param {ChoreStatsDoc} stats Stats as read.
 * @param {CreditPerson[]} people Household members (emails where known).
 * @return {ChoreStatsDoc} Stats keyed by uid where possible.
 */
export const foldLegacyStatsKeys = (
  stats: ChoreStatsDoc,
  people: readonly CreditPerson[] = [],
): ChoreStatsDoc => {
  const byAssignee = {...stats.byAssignee};
  const names = {...stats.names};
  for (const person of people) {
    if (!filled(person.email) || !filled(person.uid)) continue;
    const legacy = choreStatsAssigneeKey(person.email);
    const key = choreStatsMemberKey(person.uid);
    if (legacy === key) continue;
    if (legacy in byAssignee) {
      byAssignee[key] = (byAssignee[key] ?? 0) + byAssignee[legacy];
      delete byAssignee[legacy];
    }
    if (legacy in names) {
      if (!(key in names)) names[key] = names[legacy];
      delete names[legacy];
    }
  }
  return {...stats, byAssignee, names};
};

/**
 * Adds purged chores to a year's stats, keyed by uid (`choreStatsMemberKey`).
 * Each counts for its completer, else its assignee (`creditedPerson`). Legacy
 * email-derived keys of the members in `people` are folded into their uid key
 * first (`foldLegacyStatsKeys`).
 * @param {ChoreStatsDoc} stats Current stats.
 * @param {PurgedChore[]} chores Chores being deleted, all in that year.
 * @param {CreditPerson[]} people Household members, to resolve uid-only
 *   completers and assignees (see `creditedPerson`).
 * @return {ChoreStatsDoc} New stats.
 */
export const addPurgedChores = (
  stats: ChoreStatsDoc,
  chores: PurgedChore[],
  people: readonly CreditPerson[] = [],
): ChoreStatsDoc => {
  const folded = foldLegacyStatsKeys(stats, people);
  const byAssignee = {...folded.byAssignee};
  const names = {...folded.names};
  for (const chore of chores) {
    const person = creditedPerson(chore, people);
    if (!person) continue;
    const key = choreStatsMemberKey(person.uid);
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
