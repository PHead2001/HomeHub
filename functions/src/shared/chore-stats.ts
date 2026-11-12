// Yearly chore totals that survive the 90-day retention of completed chores.
// When upkeep deletes an old completed chore it adds it here first, in the
// same transaction, so Home Wrapped can still count the whole year. Pure.
import {localDay} from "./calendar";
import {choreStatsAssigneeKey, choreStatsMemberKey} from "./ids";
import {choreCompletionInstant, type CompletionFields} from "./completion";

export type ChoreStatsDoc = {
  year: number;
  completed: number;
  /** Purged completions per assignee key (see choreStatsAssigneeKey). */
  byAssignee: Record<string, number>;
  /** Display name per assignee key, for labels only. */
  names: Record<string, string>;
  /**
   * For people who have left: their uid -> the stats key their completions
   * were counted under while they were members (`choreStatsAssigneeKey` of
   * their email), written by the departure (leave or removal). No email.
   * Present only when the document has one.
   */
  aliases?: Record<string, string>;
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
 * member. When no email is known for the uid (the person has left), the uid
 * itself is returned with an empty email, and the stats key it under
 * `choreStatsMemberKey(uid)` (`creditedStatsKey`), so the credit is kept.
 * @param {PurgedChore} chore Chore fields.
 * @param {CreditPerson[]} people Household members (emails where known).
 * @return {{email: string, uid: string, name: unknown} | null} Credited
 *   person (email, else uid), or null when the chore names nobody.
 */
export const creditedPerson = (
  chore: Omit<PurgedChore, "completedAt">,
  people: readonly CreditPerson[] = [],
): {email: string; uid: string; name: unknown} | null => {
  const emailOf = (uid: unknown): string => {
    if (!filled(uid)) return "";
    const email = people.find((person) => person.uid === uid)?.email;
    return filled(email) ? email : "";
  };
  if (filled(chore.completedByEmail)) {
    return {email: chore.completedByEmail, uid: "",
      name: chore.completedByName};
  }
  if (filled(chore.completedByUid)) {
    return {email: emailOf(chore.completedByUid),
      uid: chore.completedByUid.trim(), name: chore.completedByName};
  }
  if (filled(chore.assignedToEmail)) {
    return {email: chore.assignedToEmail, uid: "",
      name: chore.assignedToDisplayName};
  }
  if (!filled(chore.assignedToUid)) return null;
  return {email: emailOf(chore.assignedToUid),
    uid: chore.assignedToUid.trim(), name: chore.assignedToDisplayName};
};

/**
 * The yearly stats key of a credited person: their email-derived key, or,
 * when no email is known for their uid (someone who has left: their
 * membership and contact documents are gone), the key their departure
 * recorded as an alias (the one they were counted under while a member),
 * else their uid key, so the credit is kept in one bucket rather than dropped.
 * @param {{email: string, uid: string}} person From creditedPerson.
 * @param {Record<string, string>} aliases The stats document's `aliases`
 *   (uid of someone who left -> the key they were counted under).
 * @return {string} The key.
 */
export const creditedStatsKey = (
  person: {email: string; uid: string},
  aliases: Readonly<Record<string, string>> = {},
): string => person.email ? choreStatsAssigneeKey(person.email) :
  aliases[person.uid] || choreStatsMemberKey(person.uid);

/**
 * Moves any `uid-<uid>` bucket of a person with an alias into the aliased
 * key (counts added, an existing label kept), so a departed person has one
 * score whatever order their completions were counted in.
 * @param {ChoreStatsDoc} stats Stats as read.
 * @return {ChoreStatsDoc} Stats with aliased uid buckets folded.
 */
export const foldAliasedUidKeys = (stats: ChoreStatsDoc): ChoreStatsDoc => {
  const aliases = stats.aliases ?? {};
  if (Object.keys(aliases).length === 0) return stats;
  const byAssignee = {...stats.byAssignee};
  const names = {...stats.names};
  for (const [uid, key] of Object.entries(aliases)) {
    const uidKey = choreStatsMemberKey(uid);
    if (uidKey === key) continue;
    if (uidKey in byAssignee) {
      byAssignee[key] = (byAssignee[key] ?? 0) + byAssignee[uidKey];
      delete byAssignee[uidKey];
    }
    if (uidKey in names) {
      if (!(key in names)) names[key] = names[uidKey];
      delete names[uidKey];
    }
  }
  return {...stats, byAssignee, names};
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
  const aliases = strings(raw.aliases);
  return {
    year,
    completed: typeof raw.completed === "number" && raw.completed > 0 ?
      raw.completed : 0,
    byAssignee: numbers(raw.byAssignee),
    names: strings(raw.names),
    ...(Object.keys(aliases).length > 0 ? {aliases} : {}),
  };
};

/**
 * Adds purged chores to a year's stats. Each counts for its completer, else
 * its assignee (`creditedPerson`).
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
  const folded = foldAliasedUidKeys(stats);
  const byAssignee = {...folded.byAssignee};
  const names = {...folded.names};
  for (const chore of chores) {
    const person = creditedPerson(chore, people);
    if (!person) continue;
    const key = creditedStatsKey(person, stats.aliases);
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
    ...(stats.aliases ? {aliases: stats.aliases} : {}),
  };
};
