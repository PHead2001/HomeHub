// Writes one person's overdue-chores notification (`${uid}-overdue`) from the
// pure decision in ./shared/overdue-notification. Called by the upkeep step
// in ./reminders.ts once per reachable member and run.
import type {
  DocumentReference, DocumentSnapshot, Firestore,
  Timestamp as FirestoreTimestamp,
} from "firebase-admin/firestore";
import {
  decideOverdue, legacyOverdueNotificationIds, legacyOverdueState,
  OVERDUE_SOURCE_ID, overdueNotificationId, type OverdueDecision,
  type StoredOverdue,
} from "./shared/overdue-notification";
import {overdueMessage, type OverdueView} from "./shared/chore-reminders";
import {notificationAudience} from "./shared/notification-audience";

type Timestamp = FirestoreTimestamp;

export type OverdueContext = {
  db: Firestore;
  house: DocumentReference;
  now: Date;
  ts: (d: Date) => Timestamp;
  /** A new notification document for these fields (reminders.ts). */
  newBody: (fields: Record<string, unknown>) => Record<string, unknown>;
  /** `expiresAt` for a document dated now. */
  freshExpiry: () => Timestamp;
  /** Whether an `expiresAt` is close enough to need re-dating. */
  nearExpiry: (expiresAt: Timestamp | undefined) => boolean;
  /** Whether a document's last write was visible to the run's reads. */
  seenByRun: (updateTime: Timestamp | undefined) => boolean;
};

export type OverdueResult =
  "stopped" | "created" | "updated" | "reopened" | "resolved" | "unchanged";

const ids = (value: unknown): string[] => Array.isArray(value) ?
  value.filter((id): id is string => typeof id === "string") : [];

const entryOf = (map: unknown, uid: string): Record<string, unknown> =>
  map && typeof map === "object" && uid in map ?
    {[uid]: (map as Record<string, unknown>)[uid]} : {};

const storedState = (
  ctx: OverdueContext,
  snap: DocumentSnapshot,
): StoredOverdue | null => snap.exists ? {
  resolved: Boolean(snap.get("resolvedAt")),
  overdueChoreIds: ids(snap.get("overdueChoreIds")),
  notifiedChoreIds: ids(snap.get("notifiedChoreIds")),
  lastPushDay: typeof snap.get("lastPushDay") === "string" ?
    snap.get("lastPushDay") : null,
  nearExpiry: ctx.nearExpiry(snap.get("expiresAt") as Timestamp | undefined),
  seenByRun: ctx.seenByRun(snap.updateTime as Timestamp | undefined),
} : null;

export type OverdueRunInput = {
  /** Today's daily reminder was created in this run. */
  reminderSentNow: boolean;
  /** Today's daily reminder is still to come. */
  reminderPending: boolean;
  /** Look for dated documents even if nothing else is written. */
  sweepLegacy: boolean;
  /** Every chore ID in the household. */
  existingChoreIds: ReadonlySet<string>;
};

const LEGACY_DAY = /-(\d{4}-\d{2}-\d{2})$/;

/**
 * Brings one person's overdue notification up to date: creates, updates in
 * place, resolves or reopens it, and removes the person's dated overdue
 * documents written by earlier versions (when it writes, and in the first
 * hour of the person's day). A new document takes over the most recent dated
 * one's push coverage and the person's read and dismissed entries.
 * @param {OverdueContext} ctx Run context.
 * @param {string} uid Recipient uid.
 * @param {OverdueView} view The person's overdue chores and timing.
 * @param {OverdueRunInput} run Daily reminder state, sweep and chore IDs.
 * @return {Promise<OverdueResult>} What was written.
 */
