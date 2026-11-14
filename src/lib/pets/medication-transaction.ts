/**
 * Medication courses' Firestore side (P3: PE-24, PE-27, D-P7, D-P8), with the
 * Firestore instance passed in so the same code runs in the app
 * (`medication-operation.ts` binds the app's `db`) and against the emulator in
 * tests. The decisions are pure and live in `medication-course.ts`; a device
 * server action (F4) can call the same planners from an Admin SDK transaction.
 *
 * Give dose: one transaction reads this press's log (`doseLogId(opId)`), the
 * course and whether the course's latest dose still exists; `planDose` then
 * answers "already recorded" (a double tap, a retry or a second session of the
 * same press: nothing is written), "already given, record again?" (nothing is
 * written), or the log and the course's new `lastDose` in the same commit. Two
 * sessions giving the same occurrence at once: the course document changes
 * under the second, which retries, sees the first dose and asks.
 *
 * Offline (the browser reports no network; transactions cannot run), the dose
 * is queued under the same id, marked `repeat: 'offline'` and
 * `clockSource: 'device'` (`date` = this device's clock), checked only against
 * what this device has cached; the course's `lastDose` is not written (a blind
 * queued pointer could replace a newer dose by someone else). Every reader
 * combines the course with its offline doses (`withOfflineDoses`), so the dose
 * covers its occurrence on every screen and in the reminders once it syncs.
 */
import {
  collection,
  doc,
  getDocFromCache,
  getDocs,
  getDocsFromCache,
  writeBatch,
  limit,
  orderBy,
  query,
  runTransaction,
  serverTimestamp,
  Timestamp,
  where,
  type DocumentData,
  type Firestore,
} from 'firebase/firestore';
import { awaitWriteUnlessOffline, isBrowserOffline } from '../firestore-offline';
import { petDay } from './care';
import { householdDayZone } from '../household-day';
import {
  coverageAfterEdit,
  doseLogId,
  doseRecordsOf,
  pointerAfter,
  withRecords,
  legacyCourseId,
  planDose,
  readCourse,
  readDosePointer,
  scheduleChanged,
  type CourseFields,
  type CourseView,
  type DoseCheck,
  type DoseConfirm,
  type DosePointer,
  type DoseRefusal,
  type Occurrence,
} from './medication-course';

const petPath = (householdId: string, petId: string) => ['households', householdId, 'pets', petId] as const;
const courseRef = (db: Firestore, householdId: string, petId: string, courseId: string) => doc(db, ...petPath(householdId, petId), 'medication-courses', courseId);
const logsRef = (db: Firestore, householdId: string, petId: string) => collection(db, ...petPath(householdId, petId), 'medication-logs');

/** Why a medication action was refused (shown in the dialog). */
export class MedicationActionError extends Error {
  constructor(readonly reason: DoseRefusal | 'offline' | 'not-active' | 'exists') {
    super(`medication-${reason}`);
    this.name = 'MedicationActionError';
  }
}

const isPermissionDenied = (error: unknown) =>
  Boolean(error && typeof error === 'object' && (error as { code?: unknown }).code === 'permission-denied');

export type Actor = { uid: string; name: string };

/**
 * Runs a transaction once more when the rules refused its commit: a commit that
 * raced another writer is judged against the newer documents (the course now
 * exists, or the dose is already gone), and a fresh attempt then reads them and
 * answers "already". A refusal that is real is refused again and thrown.
 */
async function settled<T>(attempt: () => Promise<T>): Promise<T> {
  try {
    return await attempt();
  } catch (error) {
    if (!isPermissionDenied(error)) throw error;
    return attempt();
  }
}

/* ------------------------------------------------------------------------- */
/* Give dose                                                                  */
/* ------------------------------------------------------------------------- */

export type GiveDoseInput = {
  householdId: string;
  petId: string;
  courseId: string;
  /** One id per press (`newDoseOpId`), reused by "Record again" and Retry. */
  opId: string;
  /** The scheduled occurrence chosen in Give dose. */
  occurrenceKey: string;
  /** A chosen earlier given-at time; null = now. */
  givenAt: Date | null;
  notes?: string;
  /** The answer to "already given?": the dose it named (`doseConfirmOf`). */
  confirm?: DoseConfirm | null;
  user: Actor;
  /** `household.timeZone` (occurrences are household wall time). */
  timeZone?: string | null;
  /** Reports a queued (offline) dose that the server later refuses. */
  onLateError?: (error: unknown) => void;
};

