// The one overdue-chores notification per person. Pure (no Firebase imports):
// the upkeep function reads the stored document, asks `decideOverdue` what to
// do, and writes the result in a transaction (functions/src/overdue-chores.ts).
//
// Contract:
// - one document per person, `${uid}-overdue`, updated in place every day;
// - a push only when the person's set of overdue chores gains a chore they
//   have not been told about, at most once per local day, and never when the
//   person's daily chore reminder carries the overdue count instead;
// - resolved when nothing is overdue, reopened (same document) when
//   something is overdue again.
import {addDays} from "./calendar";

/** `sourceId` of the stable overdue notification. */
export const OVERDUE_SOURCE_ID = "overdue";
/**
 * Most overdue chores the document lists (newest due day first). Older ones
 * beyond it still count in the message; only their IDs are not stored.
 */
export const OVERDUE_LIST_CAP = 500;
/**
 * Most IDs remembered of chores that left the list (told about, no longer
 * overdue); the oldest are dropped first. Listed chores are always kept.
 */
export const NOTIFIED_HISTORY_CAP = 200;
/** Days of the dated `overdue-YYYY-MM-DD` documents swept (7-day TTL + 1). */
export const LEGACY_OVERDUE_LOOKBACK_DAYS = 8;

/**
 * The stable overdue notification's document ID for one person.
 * @param {string} uid Recipient uid.
 * @return {string} Document ID.
 */
export const overdueNotificationId = (uid: string): string =>
  `${uid}-${OVERDUE_SOURCE_ID}`;

/**
 * IDs of the per-day overdue documents earlier versions wrote for this
 * person, from `today` back over the notification lifetime (bounded), most
 * recent first.
 * @param {string} uid Recipient uid.
 * @param {string} today Person's local day ("YYYY-MM-DD").
 * @return {string[]} Document IDs to remove if present.
 */
export const legacyOverdueNotificationIds = (
  uid: string,
  today: string,
): string[] => Array.from({length: LEGACY_OVERDUE_LOOKBACK_DAYS + 1},
  (_, back) => `${uid}-${OVERDUE_SOURCE_ID}-${addDays(today, -back)}`);

/** What the stored document says (null when it does not exist). */
export type StoredOverdue = {
  resolved: boolean;
  /** Chores the document currently lists. */
  overdueChoreIds: string[];
  /**
   * Chores the person has been told about (bell or push): the listed ones
   * plus, oldest first, up to NOTIFIED_HISTORY_CAP that left the list.
   */
  notifiedChoreIds: string[];
  /** Local day of the last push, or of the daily reminder that carried it. */
  lastPushDay: string | null;
  /** Close enough to `expiresAt` that it must be re-dated to stay listed. */
  nearExpiry: boolean;
  /**
   * The document's last write was visible to this run's source reads
   * (`shouldReopen` in reminders.ts). A later write came from a newer run
   * or from the person, so this run leaves the document alone.
   */
  seenByRun: boolean;
  /** Overdue chores counted in the message (null on older documents). */
  total: number | null;
  /**
   * When the list was capped: the due day of its oldest listed chore. Chores
   * due on or before it may have been counted without being listed.
   */
  overflowFrom: string | null;
};

/**
 * The state a dated overdue document from an earlier version stands for:
 * on its day the person was pushed about every chore overdue that day, that
 * is due before it.
 * @param {string} legacyDay The dated document's day.
 * @param {Array} overdue The person's overdue chores now, with due days.
 * @return {StoredOverdue} Equivalent stored state.
 */
export const legacyOverdueState = (
  legacyDay: string,
  overdue: Array<{id: string; day: string}>,
): StoredOverdue => {
  const told = overdue.filter((c) => c.day < legacyDay).map((c) => c.id)
    .sort();
  return {
    resolved: false, overdueChoreIds: told, notifiedChoreIds: told,
    lastPushDay: legacyDay, nearExpiry: false, seenByRun: true,
    total: null, overflowFrom: null,
  };
};

export type OverdueInput = {
  stored: StoredOverdue | null;
  /**
   * When there is no stored document: the person's most recent dated
   * document from an earlier version (`legacyOverdueState`), whose push and
   * read state the new document takes over.
   */
  legacy?: StoredOverdue | null;
  /**
   * IDs of the person's incomplete chores due before their local today,
   * newest due day first (the order decides which are listed past the cap).
   */
  overdueIds: string[];
  /**
   * IDs of every chore document that still exists in the household
   * (completed or not). Told-about IDs of chores that are gone (deleted, or
   * purged 90 days after completion) are forgotten; others are kept, so an
   * undone completion is not news.
   */
  existingChoreIds: ReadonlySet<string>;
  /** Person's local day. */
  today: string;
  /** After the morning threshold (no new alerts at night). */
  alertsAllowed: boolean;
  /**
   * Today's daily reminder was created in this run. It stated the overdue
   * count, so it told the person about every listed chore (at any hour) and
   * is today's push.
   */
  reminderSentNow: boolean;
  /** Today's daily reminder is still to come and will carry the count. */
  reminderPending: boolean;
  /** Due day of each overdue chore (decides news past the list cap). */
  overdueDays?: ReadonlyMap<string, string>;
};

