// Server-side reminders and recurring chores, run on a schedule so they happen
// whether or not anyone opens the app. Every step is idempotent: notification
// and chore IDs are deterministic, so overlapping or repeated runs are safe.
import type {firestore} from "firebase-admin";
import {
  addDays, localDay, safeTimeZone, zonedMidnightIso,
} from "./shared/calendar";
import {choreNotificationsFor, type ChoreInput} from "./shared/chore-reminders";
import {deterministicNotificationId, recurringChoreId} from "./shared/ids";
import {
  actionableReminders, buildMaintenanceReminders,
  type AssetInput, type VehicleInput,
} from "./shared/maintenance-reminders";
import {normalizeRecurrence, upcomingOccurrences} from "./shared/recurrence";

type Db = firestore.Firestore;
type Timestamp = firestore.Timestamp;

export const NOTIFICATION_TTL_DAYS = 7;
export const COMPLETED_CHORE_RETENTION_DAYS = 90;
export const RECURRING_LOOKAHEAD = 30;
const APPROVED = new Set(["owner", "admin", "member", "child", "guest"]);

export type HouseholdRunResult = {
  householdId: string;
  generatedChores: number;
  purgedChores: number;
  createdNotifications: number;
  refreshedNotifications: number;
};

const notificationBody = (
  householdId: string,
  now: Date,
  ts: (d: Date) => Timestamp,
  fields: Record<string, unknown>,
) => ({
  householdId,
  createdAt: ts(now),
  expiresAt: ts(new Date(now.getTime() + NOTIFICATION_TTL_DAYS * 86400000)),
  readBy: {},
  dismissedBy: {},
  ...fields,
});

/**
 * Runs reminders and recurring-chore upkeep for one household.
 * @param {Db} db Firestore (Admin SDK).
 * @param {string} householdId Household to process.
 * @param {Date} now Current instant.
 * @param {Function} ts Converts a Date to a Firestore Timestamp.
 * @return {Promise<HouseholdRunResult>} What changed.
 */