export type GiveDoseResult =
  | { status: 'needsConfirm'; check: DoseCheck; staleConfirm: boolean }
  /** `queued`: offline, saved on this device; nobody else's dose could be checked. */
  | { status: 'saved' | 'queued'; logId: string; occurrence: Occurrence | null; nextAfter: Occurrence | null; replayed?: boolean };

/** How many of a course's newest doses are read (by occurrence): the latest two and ties. */
const LATEST_DOSES = 6;

const newestCourseDoses = (db: Firestore, householdId: string, petId: string, courseId: string) =>
  query(logsRef(db, householdId, petId), where('courseId', '==', courseId), orderBy('occurrenceAt', 'desc'), limit(LATEST_DOSES));

/** A course's newest surviving doses, as records and as stored (a pointer copies stored values exactly). */
type DoseRead = { records: DosePointer[]; stored: Map<string, DocumentData> };

/**
 * The course's newest surviving doses (offline-synced ones included), read
 * inside the attempt: the latest and the one before are among them (they are
 * ordered by occurrence), so `deriveCourseState` over them is the course's
 * state. Any other online dose write changes the course, so a conflicting
 * change retries the transaction with a fresh read.
 */
async function readCourseDoses(db: Firestore, householdId: string, petId: string, courseId: string, excludeId?: string): Promise<DoseRead> {
  const newest = await getDocs(newestCourseDoses(db, householdId, petId, courseId));
  const stored = new Map<string, DocumentData>();
  const logs = newest.docs.filter((entry) => entry.id !== excludeId).map((entry) => {
    stored.set(entry.id, entry.data());
    return { id: entry.id, ...entry.data() };
  });
  return { records: doseRecordsOf(courseId, logs), stored };
}

/** A pointer as written: the stored values of its log (a server time keeps its microseconds). */
function storedPointer(pointer: DosePointer | null, stored: Map<string, DocumentData>, fresh?: { logId: string; value: Record<string, unknown> }): Record<string, unknown> | null {
  if (!pointer) return null;
  if (fresh && pointer.logId === fresh.logId) return fresh.value;
  const log = stored.get(pointer.logId);
  return {
    logId: pointer.logId,
    occurrence: pointer.occurrence,
    occurrenceAt: log?.occurrenceAt ?? Timestamp.fromMillis(pointer.occurrenceAt),
    givenAt: log?.date ?? (pointer.givenAt === null ? null : Timestamp.fromMillis(pointer.givenAt)),
    byUid: typeof log?.loggedByUid === 'string' ? log.loggedByUid : pointer.byUid,
    byName: typeof log?.loggedByName === 'string' ? log.loggedByName : pointer.byName,
  };
}

const doseLogData = (input: GiveDoseInput, course: CourseView, plan: Extract<ReturnType<typeof planDose>, { kind: 'write' }>, given: unknown, occurrenceAt: Timestamp, backdated: boolean) => ({
  courseId: input.courseId,
  occurrence: plan.occurrence.key,
  occurrenceAt,
  date: given,
  loggedAt: serverTimestamp(),
  medication: course.name,
  dosage: course.dosage,
  notes: (input.notes ?? '').trim().slice(0, 2000),
  loggedByUid: input.user.uid,
  loggedByName: input.user.name,
  repeat: plan.repeat,
  ...(plan.repeat === 'confirmed' ? { confirmOf: plan.confirmOf } : {}),
  ...(plan.repeat === 'offline' ? { clockSource: 'device' } : {}),
  ...(backdated ? { backdated: true } : {}),
});

/**
 * Records a dose of a course, or returns `needsConfirm` when that occurrence
 * (or a later one) was already given; call again with the same `opId` and
 * `confirm: doseConfirmOf(result.check)`. A confirmation for a dose that is no
 * longer the latest returns a fresh `needsConfirm` (`staleConfirm: true`).
 */
