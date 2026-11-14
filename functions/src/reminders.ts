// Server-side reminders and recurring chores, run on a schedule so they happen
// whether or not anyone opens the app. Every step is idempotent: notification
// and chore IDs are deterministic, so overlapping or repeated runs are safe.
// Types come from the "firebase-admin/firestore" entry point, which both the
// functions package and the web app's (newer) firebase-admin provide; the web
// app type-checks this file through the @functions alias.
import type {
  DocumentReference, Firestore, QuerySnapshot,
  Timestamp as FirestoreTimestamp,
} from "firebase-admin/firestore";
import {
  addDays, localDay, localMinutes, safeTimeZone, zonedMidnightIso,
} from "./shared/calendar";
import {
  choreNotificationsFor, overdueChoresFor, UPKEEP_INTERVAL_MS,
  type ChoreInput,
} from "./shared/chore-reminders";
import {syncOverdueNotification} from "./overdue-chores";
import {
  addPurgedChores, choreStatsDocId, completionYear, purgeMustWait,
  readChoreStats,
  type PurgedChore,
} from "./shared/chore-stats";
import {
  assigneeEmailOf, assigneeFields, resolveAssigneeUid,
} from "./shared/assignee";
import {
  choreOccurrenceKey, deterministicNotificationId, occurrenceChoreId,
  storedOccurrenceKey,
} from "./shared/ids";
import {
  actionableReminders, buildMaintenanceReminders,
  type AssetInput, type VehicleInput,
} from "./shared/maintenance-reminders";
import {
  hasAudience,
  notificationAudience,
} from "./shared/notification-audience";
import {isDocId} from "./shared/push-media";
import {
  MEDICATION_SOURCE_TYPE, buildMedicationReminders, medicationCycle,
  pendingCycles, type PetInput,
} from "./shared/medication-reminders";
import {normalizeRecurrence, upcomingOccurrences} from "./shared/recurrence";
import {withContactEmails} from "./shared/member-contact";
import {
  DEVICE_UID_PREFIX, finishRevocationForRecord, type DeviceAuthClient,
} from "./shared/device-revocation";

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

/** A Firestore server instant (a Timestamp's exact parts). */
export type ServerInstant = {seconds: number; nanoseconds: number};

/**
 * The earliest server read time of these snapshots: every read at or after it
 * reflects all writes committed at or before it. Snapshots without a read time
 * are ignored; with none at all the result is undefined.
 * @param {Array} snaps Query or document snapshots.
 * @return {ServerInstant | undefined} Earliest read time.
 */
export const earliestReadTime = (
  snaps: Array<{readTime?: ServerInstant}>,
): ServerInstant | undefined => snaps
  .map((snap) => snap.readTime)
  .filter((time): time is ServerInstant => time !== undefined)
  .reduce<ServerInstant | undefined>((earliest, time) =>
    earliest === undefined || time.seconds < earliest.seconds ||
      (time.seconds === earliest.seconds &&
        time.nanoseconds < earliest.nanoseconds) ? time : earliest,
  undefined);

/**
 * Whether a resolved reminder that is actionable again may be reopened: only
 * when its last write (the resolution) was already visible to the run's
 * source reads, that is, committed at or before their earliest read time.
 * Both are Firestore server timestamps, compared exactly (no wall clock).
 * @param {ServerInstant | undefined} lastWrite Notification update time.
 * @param {ServerInstant | undefined} sourcesReadAt Earliest source read time.
 * @return {boolean} True to reopen.
 */
export const shouldReopen = (
  lastWrite: ServerInstant | undefined,
  sourcesReadAt: ServerInstant | undefined,
): boolean => lastWrite !== undefined && sourcesReadAt !== undefined &&
  (lastWrite.seconds < sourcesReadAt.seconds ||
    (lastWrite.seconds === sourcesReadAt.seconds &&
      lastWrite.nanoseconds <= sourcesReadAt.nanoseconds));

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
  audience: notificationAudience(fields),
});

