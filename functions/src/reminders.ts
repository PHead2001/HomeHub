// Server-side reminders and recurring chores, run on a schedule so they happen
// whether or not anyone opens the app. Every step is idempotent: notification
// and chore IDs are deterministic, so overlapping or repeated runs are safe.
// Types come from the "firebase-admin/firestore" entry point, which both the
// functions package and the web app's (newer) firebase-admin provide; the web
// app type-checks this file through the @functions alias.
import type {
  DocumentReference, Firestore, Timestamp as FirestoreTimestamp,
} from "firebase-admin/firestore";
import {
  addDays, localDay, safeTimeZone, zonedMidnightIso,
} from "./shared/calendar";
import {choreNotificationsFor, type ChoreInput} from "./shared/chore-reminders";
import {
  addPurgedChores, choreStatsDocId, completionYear, readChoreStats,
  type PurgedChore,
} from "./shared/chore-stats";
import {deterministicNotificationId, recurringChoreId} from "./shared/ids";
import {
  actionableReminders, buildMaintenanceReminders,
  type AssetInput, type VehicleInput,
} from "./shared/maintenance-reminders";
import {
  MEDICATION_SOURCE_TYPE, buildMedicationReminders, medicationCycle,
  pendingCycles, type PetInput,
} from "./shared/medication-reminders";
import {normalizeRecurrence, upcomingOccurrences} from "./shared/recurrence";

type Db = Firestore;
type Timestamp = FirestoreTimestamp;

export const NOTIFICATION_TTL_DAYS = 7;
/**
 * Still-actionable reminders are refreshed this long before they expire, so
 * the Firestore TTL policy on expiresAt can only reach them if upkeep has not
 * run for two days.
 */
export const REFRESH_BEFORE_EXPIRY_MS = 2 * 86400000;
export const COMPLETED_CHORE_RETENTION_DAYS = 90;
export const RECURRING_LOOKAHEAD = 30;
const APPROVED = new Set(["owner", "admin", "member", "child", "guest"]);

export type HouseholdRunResult = {
  householdId: string;
  generatedChores: number;
  purgedChores: number;
  createdNotifications: number;
  refreshedNotifications: number;
  resolvedNotifications: number;
  reopenedNotifications: number;
};

/**
 * Whether a resolved reminder that is actionable again may be reopened: only
 * when its last write (the resolution) happened before the run started reading
 * the data that says it is actionable.
 * @param {number | undefined} lastWriteMs Notification update time.
 * @param {number} sourcesReadFromMs When the run started its source reads.
 * @return {boolean} True to reopen.
 */