export async function runGiveDose(db: Firestore, input: GiveDoseInput): Promise<GiveDoseResult> {
  const logId = doseLogId(input.opId);
  if (isBrowserOffline()) return giveDoseOffline(db, input, logId);
  try {
    return await giveDoseOnce(db, input, logId);
  } catch (error) {
    // A commit that raced another writer can be refused by the rules, which then
    // judge it against the newer documents (this press's log exists, or the
    // course names a newer dose). Run the press once more on a fresh read: it
    // finds its own log or asks. A refusal that is real is refused again.
    if (!isPermissionDenied(error)) throw error;
    return giveDoseOnce(db, input, logId);
  }
}

async function giveDoseOnce(db: Firestore, input: GiveDoseInput, logId: string): Promise<GiveDoseResult> {
  const { householdId, petId, courseId } = input;
  return runTransaction(db, async (tx) => {
    const logRef = doc(logsRef(db, householdId, petId), logId);
    const cRef = courseRef(db, householdId, petId, courseId);
    const existing = await tx.get(logRef);
    const courseSnapshot = await tx.get(cRef);
    const raw = courseSnapshot.exists() ? courseSnapshot.data() : null;
    const course = raw ? readCourse(courseId, raw) : null;
    const lastLogId = course?.lastDose?.logId ?? null;
    const lastDoseSurvives = lastLogId ? (await tx.get(doc(logsRef(db, householdId, petId), lastLogId))).exists() : false;
    // The course's state comes from its surviving doses (deriveCourseState): an
    // offline dose that synced, not yet in the pointer, covers its occurrence too.
    const doses = course ? await readCourseDoses(db, householdId, petId, courseId) : null;
    const now = new Date();
    const plan = planDose(
      {
        now,
        timeZone: input.timeZone,
        course: course && doses ? withRecords(course, doses.records) : course,
        lastDoseSurvives,
        existing: existing.exists()
          ? { loggedByUid: (existing.get('loggedByUid') as string | undefined) ?? null, courseId: (existing.get('courseId') as string | undefined) ?? null }
          : null,
      },
      { userUid: input.user.uid, occurrenceKey: input.occurrenceKey, givenAt: input.givenAt, confirm: input.confirm },
    );
    if (plan.kind === 'already') return { status: 'saved', logId, occurrence: null, nextAfter: null, replayed: true } as const;
    if (plan.kind === 'refused') throw new MedicationActionError(plan.reason);
    if (plan.kind === 'needsConfirm') return { status: 'needsConfirm', check: plan.check, staleConfirm: plan.staleConfirm } as const;
    const given = plan.live ? serverTimestamp() : Timestamp.fromDate(plan.givenAt);
    const occurrenceAt = Timestamp.fromMillis(plan.occurrence.at);
    tx.set(logRef, doseLogData(input, course!, plan, given, occurrenceAt, !plan.live));
    // The pointer is the derived state after this dose (a cache that agrees with the records).
    const fresh: DosePointer = { logId, occurrence: plan.occurrence.key, occurrenceAt: plan.occurrence.at, givenAt: plan.givenAt.getTime(), byUid: input.user.uid, byName: input.user.name };
    const next = pointerAfter(course!, [...doses!.records, fresh]);
    if (next.write) {
      const freshValue = { logId, occurrence: plan.occurrence.key, occurrenceAt, givenAt: given, byUid: input.user.uid, byName: input.user.name };
      tx.update(cRef, {
        lastDose: storedPointer(next.latest, doses!.stored, { logId, value: freshValue }),
        prevDose: storedPointer(next.prev, doses!.stored, { logId, value: freshValue }),
      });
    }
    return { status: 'saved', logId, occurrence: plan.occurrence, nextAfter: plan.nextAfter } as const;
  });
}

/**
 * Offline Give dose: only what this device has cached (this press's log, the
 * course, its cached doses). A press already queued here is not queued again;
 * "already given?" is still asked from what the device knows. The log alone is
 * queued (create-only under the press's id); the pointer is left for readers to
 * combine. A course this device has not loaded cannot be given offline.
 */
