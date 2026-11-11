// Writes one person's overdue-chores notification (`${uid}-overdue`) from the
// pure decision in ./shared/overdue-notification. Called by the upkeep step
// in ./reminders.ts once per reachable member and run.
import type {
  DocumentReference, DocumentSnapshot, Firestore,
  Timestamp as FirestoreTimestamp,
} from "firebase-admin/firestore";
import {
  decideOverdue, legacyOverdueNotificationIds, OVERDUE_SOURCE_ID,
  overdueNotificationId, type OverdueDecision, type StoredOverdue,
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

/**
 * Brings one person's overdue notification up to date: creates, updates in
 * place, resolves or reopens it, and removes the person's dated overdue
 * documents written by earlier versions (when it writes, and in the first
 * hour of the person's day).
 * @param {OverdueContext} ctx Run context.
 * @param {string} uid Recipient uid.
 * @param {OverdueView} view The person's overdue chores and timing.
 * @param {boolean} dailyReminderCovers Today's daily reminder carries it.
 * @param {boolean} sweepLegacy Look for dated documents even if unchanged.
 * @param {ReadonlySet<string>} existingChoreIds Every chore ID in the house.
 * @return {Promise<OverdueResult>} What was written.
 */
export const syncOverdueNotification = async (
  ctx: OverdueContext,
  uid: string,
  view: OverdueView,
  dailyReminderCovers: boolean,
  sweepLegacy: boolean,
  existingChoreIds: ReadonlySet<string>,
): Promise<OverdueResult> => {
  const {db, house, now, ts} = ctx;
  const ref = house.collection("notifications").doc(overdueNotificationId(uid));
  const tasks = new Map(view.chores.map((c) => [c.id, c.task]));
  const decide = (snap: DocumentSnapshot): OverdueDecision => decideOverdue({
    stored: storedState(ctx, snap),
    overdueIds: view.chores.map((c) => c.id),
    today: view.today,
    alertsAllowed: view.alertsAllowed,
    dailyReminderCovers,
    existingChoreIds,
  });
  // A plain read first: most runs change nothing and need no transaction.
  if (decide(await ref.get()).action === "none" && !sweepLegacy) {
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
    for (const old of legacy) {
      if (old.exists && old.get("sourceType") === "chore-reminder" &&
          old.get("targetUserUid") === uid) {
        tx.delete(old.ref);
      }
    }
    const decision = decide(snap);
    if (decision.action === "none") return "unchanged";
    if (decision.action === "resolve") {
      tx.update(ref, {resolvedAt: ts(now), overdueChoreIds: []});
      return "resolved";
    }
    const fields: Record<string, unknown> = {
      category: "chores",
      title: "Overdue chores",
      message: overdueMessage(decision.choreIds.map((id) =>
        tasks.get(id) ?? "A chore")),
      deepLink: "/chores?due=overdue",
      sourceType: "chore-reminder",
      sourceId: OVERDUE_SOURCE_ID,
      targetUserUid: uid,
      overdueChoreIds: decision.choreIds,
      notifiedChoreIds: decision.notifiedChoreIds,
      lastPushDay: decision.lastPushDay,
    };
    if (decision.create) {
      // The push trigger sends on creation unless `silent` (the daily
      // reminder or an earlier push today already told the person).
      tx.set(ref, {...ctx.newBody(fields), ...(decision.push ? {} : {
        silent: true,
      })});
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