export type OverdueDecision =
  {action: "none"} |
  {action: "resolve"} |
  {
    action: "write";
    /** The document does not exist yet. */
    create: boolean;
    /** Created from a dated document: take over its read/dismissed state. */
    fromLegacy: boolean;
    /** The document is resolved and becomes active again. */
    reopen: boolean;
    /** Chores to list, sorted (at most OVERDUE_LIST_CAP). */
    choreIds: string[];
    /** Overdue chores in the message (may exceed the listed ones). */
    total: number;
    /** Due day of the oldest listed chore when the list is capped. */
    overflowFrom: string | null;
    notifiedChoreIds: string[];
    lastPushDay: string | null;
    /** Send a push now. */
    push: boolean;
    /**
     * A chore the person was not told about joined: the notification is new
     * to them again (unread, undismissed, dated now).
     */
    fresh: boolean;
    /** Re-date without other news (before expiry, or on a reopen). */
    redate: boolean;
  };

const sameIds = (left: string[], right: string[]) =>
  left.length === right.length &&
  left.every((id, index) => id === right[index]);

/**
 * What to do with one person's overdue notification in this run.
 * @param {OverdueInput} input Stored state and the run's view.
 * @return {OverdueDecision} The change to write, if any.
 */
export const decideOverdue = (input: OverdueInput): OverdueDecision => {
  const {stored, today} = input;
  if (stored && !stored.seenByRun) return {action: "none"};
  const base = stored ?? input.legacy ?? null;
  const open = base !== null && !base.resolved;
  // Before the morning threshold nothing new is announced (the list may
  // only shrink), unless the daily reminder just announced it.
  const known = new Set(open ? base.overdueChoreIds : []);
  const announce = input.alertsAllowed || input.reminderSentNow;
  const dayOf = (id: string) => input.overdueDays?.get(id);
  // Counted earlier without being listed (past the cap): not new.
  const unlisted = (id: string) => {
    const day = dayOf(id);
    return Boolean(open && base.overflowFrom && day !== undefined &&
      day <= base.overflowFrom);
  };
  const all = [...new Set(input.overdueIds)]
    .filter((id) => announce || known.has(id) || unlisted(id));
  const capped = all.slice(0, OVERDUE_LIST_CAP);
  const current = [...capped].sort();
  // Callers list newest due day first, so the last listed is the oldest.
  const overflowFrom = all.length > OVERDUE_LIST_CAP ?
    dayOf(capped[capped.length - 1]) ?? null : null;
  if (current.length === 0) {
    return stored && open ? {action: "resolve"} : {action: "none"};
  }
  const listed = new Set(current);
  // Everything the person was told about stays told about while the chore
  // exists, even after it left the list. A chore is new only under a new ID:
  // each recurring occurrence has its own (template, room, day, assignee).
  const kept = (base?.notifiedChoreIds ?? [])
    .filter((id) => input.existingChoreIds.has(id));
  const notified = new Set([...kept, ...(open ? base.overdueChoreIds : [])]);
  // A chore past the cap is counted, never listed, so never news on its own
  // (a newly overdue chore is due most recently and always listed). One
  // that moves into the list later was counted before: due on or before the
  // stored boundary, so not news either.
  const isNew = (id: string) => {
    if (notified.has(id)) return false;
    const day = dayOf(id);
    return !(base?.overflowFrom && day !== undefined &&
      day <= base.overflowFrom);
  };
  const fresh = current.some(isNew);
  // Listed chores are always remembered; only the history is bounded.
  const history = kept.filter((id) => !listed.has(id))
    .slice(-NOTIFIED_HISTORY_CAP);
  const remembered = [...history, ...current];
  const pushedToday = base?.lastPushDay === today;
  const push = fresh && !pushedToday && !input.reminderSentNow &&
    !input.reminderPending;
  // The person is told today by this push, an earlier push today, or
  // today's daily reminder (sent now or still to come).
  const lastPushDay = fresh || input.reminderSentNow ?
    today : base?.lastPushDay ?? null;
  const reopen = stored !== null && stored.resolved;
  const changed = stored === null || !open ||
    !sameIds(current, stored.overdueChoreIds) ||
    !sameIds(remembered, stored.notifiedChoreIds) ||
    lastPushDay !== stored.lastPushDay ||
    all.length !== stored.total || overflowFrom !== stored.overflowFrom;
  const redate = reopen || Boolean(stored?.nearExpiry);
  if (!fresh && !changed && !redate) return {action: "none"};
  return {
    action: "write",
    create: stored === null,
    fromLegacy: stored === null && Boolean(input.legacy),
    reopen,
    choreIds: current,
    total: all.length,
    overflowFrom,
    notifiedChoreIds: remembered,
    lastPushDay,
    push,
    fresh,
    redate,
  };
};