async function giveDoseOffline(db: Firestore, input: GiveDoseInput, logId: string): Promise<GiveDoseResult> {
  const { householdId, petId, courseId } = input;
  const logRef = doc(logsRef(db, householdId, petId), logId);
  const [existing, courseSnapshot, cachedDoses] = await Promise.all([
    getDocFromCache(logRef).catch(() => null),
    getDocFromCache(courseRef(db, householdId, petId, courseId)).catch(() => null),
    getDocsFromCache(query(logsRef(db, householdId, petId), where('courseId', '==', courseId))).catch(() => null),
  ]);
  if (existing?.exists()) {
    if (existing.get('loggedByUid') !== input.user.uid) throw new MedicationActionError('conflict');
    return { status: 'queued', logId, occurrence: null, nextAfter: null, replayed: true };
  }
  const stored = courseSnapshot?.exists() ? readCourse(courseId, courseSnapshot.data()) : null;
  if (!stored) throw new MedicationActionError('offline');
  const doses = cachedDoses?.docs.map((entry) => ({ id: entry.id, ...entry.data() })) ?? [];
  const course = withRecords(stored, doseRecordsOf(courseId, doses));
  // Unknown here whether the latest dose was removed elsewhere: assume it stands (ask rather than double).
  const lastDoseSurvives = Boolean(course.lastDose);
  const now = new Date();
  const plan = planDose(
    { now, timeZone: input.timeZone, course, lastDoseSurvives, existing: null, offline: true },
    { userUid: input.user.uid, occurrenceKey: input.occurrenceKey, givenAt: input.givenAt, confirm: input.confirm },
  );
  if (plan.kind === 'already') return { status: 'queued', logId, occurrence: null, nextAfter: null, replayed: true };
  if (plan.kind === 'refused') throw new MedicationActionError(plan.reason);
  if (plan.kind === 'needsConfirm') return { status: 'needsConfirm', check: plan.check, staleConfirm: plan.staleConfirm };
  const backdated = Boolean(input.givenAt) && Math.abs(plan.givenAt.getTime() - now.getTime()) > 60_000;
  const batch = writeBatch(db);
  batch.set(logRef, doseLogData(input, course, plan, Timestamp.fromDate(plan.givenAt), Timestamp.fromMillis(plan.occurrence.at), backdated));
  const status = await awaitWriteUnlessOffline(batch.commit(), input.onLateError);
  return { status: status === 'saved' ? 'saved' : 'queued', logId, occurrence: plan.occurrence, nextAfter: plan.nextAfter };
}

/* ------------------------------------------------------------------------- */
/* Undo / delete a dose                                                       */
/* ------------------------------------------------------------------------- */


/**
 * Removes a dose record (the 10 s Undo and the history's delete) and keeps the
 * course's latest dose right in the same commit: when the course names this
 * dose, the previous one comes back (or the latest surviving dose, read from
 * the server); when a later dose by someone else is the latest, it stays.
 * Removing the record does not undo the dose itself (WT-20). Legacy and
 * one-off entries are deleted as before. Online only.
 */
export async function runUndoDose(db: Firestore, input: { householdId: string; petId: string; logId: string; onLateError?: (error: unknown) => void }): Promise<'saved' | 'already' | 'queued'> {
  const { householdId, petId, logId } = input;
  const logRef = doc(logsRef(db, householdId, petId), logId);
  if (isBrowserOffline()) {
    // Offline only an entry no course pointer can name is removed: a course dose
    // recorded offline, a one-off dose or a legacy entry. A course dose recorded
    // online may be the course's latest dose, which needs the pointer moved.
    const cached = await getDocFromCache(logRef).catch(() => null);
    const courseId = cached?.get('courseId');
    const courseDose = typeof courseId === 'string';
    if (!cached?.exists() || (courseDose && cached.get('repeat') !== 'offline')) throw new MedicationActionError('offline');
    if (courseDose) {
      // An online write may have made this offline dose the course's latest: then its pointer must move (online).
      const cachedCourse = await getDocFromCache(courseRef(db, householdId, petId, courseId)).catch(() => null);
      const pointer = cachedCourse?.exists() ? readDosePointer(cachedCourse.get('lastDose')) : null;
      if (!cachedCourse?.exists() || pointer?.logId === logId) throw new MedicationActionError('offline');
    }
    const batch = writeBatch(db);
    batch.delete(logRef);
    return awaitWriteUnlessOffline(batch.commit(), input.onLateError);
  }
  return settled(() => runTransaction(db, async (tx) => {
    const logSnapshot = await tx.get(logRef);
    if (!logSnapshot.exists()) return 'already' as const;
    const courseId = logSnapshot.get('courseId');
    if (typeof courseId !== 'string' || !courseId) {
      tx.delete(logRef);
      return 'saved' as const;
    }
    const cRef = courseRef(db, householdId, petId, courseId);
    const courseSnapshot = await tx.get(cRef);
    const raw = courseSnapshot.exists() ? courseSnapshot.data() : null;
    tx.delete(logRef);
    if (!raw) return 'saved' as const;
    // The pointer after the removal is the derived state of the surviving doses
    // (never just the remembered previous one): record 8:00, 12:00 early, a
    // confirmed 10:00, then remove 12:00, and 10:00 is the latest, not 8:00.
    const pointer = { coveredUntil: null, lastDose: readDosePointer(raw.lastDose), prevDose: readDosePointer(raw.prevDose) };
    const doses = await readCourseDoses(db, householdId, petId, courseId, logId);
    const next = pointerAfter(pointer, doses.records);
    if (next.write) {
      tx.update(cRef, { lastDose: storedPointer(next.latest, doses.stored), prevDose: storedPointer(next.prev, doses.stored) });
    }
    return 'saved' as const;
  }));
}