export const syncOverdueNotification = async (
  ctx: OverdueContext,
  uid: string,
  view: OverdueView,
  run: OverdueRunInput,
): Promise<OverdueResult> => {
  const {db, house, now, ts} = ctx;
  const ref = house.collection("notifications").doc(overdueNotificationId(uid));
  const tasks = new Map(view.chores.map((c) => [c.id, c.task]));
  const decide = (
    snap: DocumentSnapshot,
    legacy: StoredOverdue | null = null,
  ): OverdueDecision => decideOverdue({
    stored: storedState(ctx, snap),
    legacy,
    overdueIds: view.chores.map((c) => c.id),
    today: view.today,
    alertsAllowed: view.alertsAllowed,
    reminderSentNow: run.reminderSentNow,
    reminderPending: run.reminderPending,
    existingChoreIds: run.existingChoreIds,
  });
  // A plain read first: most runs change nothing and need no transaction.
  if (decide(await ref.get()).action === "none" && !run.sweepLegacy) {
    return "unchanged";
  }
  const legacyRefs = legacyOverdueNotificationIds(uid, view.today)
    .map((id) => house.collection("notifications").doc(id));
  return db.runTransaction(async (tx) => {
    const [home, snap, ...legacy] =
      await tx.getAll(house, ref, ...legacyRefs);
    if (!home.exists || home.get("deletingAt")) return "stopped";
    // Dated documents of this person only (the ID embeds the uid; the
    // fields are checked too), so the bell never lists them beside this one.
    const mine = legacy.filter((old) => old.exists &&
      old.get("sourceType") === "chore-reminder" &&
      old.get("targetUserUid") === uid);
    for (const old of mine) tx.delete(old.ref);
    // Most recent first (legacyOverdueNotificationIds order): its day's push
    // covered every chore overdue then; earlier ones add nothing.
    const latest = mine[0];
    const latestDay = latest?.id.match(LEGACY_DAY)?.[1];
    const legacyState = !snap.exists && latestDay ?
      legacyOverdueState(latestDay, view.chores) : null;
    const decision = decide(snap, legacyState);
    if (decision.action === "none") return "unchanged";
    if (decision.action === "resolve") {
      tx.update(ref, {resolvedAt: ts(now), overdueChoreIds: []});
      return "resolved";
    }
    const fields: Record<string, unknown> = {
      category: "chores",
      title: "Overdue chores",
      message: overdueMessage(decision.choreIds.map((id) =>
        tasks.get(id) ?? "A chore"), decision.total),
      deepLink: "/chores?due=overdue",
      sourceType: "chore-reminder",
      sourceId: OVERDUE_SOURCE_ID,
      targetUserUid: uid,
      overdueChoreIds: decision.choreIds,
      notifiedChoreIds: decision.notifiedChoreIds,
      lastPushDay: decision.lastPushDay,
    };
    if (decision.create) {
      // Taken over from the dated document unless there is news: the
      // person's own read and dismissed entries.
      const carried = decision.fromLegacy && !decision.fresh && latest ? {
        readBy: entryOf(latest.get("readBy"), uid),
        dismissedBy: entryOf(latest.get("dismissedBy"), uid),
      } : {};
      // The push trigger sends on creation unless `silent` (the daily
      // reminder, an earlier push today or a dated alert told the person).
      tx.set(ref, {...ctx.newBody(fields), ...carried, ...(decision.push ?
        {} : {silent: true})});
      return "created";
    }
    tx.update(ref, {
      ...fields,
      // Same derivation as creation (a uid target).
      audience: notificationAudience(fields),
      ...(decision.reopen ? {resolvedAt: null, resolvedBy: null} : {}),
      // New to the person again: unread, undismissed, listed as new. Only
      // the target can see this document, so their entries are the maps.
      ...(decision.fresh ? {readBy: {}, dismissedBy: {}} : {}),
      ...(decision.fresh || decision.redate ? {
        createdAt: ts(now), expiresAt: ctx.freshExpiry(),
      } : {}),
      // An update sends no push by itself; the update trigger sends one when
      // this field changes.
      ...(decision.push ? {renotifyAt: ts(now)} : {}),
    });
    return decision.reopen ? "reopened" : "updated";
  });
};
