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
 * Most chore IDs kept in `notifiedChoreIds`; the oldest are dropped first.
 */
export const NOTIFIED_CHORE_IDS_CAP = 200;
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
 * person, from `today` back over the notification lifetime (bounded).
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
  /** Chores the person has been told about (bell or push), oldest first. */
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
};

export type OverdueInput = {
  stored: StoredOverdue | null;
  /** IDs of the person's incomplete chores due before their local today. */
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
   * The person's daily chore reminder for today is sent in this run or is
   * still to come today; it states the overdue count, so no separate push.
   */
  dailyReminderCovers: boolean;
};

export type OverdueDecision =
  {action: "none"} |
  {action: "resolve"} |
  {
    action: "write";
    /** The document does not exist yet. */
    create: boolean;
    /** The document is resolved and becomes active again. */
    reopen: boolean;
    /** Chores to list, sorted. */
    choreIds: string[];
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
  const open = stored !== null && !stored.resolved;
  if (stored && !stored.seenByRun) return {action: "none"};
  // Before the morning threshold nothing new is announced: the list may only
  // shrink (completed chores leave it) until alerts are allowed.
  const known = new Set(open ? stored.overdueChoreIds : []);
  const current = [...new Set(input.overdueIds)].sort()
    .filter((id) => input.alertsAllowed || known.has(id));
  if (current.length === 0) {
    return open ? {action: "resolve"} : {action: "none"};
  }
  // Everything the person was told about stays told about while the chore
  // exists, even after it left the list. A chore is new only under a new ID:
  // each recurring occurrence has its own (template, room, day, assignee).
  const kept = (stored?.notifiedChoreIds ?? [])
    .filter((id) => input.existingChoreIds.has(id));
  const notified = new Set(kept);
  const told = [...kept, ...current.filter((id) => !notified.has(id))]
    .slice(-NOTIFIED_CHORE_IDS_CAP);
  const fresh = current.some((id) => !notified.has(id));
  const pushedToday = stored?.lastPushDay === today;
  const push = fresh && !pushedToday && !input.dailyReminderCovers;
  const reopen = stored !== null && stored.resolved;
  const changed = !open || !sameIds(current, stored.overdueChoreIds);
  const redate = reopen || Boolean(stored?.nearExpiry);
  if (!fresh && !changed && !redate) return {action: "none"};
  return {
    action: "write",
    create: stored === null,
    reopen,
    choreIds: current,
    // Grows by the newly told chores (bounded: existing chores only, at most
    // NOTIFIED_CHORE_IDS_CAP, oldest dropped first), so a chore they already
    // heard about never notifies twice.
    notifiedChoreIds: fresh ? told : kept,
    // When fresh, the person is told today: by this push, by an earlier push
    // today, or by today's daily reminder.
    lastPushDay: fresh ? today : stored?.lastPushDay ?? null,
    push,
    fresh,
    redate,
  };
};