/**
 * The protected contact documents (`members/{uid}/private/contact`) of these
 * members, by uid: the only source of a member's email. A failed read
 * yields `null`, distinct from "no contacts" (an empty map).
 * @param {DocumentReference} house Household document.
 * @param {string[]} uids Members to read.
 * @return {Promise<Map<string, unknown> | null>} Contact data by uid, or
 *   null when the read failed.
 */
export const readMemberContactsOrNull = async (
  house: DocumentReference,
  uids: string[],
): Promise<Map<string, unknown> | null> => {
  if (uids.length === 0) return new Map();
  const refs = uids.map((uid) =>
    house.collection("members").doc(uid).collection("private").doc("contact"));
  try {
    const snaps = await house.firestore.getAll(...refs);
    return new Map(snaps.map((snap, index) => [uids[index], snap.data()]));
  } catch {
    return null;
  }
};

/** Thrown when the members' contact documents could not be read. */
export class MemberContactsUnavailable extends Error {
  attempts: number;
  /** @param {number} attempts How many reads were tried. */
  constructor(attempts: number) {
    super(`Member contact documents unreadable after ${attempts} attempts.`);
    this.name = "MemberContactsUnavailable";
    this.attempts = attempts;
  }
}

/**
 * As readMemberContactsOrNull, for a caller that nothing will revisit (the
 * push trigger on a new notification): a failed read is tried again after
 * each of `delaysMs` (by default three reads, 250 ms and 1 s apart), and if
 * every read fails it throws, so the caller fails visibly rather than
 * finishing with no recipients. It never falls back to an email kept on a
 * membership record.
 * @param {DocumentReference} house Household document.
 * @param {string[]} uids Members to read.
 * @param {number[]} delaysMs Waits before each retry.
 * @param {Function} wait Sleeps for a number of milliseconds (tests).
 * @return {Promise<Map<string, unknown>>} Contact data by uid.
 */