/* ------------------------------------------------------------------------- */
/* One-off dose (no course)                                                   */
/* ------------------------------------------------------------------------- */

/** Records a dose outside any course: history only, no schedule and no reminders. Idempotent per press. */
export async function runOneOffDose(db: Firestore, input: {
  householdId: string;
  petId: string;
  opId: string;
  medication: string;
  dosage: string;
  notes?: string;
  givenAt: Date | null;
  user: Actor;
  onLateError?: (error: unknown) => void;
}): Promise<'saved' | 'queued'> {
  const logRef = doc(logsRef(db, input.householdId, input.petId), doseLogId(input.opId));
  if (isBrowserOffline()) {
    // Queued on this device with its clock (as 2.1 allowed offline); a press already queued is not queued again.
    const cached = await getDocFromCache(logRef).catch(() => null);
    if (cached?.exists()) return 'queued';
    const now = Date.now();
    if (input.givenAt && input.givenAt.getTime() > now + 60_000) throw new MedicationActionError('future');
    if (input.givenAt && input.givenAt.getTime() < now - 7 * 24 * 3_600_000) throw new MedicationActionError('too-old');
    const chosen = Boolean(input.givenAt) && Math.abs(input.givenAt!.getTime() - now) > 60_000;
    const batch = writeBatch(db);
    batch.set(logRef, {
      oneOff: true,
      date: Timestamp.fromDate(input.givenAt ?? new Date(now)),
      loggedAt: serverTimestamp(),
      clockSource: 'device',
      medication: input.medication.trim(),
      dosage: input.dosage.trim(),
      notes: (input.notes ?? '').trim().slice(0, 2000),
      loggedByUid: input.user.uid,
      loggedByName: input.user.name,
      ...(chosen ? { backdated: true } : {}),
    });
    return awaitWriteUnlessOffline(batch.commit(), input.onLateError);
  }
  await runTransaction(db, async (tx) => {
    const existing = await tx.get(logRef);
    if (existing.exists()) {
      if (existing.get('loggedByUid') !== input.user.uid) throw new MedicationActionError('conflict');
      return;
    }
    const now = Date.now();
    if (input.givenAt && input.givenAt.getTime() > now + 60_000) throw new MedicationActionError('future');
    if (input.givenAt && input.givenAt.getTime() < now - 7 * 24 * 3_600_000) throw new MedicationActionError('too-old');
    const live = !input.givenAt || Math.abs(input.givenAt.getTime() - now) <= 60_000;
    tx.set(logRef, {
      oneOff: true,
      date: live ? serverTimestamp() : Timestamp.fromDate(input.givenAt!),
      loggedAt: serverTimestamp(),
      medication: input.medication.trim(),
      dosage: input.dosage.trim(),
      notes: (input.notes ?? '').trim().slice(0, 2000),
      loggedByUid: input.user.uid,
      loggedByName: input.user.name,
      ...(live ? {} : { backdated: true }),
    });
  });
  return 'saved';
}