export const shouldReopen = (
  lastWriteMs: number | undefined,
  sourcesReadFromMs: number,
): boolean => lastWriteMs !== undefined && lastWriteMs < sourcesReadFromMs;

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
    resolvedNotifications: 0, reopenedNotifications: 0,
  };
  const house = db.collection("households").doc(householdId);
  const houseSnap = await house.get();
  // A household being deleted is frozen: upkeep must not add anything back.
  if (!houseSnap.exists || houseSnap.get("deletingAt")) return result;

  // Every upkeep write re-reads the household in the same transaction. The
  // deletion freeze writes that document, so Firestore serializes the two:
  // writes before the freeze are swept by the delete, and none land after it.
  // Each chore is also re-read: a generated chore is created only if it is
  // still absent (an overlapping run may have created it and someone may have
  // completed it since), and a purge happens only if the chore is unchanged.
  // Each source template is re-read too: instances are created only if their
  // template is unchanged since this run read it, so an edit or cancellation
  // in between (which removes its incomplete instances) is never undone.
  type Ref = DocumentReference;
  type ChoreOp =
    {
      kind: "create"; ref: Ref; data: Record<string, unknown>;
      template: Ref; templateVersion: FirestoreTimestamp | undefined;
    } |
    {kind: "purge"; ref: Ref; completedAt: string; year: number};
  const commitGuarded = (ops: ChoreOp[]):
    Promise<{created: number; purged: number} | null> =>
    db.runTransaction(async (tx) => {
      const templateRefs = [...new Map(ops.flatMap((op) =>
        op.kind === "create" ? [[op.template.path, op.template]] : []))
        .values()];
      // Yearly chore stats for every year a purge may touch: a purged chore
      // is added to them in this same transaction (read before any write).
      const statsYears = [...new Set(ops.flatMap((op) =>
        op.kind === "purge" ? [op.year] : []))];
      const statsRefs = statsYears.map((year) =>
        house.collection("stats").doc(choreStatsDocId(year)));
      const [home, ...rest] = await tx.getAll(
        house, ...templateRefs, ...ops.map((op) => op.ref), ...statsRefs);
      if (!home.exists || home.get("deletingAt")) return null;
      const templates = new Map(templateRefs.map((ref, index) =>
        [ref.path, rest[index]]));
      const current = rest.slice(templateRefs.length,
        templateRefs.length + ops.length);
      const statsSnaps = rest.slice(templateRefs.length + ops.length);
      const purgedByYear = new Map<number, PurgedChore[]>();
      let created = 0;
      let purged = 0;
      ops.forEach((op, index) => {
        const snap = current[index];
        if (op.kind === "create") {
          const template = templates.get(op.template.path);
          const unchanged = Boolean(template?.exists && op.templateVersion &&
            template.updateTime?.isEqual(op.templateVersion));
          if (unchanged && !snap.exists) {
            tx.create(op.ref, op.data);
            created++;
          }
        } else if (snap.exists && snap.get("isCompleted") === true &&
            snap.get("completedAt") === op.completedAt) {
          tx.delete(op.ref);
          purged++;
          // Counted only when actually deleted, so repeated or overlapping
          // runs never count a chore twice.
          const list = purgedByYear.get(op.year) ?? [];
          list.push({
            assignedToEmail: snap.get("assignedToEmail"),
            assignedToDisplayName: snap.get("assignedToDisplayName"),
            completedAt: op.completedAt,
          });
          purgedByYear.set(op.year, list);
        }
      });
      statsYears.forEach((year, index) => {
        const chores = purgedByYear.get(year);
        if (!chores || chores.length === 0) return;
        const stats = addPurgedChores(
          readChoreStats(statsSnaps[index]?.data(), year), chores);
        tx.set(statsRefs[index], {...stats, updatedAt: ts(now)});
      });
      return {created, purged};
    });
  const timeZone = safeTimeZone(houseSnap.get("timeZone"));
  const today = localDay(now, timeZone);

  // Wall-clock start of this run's source reads (Firestore update times are
  // wall-clock too, unlike the injectable `now`). A resolved reminder is
  // reopened only if it was resolved before this instant, so every read below
  // already reflects whatever change resolved it.
  const sourcesReadFrom = Date.now();
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
  const choreOps: ChoreOp[] = [];
  const stopped = {...result, generatedChores: 0, purgedChores: 0};
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
        const choreRef = house.collection("chores").doc(id);
        const chore = {
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
        };
        choreOps.push({
          kind: "create", ref: choreRef, data: chore,
          template: templateDoc.ref, templateVersion: templateDoc.updateTime,
        });
        if (choreOps.length >= 450) {
          const done = await commitGuarded(choreOps);
          if (!done) return stopped;
          result.generatedChores = done.created;
          return {...result, ...(await runHouseholdReminders(
            db, householdId, now, ts))};
        }
      }
    }
  }

  // Retention: completed chores older than 90 days are removed (existing
  // product policy, previously run from whichever browser opened Chores).
  // Each removed chore is first added to households/{id}/stats/chores-{year}
  // (year of its completion in the household timezone), so yearly totals
  // such as Home Wrapped keep counting it.
  const purgeBefore = addDays(today, -COMPLETED_CHORE_RETENTION_DAYS);
  for (const choreDoc of choresSnap.docs) {
    const chore = choreDoc.data();
    const completedAt = typeof chore.completedAt === "string" ?
      localDay(new Date(chore.completedAt), timeZone) : null;
    // Retention keys off completedAt (unchanged policy); the stats year comes
    // from the authoritative completion instant (completedAtServer first).
    const year = completedAt ? completionYear(chore, timeZone) : null;
    if (chore.isCompleted && completedAt && year !== null &&
        completedAt < purgeBefore && choreOps.length < 450) {
      choreOps.push({
        kind: "purge", ref: choreDoc.ref, completedAt: chore.completedAt, year,
      });
    }
  }
  if (choreOps.length > 0) {
    const done = await commitGuarded(choreOps);
    if (!done) return stopped;
    result.generatedChores = done.created;
    result.purgedChores = done.purged;
  }

  // Returns false when the household disappeared or started deleting.
  const ensure = async (id: string, fields: Record<string, unknown>) => {
    const ref = house.collection("notifications").doc(id);
    const created = await db.runTransaction(async (tx) => {
      const [home, snap] = await Promise.all([tx.get(house), tx.get(ref)]);
      if (!home.exists || home.get("deletingAt")) return "stopped";
      if (!snap.exists) {
        tx.set(ref, notificationBody(householdId, now, ts, fields));
        return "created";
      }
      const freshExpiry = ts(new Date(now.getTime() +
        NOTIFICATION_TTL_DAYS * 86400000));
      // Reopen: this reminder is actionable again with the same identity, so
      // whatever resolved it was undone (for example a mistakenly logged dose
      // was deleted, or a maintenance completion never reached its schedule).
      // Only when it was resolved before this run read its sources: a
      // resolution written while the run was in flight may reflect data the
      // run has not seen. It is an update, so no new push is sent; members
      // already had one for this same reminder, and it is visible in the
      // bell again. Read and dismissed state is kept, as on refresh.
      if (snap.get("resolvedAt")) {
        if (!shouldReopen(snap.updateTime?.toMillis(), sourcesReadFrom)) {
          return "unchanged";
        }
        tx.update(ref, {
          ...fields,
          resolvedAt: null,
          resolvedBy: null,
          createdAt: ts(now),
          expiresAt: freshExpiry,
        });
        return "reopened";
      }
      const expiresAt = snap.get("expiresAt") as Timestamp | undefined;
      // Still-actionable reminders stay visible: re-surface one that is close
      // to expiry rather than letting the 7-day window hide something still
      // overdue. Clients list notifications created in the last 7 days, so
      // createdAt moves too. This runs before expiry so the TTL policy never
      // deletes a still-actionable reminder (which would lose its read and
      // dismissed state); an update keeps them and sends no new push.
      if (expiresAt &&
          expiresAt.toMillis() <= now.getTime() + REFRESH_BEFORE_EXPIRY_MS) {
        tx.update(ref, {
          message: fields.message,
          createdAt: ts(now),
          expiresAt: freshExpiry,
        });
        return "refreshed";
      }
      return "unchanged";
    });
    if (created === "created") result.createdNotifications++;
    if (created === "refreshed") result.refreshedNotifications++;
    if (created === "reopened") result.reopenedNotifications++;
    return created !== "stopped";
  };

  // Maintenance reminders (household-wide).
  const reminders = actionableReminders(buildMaintenanceReminders(
    assetsSnap.docs.map((d) => ({id: d.id, ...d.data()}) as AssetInput),
    vehiclesSnap.docs.map((d) => ({id: d.id, ...d.data()}) as VehicleInput),
    today, timeZone));
  for (const r of reminders) {
    const kept = await ensure(
      deterministicNotificationId(r.sourceType, r.sourceId, r.stateKey), {
        category: "maintenance",
        title: r.title,
        message: r.message,
        deepLink: r.deepLink,
        sourceType: r.sourceType,
        sourceId: r.sourceId,
        stateKey: r.stateKey,
      });
    if (!kept) return result;
  }

  // Pet medication reminders (household-wide, like maintenance): one per
  // countdown state, in the household's day. Every entry of each pet is read
  // so a later dose without a next due date cancels the countdown, exactly
  // as on the pet's page.
  const petsSnap = await house.collection("pets").get();
  const pets: PetInput[] = await Promise.all(petsSnap.docs.map(async (pet) => ({
    id: pet.id,
    name: pet.get("name"),
    logs: (await pet.ref.collection("medication-logs").get()).docs
      .map((log) => log.data()),
  })));
  for (const r of buildMedicationReminders(pets, today)) {
    const kept = await ensure(
      deterministicNotificationId(r.sourceType, r.sourceId, r.stateKey), {
        category: "pets",
        title: r.title,
        message: r.message,
        deepLink: r.deepLink,
        sourceType: r.sourceType,
        sourceId: r.sourceId,
        stateKey: r.stateKey,
      });
    if (!kept) return result;
  }
  // A reminder resolves once its countdown is no longer pending: a newer
  // dose was logged (with a later due date, or none), or the pet is gone.
  const pending = pendingCycles(pets);
  const openMedication = (await house.collection("notifications")
    .where("sourceType", "==", MEDICATION_SOURCE_TYPE).get()).docs
    .filter((note) => !note.get("resolvedAt") &&
      typeof note.get("sourceId") === "string" &&
      typeof note.get("stateKey") === "string" &&
      !pending.has(
        medicationCycle(note.get("sourceId"), note.get("stateKey"))));
  for (const note of openMedication) {
    const status = await db.runTransaction(async (tx) => {
      const [home, snap] = await Promise.all([tx.get(house), tx.get(note.ref)]);
      if (!home.exists || home.get("deletingAt")) return "stopped";
      if (snap.exists && !snap.get("resolvedAt")) {
        tx.update(note.ref, {resolvedAt: ts(now)});
      }
      return "ok";
    });
    if (status === "stopped") return result;
    result.resolvedNotifications++;
  }

  // Chore reminders (per person, in their own timezone). Reminder documents
  // are fixed per day once written, so they must see this run's generated
  // and purged chores: re-read when this run changed any.
  const choreDocs = result.generatedChores > 0 || result.purgedChores > 0 ?
    (await house.collection("chores").get()).docs :
    choresSnap.docs;
  const chores = choreDocs.map((d) => ({id: d.id, ...d.data()}) as
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
      householdTimeZone: timeZone,
      reminderEnabled: Boolean(settings.reminderEnabled),
      reminderTime: settings.reminderTime,
    }, chores, now);
    for (const note of notes) {
      const kept = await ensure(note.id, {
        category: "chores",
        title: note.title,
        message: note.message,
        deepLink: "/chores",
        sourceType: "chore-reminder",
        sourceId: note.sourceId,
        targetUserUid: note.targetUserUid,
        targetUserEmail: note.targetUserEmail,
      });
      if (!kept) return result;
    }
  }
  return result;
};