export const runHouseholdReminders = async (
  db: Db,
  householdId: string,
  now: Date,
  ts: (d: Date) => Timestamp,
): Promise<HouseholdRunResult> => {
  const result: HouseholdRunResult = {
    householdId, generatedChores: 0, purgedChores: 0,
    createdNotifications: 0, refreshedNotifications: 0,
  };
  const house = db.collection("households").doc(householdId);
  const houseSnap = await house.get();
  if (!houseSnap.exists) return result;
  const timeZone = safeTimeZone(houseSnap.get("timeZone"));
  const today = localDay(now, timeZone);

  const [membersSnap, choresSnap, templatesSnap, assetsSnap, vehiclesSnap] =
    await Promise.all([
      house.collection("members").get(),
      house.collection("chores").get(),
      house.collection("chore-templates").get(),
      house.collection("home-assets").get(),
      house.collection("vehicles").get(),
    ]);

  const members = membersSnap.docs.map((d) => ({uid: d.id, ...d.data()}))
    .filter((m: Record<string, unknown>) =>
      APPROVED.has(String(m.role)) &&
      (m.status === undefined || m.status === "active") &&
      typeof m.email === "string") as Array<{
        uid: string; email: string; displayName?: string;
      }>;
  const memberByEmail = new Map(members.map((m) => [m.email, m]));

  // Recurring chores: create the next occurrences that do not exist yet.
  const choreIds = new Set(choresSnap.docs.map((d) => d.id));
  const choreWrites = db.batch();
  let pendingWrites = 0;
  for (const templateDoc of templatesSnap.docs) {
    const template = templateDoc.data();
    const recurrence = normalizeRecurrence(template.recurrence, today);
    const assignee = template.assignedToEmail ||
      template.recurrence?.assignedToEmail;
    if (!recurrence || typeof assignee !== "string") continue;
    // Never generate work for someone who is no longer an approved member.
    const person = memberByEmail.get(assignee);
    if (!person) continue;
    const rooms: string[] = Array.isArray(template.roomIds) &&
      template.roomIds.length > 0 ? template.roomIds : ["general"];
    for (const day of upcomingOccurrences(recurrence, today,
      RECURRING_LOOKAHEAD)) {
      for (const roomId of rooms) {
        const id = recurringChoreId(templateDoc.id, roomId, day, assignee);
        if (choreIds.has(id)) continue;
        choreIds.add(id);
        choreWrites.set(house.collection("chores").doc(id), {
          task: template.task,
          assignedToEmail: assignee,
          assignedToDisplayName: person.displayName || assignee,
          dueDate: zonedMidnightIso(day, timeZone),
          isCompleted: false,
          notes: template.notes || "",
          subTasks: template.subTasks || [],
          completedSubTasks: [],
          templateId: templateDoc.id,
          originalDueDate: day,
          roomIds: roomId === "general" ? [] : [roomId],
        });
        pendingWrites++;
        result.generatedChores++;
        if (pendingWrites >= 450) {
          await choreWrites.commit();
          return {...result, ...(await runHouseholdReminders(
            db, householdId, now, ts))};
        }
      }
    }
  }

  // Retention: completed chores older than 90 days are removed (existing
  // product policy, previously run from whichever browser opened Chores).
  const purgeBefore = addDays(today, -COMPLETED_CHORE_RETENTION_DAYS);
  for (const choreDoc of choresSnap.docs) {
    const chore = choreDoc.data();
    const completedAt = typeof chore.completedAt === "string" ?
      localDay(new Date(chore.completedAt), timeZone) : null;
    if (chore.isCompleted && completedAt && completedAt < purgeBefore &&
        pendingWrites < 450) {
      choreWrites.delete(choreDoc.ref);
      pendingWrites++;
      result.purgedChores++;
    }
  }
  if (pendingWrites > 0) await choreWrites.commit();

  const ensure = async (id: string, fields: Record<string, unknown>) => {
    const ref = house.collection("notifications").doc(id);
    const created = await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) {
        tx.set(ref, notificationBody(householdId, now, ts, fields));
        return "created";
      }
      const expiresAt = snap.get("expiresAt") as Timestamp | undefined;
      // Still-actionable reminders stay visible: re-surface an expired one
      // rather than letting the 7-day window hide something still overdue.
      // Clients list notifications created in the last 7 days, so createdAt
      // moves too; an earlier dismissal still stands.
      if (expiresAt && expiresAt.toMillis() <= now.getTime() &&
          !snap.get("resolvedAt")) {
        tx.update(ref, {
          message: fields.message,
          createdAt: ts(now),
          expiresAt: ts(new Date(now.getTime() +
            NOTIFICATION_TTL_DAYS * 86400000)),
        });
        return "refreshed";
      }
      return "unchanged";
    });
    if (created === "created") result.createdNotifications++;
    if (created === "refreshed") result.refreshedNotifications++;
  };

  // Maintenance reminders (household-wide).
  const reminders = actionableReminders(buildMaintenanceReminders(
    assetsSnap.docs.map((d) => ({id: d.id, ...d.data()}) as AssetInput),
    vehiclesSnap.docs.map((d) => ({id: d.id, ...d.data()}) as VehicleInput),
    today, timeZone));
  for (const r of reminders) {
    await ensure(
      deterministicNotificationId(r.sourceType, r.sourceId, r.stateKey), {
        category: "maintenance",
        title: r.title,
        message: r.message,
        deepLink: r.deepLink,
        sourceType: r.sourceType,
        sourceId: r.sourceId,
        stateKey: r.stateKey,
      });
  }

  // Chore reminders (per person, in their own timezone).
  const chores = choresSnap.docs.map((d) => ({id: d.id, ...d.data()}) as
    ChoreInput);
  const profiles = await Promise.all(members.map((m) =>
    db.collection("users").doc(m.email).get()));
  for (const [index, member] of members.entries()) {
    const profile = profiles[index].data() || {};
    const settings = profile.choreSettings || {};
    const notes = choreNotificationsFor({
      uid: member.uid,
      email: member.email,
      timeZone: safeTimeZone(profile.timeZone || timeZone),
      reminderEnabled: Boolean(settings.reminderEnabled),
      reminderTime: settings.reminderTime,
    }, chores, now);
    for (const note of notes) {
      await ensure(note.id, {
        category: "chores",
        title: note.title,
        message: note.message,
        deepLink: "/chores",
        sourceType: "chore-reminder",
        sourceId: note.sourceId,
        targetUserUid: note.targetUserUid,
        targetUserEmail: note.targetUserEmail,
      });
    }
  }
  return result;
};