/* ------------------------------------------------------------------------- */
/* Courses: create, edit, finish, resume                                      */
/* ------------------------------------------------------------------------- */

const scheduleData = (fields: CourseFields) => ({
  name: fields.name,
  dosage: fields.dosage,
  schedule: fields.schedule,
  startDay: fields.startDay,
  endDay: fields.endDay,
});

/**
 * Creates a course under `courseId` (generated once per form, so a retried
 * save never creates a second course), or edits an active one: name, dosage,
 * schedule, start and end. The course keeps its id and its dose history, so a
 * rename or correction never orphans logs or leaves a phantom course, and the
 * next dose is recomputed from the new schedule after the latest dose (no
 * duplicate future occurrence).
 */
export async function runSaveCourse(db: Firestore, input: {
  householdId: string;
  petId: string;
  courseId: string;
  fields: CourseFields;
  user: Actor;
  /** Creating: the course is new (refused if the id exists with other content). */
  create: boolean;
  /** Legacy names this new course takes over (D-P8 confirmation). */
  legacyKeys?: string[];
  timeZone?: string | null;
}): Promise<'saved' | 'already'> {
  if (isBrowserOffline()) throw new MedicationActionError('offline');
  const ref = courseRef(db, input.householdId, input.petId, input.courseId);
  return settled(() => runTransaction(db, async (tx) => {
    const snapshot = await tx.get(ref);
    if (input.create) {
      if (snapshot.exists()) return 'already' as const;
      tx.set(ref, {
        ...scheduleData(input.fields),
        status: 'active',
        legacyKeys: input.legacyKeys ?? [],
        lastDose: null,
        prevDose: null,
        coveredUntil: null,
        createdAt: serverTimestamp(),
        createdByUid: input.user.uid,
        createdByName: input.user.name,
        updatedAt: serverTimestamp(),
        updatedByUid: input.user.uid,
        updatedByName: input.user.name,
      });
      return 'saved' as const;
    }
    if (!snapshot.exists()) throw new MedicationActionError('missing');
    if (snapshot.get('status') !== 'active') throw new MedicationActionError('not-active');
    const read = readCourse(input.courseId, snapshot.data());
    // The coverage comes from the surviving doses (an offline-synced dose
    // included), the same derived state the form's preview shows.
    const doses = read ? await readCourseDoses(db, input.householdId, input.petId, input.courseId) : null;
    const stored = read && doses ? withRecords(read, doses.records) : read;
    // A schedule change may count the new occurrence that replaces the one last
    // given (8:00 AM given, moved to 9:00 AM), so it is not due again.
    const moved = stored && scheduleChanged(stored, input.fields);
    const coveredUntil = moved ? coverageAfterEdit(stored, input.fields, householdDayZone(input.timeZone)) : undefined;
    tx.update(ref, {
      ...scheduleData(input.fields),
      ...(moved ? { coveredUntil: coveredUntil === null || coveredUntil === undefined ? null : Timestamp.fromMillis(coveredUntil) } : {}),
      updatedAt: serverTimestamp(),
      updatedByUid: input.user.uid,
      updatedByName: input.user.name,
    });
    return 'saved' as const;
  }));
}

/**
 * Finishes a course: its countdown, chips, Calendar occurrences and reminders
 * end (the hourly upkeep resolves an open reminder and creates no new one);
 * its history stays. Idempotent.
 */
export async function runFinishCourse(db: Firestore, input: { householdId: string; petId: string; courseId: string; user: Actor }): Promise<'saved' | 'already'> {
  if (isBrowserOffline()) throw new MedicationActionError('offline');
  const ref = courseRef(db, input.householdId, input.petId, input.courseId);
  return settled(() => runTransaction(db, async (tx) => {
    const snapshot = await tx.get(ref);
    if (!snapshot.exists()) throw new MedicationActionError('missing');
    if (snapshot.get('status') === 'finished') return 'already' as const;
    tx.update(ref, { status: 'finished', finishedAt: serverTimestamp(), finishedByUid: input.user.uid, finishedByName: input.user.name });
    return 'saved' as const;
  }));
}