export const readMemberContacts = async (
  house: DocumentReference,
  uids: string[],
  delaysMs: readonly number[] = [250, 1000],
  wait: (ms: number) => Promise<unknown> = (ms) =>
    new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<Map<string, unknown>> => {
  for (let attempt = 0; ; attempt++) {
    const contacts = await readMemberContactsOrNull(house, uids);
    if (contacts) return contacts;
    if (attempt >= delaysMs.length) {
      throw new MemberContactsUnavailable(attempt + 1);
    }
    await wait(delaysMs[attempt]);
  }
};

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
      // Occurrences that already have a chore under another id (reassigned
      // or created by an overlapping run): never create a second one.
      const keys = [...new Set(ops.flatMap((op) =>
        op.kind === "create" && typeof op.data.occurrenceKey === "string" ?
          [op.data.occurrenceKey] : []))];
      const keyQueries: Promise<QuerySnapshot>[] = [];
      for (let index = 0; index < keys.length; index += 30) {
        keyQueries.push(tx.get(house.collection("chores")
          .where("occurrenceKey", "in", keys.slice(index, index + 30))));
      }
      const [[home, ...rest], keySnaps] = await Promise.all([
        tx.getAll(house, ...templateRefs, ...ops.map((op) => op.ref),
          ...statsRefs),
        Promise.all(keyQueries),
      ]);
      if (!home.exists || home.get("deletingAt")) return null;
      const takenKeys = new Map<string, string>();
      for (const snap of keySnaps) {
        for (const d of snap.docs) takenKeys.set(d.get("occurrenceKey"), d.id);
      }
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
          const key = op.data.occurrenceKey;
          const taken = typeof key === "string" && takenKeys.has(key) &&
            takenKeys.get(key) !== op.ref.id;
          if (unchanged && !snap.exists && !taken) {
            tx.create(op.ref, op.data);
            created++;
            if (typeof key === "string") takenKeys.set(key, op.ref.id);
          }
        } else if (snap.exists && snap.get("isCompleted") === true &&
            snap.get("completedAt") === op.completedAt &&
            !purgeMustWait(snap.data() ?? {}, members, emailsKnown)) {
          tx.delete(op.ref);
          purged++;
          // Counted only when actually deleted, so repeated or overlapping
          // runs never count a chore twice.
          const list = purgedByYear.get(op.year) ?? [];
          list.push({
            assignedToUid: snap.get("assignedToUid"),
            assignedToEmail: snap.get("assignedToEmail"),
            assignedToDisplayName: snap.get("assignedToDisplayName"),
            completedByUid: snap.get("completedByUid"),
            completedByEmail: snap.get("completedByEmail"),
            completedByName: snap.get("completedByName"),
            completedAt: op.completedAt,
          });
          purgedByYear.set(op.year, list);
        }
      });
      statsYears.forEach((year, index) => {
        const chores = purgedByYear.get(year);
        if (!chores || chores.length === 0) return;
        // Keyed by uid. Members' emails (from their contact documents) match
        // older email-only chores and fold any legacy email-derived key.
        const stats = addPurgedChores(
          readChoreStats(statsSnaps[index]?.data(), year), chores, members);
        tx.set(statsRefs[index], {...stats, updatedAt: ts(now)});
      });
      return {created, purged};
    });
  const timeZone = safeTimeZone(houseSnap.get("timeZone"));
  const today = localDay(now, timeZone);

  const sourceSnaps = await Promise.all([
    house.collection("members").get(),
    house.collection("chores").get(),
    house.collection("chore-templates").get(),
    house.collection("home-assets").get(),
    house.collection("vehicles").get(),
  ]);
  const [membersSnap, choresSnap, templatesSnap, assetsSnap, vehiclesSnap] =
    sourceSnaps;
  // Server read time of this run's source reads (every later read is at or
  // after it). A resolved reminder is reopened only if its resolution was
  // committed at or before this instant, so the reads already reflect
  // whatever change resolved it. Server time against server time: the
  // injectable `now` and the Functions wall clock play no part.
  const sourcesReadAt = earliestReadTime(sourceSnaps);

  const approvedRecords = membersSnap.docs
    .map((d) => ({uid: d.id, ...d.data()}))
    .filter((m: Record<string, unknown>) =>
      APPROVED.has(String(m.role)) &&
      (m.status === undefined || m.status === "active")) as Array<{
        uid: string; email?: string; displayName?: string;
      }>;
  // Emails come only from each member's contact document. When that read
  // fails, reminders simply skip email-keyed lookups this run; purges of
  // chores that can only be credited through an email, and generation from
  // templates that still carry an email, wait for a run that has the emails
  // (purgeMustWait, and the template check below), so no credit is lost and
  // no possibly stale uid is trusted.
  const contacts = await readMemberContactsOrNull(
    house, approvedRecords.map((m) => m.uid));
  const emailsKnown = contacts !== null;
  const members = withContactEmails(approvedRecords, contacts ?? new Map());
  const memberByUid = new Map(members.map((m) => [m.uid, m]));

  // Recurring chores: create the next occurrences that do not exist yet. An
  // occurrence exists when its id (`occurrenceChoreId`: template, room and
  // day) does, or when any chore holds its occurrence key (the same three,
  // stored on the chore or recovered from an id generated before release E,
  // which also carried the assignee), so a day that already has its chore,
  // completed or open, is never generated again after a reassignment, a
  // schedule edit or the id switch.
  const choreIds = new Set(choresSnap.docs.map((d) => d.id));
  const occurrenceKeys = new Set(choresSnap.docs.flatMap((d) => {
    const key = storedOccurrenceKey(d.id, d.data());
    return key ? [key] : [];
  }));
  const choreOps: ChoreOp[] = [];
  const stopped = {...result, generatedChores: 0, purgedChores: 0};
  for (const templateDoc of templatesSnap.docs) {
    const template = templateDoc.data();
    const recurrence = normalizeRecurrence(template.recurrence, today);
    // Assigned by uid or (older templates) by email. Generated chores store
    // the uid only (member privacy release C) and their id names no one
    // (release E).
    if (!recurrence) continue;
    // Never generate work for someone who is no longer an approved member.
    // A template that still carries an assignee email (written before member
    // privacy release C and not yet scrubbed) is generated only for the
    // member whose contact document holds that email: its uid may be stale
    // (an older build reassigned it by email only), and a day once written
    // is never generated again. Without that match (the contact read failed,
    // or the email names nobody) it waits for a later run.
    const templateEmail = assigneeEmailOf(template);
    const assigneeUid = templateEmail ?
      members.find((m) => typeof m.email === "string" &&
        m.email.trim().toLowerCase() === templateEmail)?.uid ?? null :
      resolveAssigneeUid(template, members);
    const person = assigneeUid ? memberByUid.get(assigneeUid) : undefined;
    if (!person) continue;
    const rooms: string[] = Array.isArray(template.roomIds) &&
      template.roomIds.length > 0 ? template.roomIds : ["general"];
    for (const day of upcomingOccurrences(recurrence, today,
      RECURRING_LOOKAHEAD)) {
      for (const roomId of rooms) {
        const id = occurrenceChoreId(templateDoc.id, roomId, day);
        const occurrenceKey = choreOccurrenceKey(templateDoc.id, roomId, day);
        if (choreIds.has(id) || occurrenceKeys.has(occurrenceKey)) continue;
        choreIds.add(id);
        occurrenceKeys.add(occurrenceKey);
        const choreRef = house.collection("chores").doc(id);
        const chore = {
          task: template.task,
          ...assigneeFields(person),
          assignedToDisplayName: person.displayName || "Member",
          dueDate: zonedMidnightIso(day, timeZone),
          isCompleted: false,
          notes: template.notes || "",
          subTasks: template.subTasks || [],
          completedSubTasks: [],
          templateId: templateDoc.id,
          originalDueDate: day,
          occurrenceKey,
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
    // A chore credited only through an email is left for a later run when
    // the members' emails are unknown or name nobody (see purgeMustWait).
    if (chore.isCompleted && completedAt && year !== null &&
        completedAt < purgeBefore && choreOps.length < 450 &&
        !purgeMustWait(chore, members, emailsKnown)) {
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

  // Returns false when the household disappeared or started deleting,
  // otherwise what was written.
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
      // Reminder targets always carry a uid, so this equals what creation
      // would store for the same reminder.
      const audience = notificationAudience(fields);
      // Reopen: this reminder is actionable again with the same identity, so
      // whatever resolved it was undone (for example a mistakenly logged dose
      // was deleted, or a maintenance completion never reached its schedule).
      // Only when it was resolved before this run read its sources: a
      // resolution written while the run was in flight may reflect data the
      // run has not seen. It is an update, so no new push is sent; members
      // already had one for this same reminder, and it is visible in the
      // bell again. Read and dismissed state is kept, as on refresh.
      if (snap.get("resolvedAt")) {
        if (!shouldReopen(snap.updateTime, sourcesReadAt)) {
          return "unchanged";
        }
        tx.update(ref, {
          ...fields,
          audience,
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
          // Kept as stored; added to a document written before the field
          // existed.
          ...(hasAudience(snap.get("audience")) ? {} : {audience}),
        });
        return "refreshed";
      }
      return "unchanged";
    });
    if (created === "created") result.createdNotifications++;
    if (created === "refreshed") result.refreshedNotifications++;
    if (created === "reopened") result.reopenedNotifications++;
    return created === "stopped" ? false : created;
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
    const sourceId: string = note.get("sourceId");
    const petId = sourceId.split(":")[0];
    const status = await db.runTransaction(async (tx) => {
      const petRef = isDocId(petId) ?
        house.collection("pets").doc(petId) : null;
      const [home, snap, pet, logs] = await Promise.all([
        tx.get(house), tx.get(note.ref),
        petRef ? tx.get(petRef) : Promise.resolve(null),
        petRef ? tx.get(petRef.collection("medication-logs")) :
          Promise.resolve(null),
      ]);
      if (!home.exists || home.get("deletingAt")) return "stopped";
      if (!snap.exists || snap.get("resolvedAt")) return "skipped";
      // Revalidate inside the transaction: this run's countdowns may be stale
      // (an overlapping run may have seen the dose deleted and reopened the
      // reminder). The pet and its entries are read here, so a concurrent
      // change retries this transaction rather than slipping past it.
      const stillPending = Boolean(pet?.exists && logs) && pendingCycles([{
        id: petId,
        logs: logs!.docs.map((log) => log.data()),
      }]).has(medicationCycle(sourceId, snap.get("stateKey")));
      if (stillPending) return "skipped";
      tx.update(note.ref, {resolvedAt: ts(now)});
      return "resolved";
    });
    if (status === "stopped") return result;
    if (status === "resolved") result.resolvedNotifications++;
  }

  // Chore reminders (per person, in their own timezone). Reminder documents
  // are fixed per day once written, so they must see this run's generated
  // and purged chores: re-read when this run changed any.
  const choreDocs = result.generatedChores > 0 || result.purgedChores > 0 ?
    (await house.collection("chores").get()).docs :
    choresSnap.docs;
  const chores = choreDocs.map((d) => ({id: d.id, ...d.data()}) as
    ChoreInput);
  const choreIdSet = new Set(choreDocs.map((d) => d.id));
  // Reminder settings live on the email-keyed profile, so members without a
  // contact document email are skipped.
  const reachable = members.filter((m): m is typeof m & {email: string} =>
    typeof m.email === "string" && m.email.length > 0);
  const profiles = await Promise.all(reachable.map((m) =>
    db.collection("users").doc(m.email).get()));
  for (const [index, member] of reachable.entries()) {
    const profile = profiles[index].data() || {};
    const settings = profile.choreSettings || {};
    const person = {
      uid: member.uid,
      email: member.email,
      timeZone: safeTimeZone(profile.timeZone || timeZone),
      householdTimeZone: timeZone,
      reminderEnabled: Boolean(settings.reminderEnabled),
      reminderTime: settings.reminderTime,
    };
    const notes = choreNotificationsFor(person, chores, now);
    let reminderSent = false;
    for (const note of notes) {
      const kept = await ensure(note.id, {
        category: "chores",
        title: note.title,
        message: note.message,
        deepLink: "/chores",
        sourceType: "chore-reminder",
        sourceId: note.sourceId,
        targetUserUid: note.targetUserUid,
      });
      if (!kept) return result;
      if (kept === "created") reminderSent = true;
    }
    // One overdue notification per person, updated in place
    // (./overdue-chores.ts). A daily reminder sent in this run (at any hour),
    // or still to come today, states the overdue count, so it carries the
    // push; the overdue document records that the same run.
    const overdue = overdueChoresFor(person, chores, now);
    const status = await syncOverdueNotification({
      db, house, now, ts,
      newBody: (fields) => notificationBody(householdId, now, ts, fields),
      freshExpiry: () => ts(new Date(now.getTime() +
        NOTIFICATION_TTL_DAYS * 86400000)),
      nearExpiry: (expiresAt) => Boolean(expiresAt &&
        expiresAt.toMillis() <= now.getTime() + REFRESH_BEFORE_EXPIRY_MS),
      seenByRun: (updateTime) => shouldReopen(updateTime, sourcesReadAt),
    }, member.uid, overdue, {
      reminderSentNow: reminderSent,
      reminderPending: overdue.dailyReminderPending,
      // Dated documents from earlier versions: swept in the first hour of
      // the person's day, and whenever the notification is written.
      sweepLegacy:
        localMinutes(now, person.timeZone) < UPKEEP_INTERVAL_MS / 60000,
      existingChoreIds: choreIdSet,
    });
    if (status === "stopped") return result;
    if (status === "created") result.createdNotifications++;
    if (status === "reopened") result.reopenedNotifications++;
    if (status === "resolved") result.resolvedNotifications++;
  }
  return result;
};

/** The UTC hour of the daily wall-tablet sign-out sweep (hourly upkeep). */
export const DEVICE_SWEEP_UTC_HOUR = 3;

export type DeviceSweepResult = {
  ran: boolean; checked: number; finished: number; orphans: number;
  spared: number; failed: number;
};

/**
 * Whether a `device_` Auth user that looked orphaned must be kept: its
 * household or its device record exists now, or the user was created after
 * the sweep started (a pairing racing the sweep).
 * @param {Db} db Firestore (Admin SDK).
 * @param {DeviceAuthClient} auth Admin Auth.
 * @param {string} uid The Auth user's id.
 * @param {string} householdId The household its claims name ("" if none).
 * @param {string} deviceId The device id (uid suffix).
 * @param {number} sweepStartedAt When the sweep started (ms).
 * @return {Promise<boolean>} True to keep the user.
 */
const deviceUserStillWanted = async (
  db: Db,
  auth: DeviceAuthClient,
  uid: string,
  householdId: string,
  deviceId: string,
  sweepStartedAt: number,
): Promise<boolean> => {
  if (householdId) {
    const house = db.collection("households").doc(householdId);
    const [household, record] = await Promise.all([
      house.get(), house.collection("devices").doc(deviceId).get(),
    ]);
    if (household.exists || record.exists) return true;
  }
  const fresh = await auth.getUser(uid);
  const created = Date.parse(fresh.metadata?.creationTime ?? "");
  return Number.isFinite(created) && created >= sweepStartedAt;
};

/**
 * Daily: finishes the Firebase Auth sign-out of every registered wall tablet
 * whose record is no longer active (removed: user deleted; unpaired: user
 * disabled), or whose stored claims carry an older generation (a re-pair whose
 * revocation failed), in every household. Then deletes `device_` Auth users
 * whose household no longer exists (a deletion whose Auth step failed). Runs
 * once a day (the upkeep hour `DEVICE_SWEEP_UTC_HOUR`) unless `force`.
 * See docs/modules/devices/README.md.
 * @param {Db} db Firestore (Admin SDK).
 * @param {DeviceAuthClient} auth Admin Auth.
 * @param {Date} now Current instant.
 * @param {boolean} force Run whatever the hour (tests).
 * @return {Promise<DeviceSweepResult>} What was done.
 */
export const sweepDeviceRevocations = async (
  db: Db,
  auth: DeviceAuthClient,
  now: Date,
  force = false,
): Promise<DeviceSweepResult> => {
  const result: DeviceSweepResult = {
    ran: false, checked: 0, finished: 0, orphans: 0, spared: 0, failed: 0,
  };
  if (!force && now.getUTCHours() !== DEVICE_SWEEP_UTC_HOUR) return result;
  result.ran = true;
  const sweepStartedAt = Date.now();
  const households = await db.collection("households").select().get();
  const existing = new Set(households.docs.map((d) => d.id));
  for (const household of households.docs) {
    const devices = await household.ref.collection("devices").get();
    for (const device of devices.docs) {
      result.checked++;
      try {
        const outcome = await finishRevocationForRecord(auth, device.id, {
          status: device.get("status"),
          generation: device.get("generation"),
        });
        if (outcome !== "none" && outcome !== "missing") result.finished++;
      } catch {
        result.failed++;
      }
    }
  }
  // Auth users of tablets whose household record tree is gone.
  let pageToken: string | undefined;
  do {
    const page = await auth.listUsers(1000, pageToken);
    for (const user of page.users) {
      if (!user.uid.startsWith(DEVICE_UID_PREFIX)) continue;
      const claims = user.customClaims || {};
      const householdId = typeof claims.hh_household === "string" ?
        claims.hh_household : "";
      if (householdId && existing.has(householdId)) continue;
      const deviceId = user.uid.slice(DEVICE_UID_PREFIX.length);
      try {
        // The household list above was read before this page: re-read what
        // the user names now (a household created and a tablet paired during
        // the sweep is no orphan); spare users created after the sweep began.
        if (await deviceUserStillWanted(db, auth, user.uid, householdId,
          deviceId, sweepStartedAt)) {
          result.spared++;
          continue;
        }
        await finishRevocationForRecord(auth, deviceId, null);
        result.orphans++;
      } catch {
        result.failed++;
      }
    }
    pageToken = page.pageToken;
  } while (pageToken);
  return result;
};