/** Undo of Finish (its 10 s toast): the course is active again, with its schedule and history. */
export async function runResumeCourse(db: Firestore, input: { householdId: string; petId: string; courseId: string }): Promise<'saved' | 'already'> {
  if (isBrowserOffline()) throw new MedicationActionError('offline');
  const ref = courseRef(db, input.householdId, input.petId, input.courseId);
  return settled(() => runTransaction(db, async (tx) => {
    const snapshot = await tx.get(ref);
    if (!snapshot.exists()) throw new MedicationActionError('missing');
    if (snapshot.get('status') === 'active') return 'already' as const;
    if (!snapshot.get('schedule')) throw new MedicationActionError('not-active');
    tx.update(ref, { status: 'active', finishedAt: null, finishedByUid: null, finishedByName: null });
    return 'saved' as const;
  }));
}

/* ------------------------------------------------------------------------- */
/* Legacy medication (D-P8): confirm, finish, merge                           */
/* ------------------------------------------------------------------------- */

/**
 * Confirms a schedule for a legacy (name-keyed) medication: creates its
 * course under `legacyCourseId(key)` (one id per legacy name, so two members
 * confirming at once write one course) with `legacyKeys: [key]`. From then on
 * the course drives the countdown and reminders and the legacy entries are
 * history. Nothing changes until a member does this (no silent conversion).
 */
export async function runConfirmLegacy(db: Firestore, input: {
  householdId: string;
  petId: string;
  key: string;
  fields: CourseFields;
  user: Actor;
}): Promise<{ status: 'saved' | 'already'; courseId: string }> {
  const courseId = legacyCourseId(input.key);
  const status = await runSaveCourse(db, { ...input, courseId, create: true, legacyKeys: [input.key] });
  return { status, courseId };
}

/**
 * Finishes a legacy medication without a schedule ("no more doses"): a
 * finished course record takes its name over, so its stale countdown and
 * reminders end and its entries stay as history.
 */
export async function runFinishLegacy(db: Firestore, input: {
  householdId: string;
  petId: string;
  key: string;
  name: string;
  dosage: string;
  user: Actor;
  timeZone?: string | null;
}): Promise<'saved' | 'already'> {
  if (isBrowserOffline()) throw new MedicationActionError('offline');
  const ref = courseRef(db, input.householdId, input.petId, legacyCourseId(input.key));
  return settled(() => runTransaction(db, async (tx) => {
    const snapshot = await tx.get(ref);
    if (snapshot.exists()) return 'already' as const;
    tx.set(ref, {
      name: input.name.trim().slice(0, 80) || input.key.slice(0, 80),
      dosage: input.dosage.trim().slice(0, 80),
      schedule: null,
      startDay: petDay(new Date(), input.timeZone),
      endDay: null,
      status: 'finished',
      legacyKeys: [input.key],
      lastDose: null,
      prevDose: null,
      coveredUntil: null,
      createdAt: serverTimestamp(),
      createdByUid: input.user.uid,
      createdByName: input.user.name,
      finishedAt: serverTimestamp(),
      finishedByUid: input.user.uid,
      finishedByName: input.user.name,
    });
    return 'saved' as const;
  }));
}

/**
 * Merges a legacy name into an existing course (a typo such as "Apoquell"
 * next to "Apoquel"; manual only): the course takes the name over, so its
 * stale countdown and reminders end. The entries keep their own name in
 * history.
 */
export async function runMergeLegacy(db: Firestore, input: {
  householdId: string;
  petId: string;
  key: string;
  courseId: string;
  user: Actor;
}): Promise<'saved' | 'already'> {
  if (isBrowserOffline()) throw new MedicationActionError('offline');
  const ref = courseRef(db, input.householdId, input.petId, input.courseId);
  return settled(() => runTransaction(db, async (tx) => {
    const snapshot = await tx.get(ref);
    if (!snapshot.exists()) throw new MedicationActionError('missing');
    if (snapshot.get('status') !== 'active') throw new MedicationActionError('not-active');
    const keys: string[] = Array.isArray(snapshot.get('legacyKeys')) ? snapshot.get('legacyKeys') : [];
    if (keys.includes(input.key)) return 'already' as const;
    tx.update(ref, {
      legacyKeys: [...keys, input.key],
      updatedAt: serverTimestamp(),
      updatedByUid: input.user.uid,
      updatedByName: input.user.name,
    });
    return 'saved' as const;
  }));
}
