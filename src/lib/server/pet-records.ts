import 'server-only';

import { randomUUID } from 'node:crypto';
import {
  FieldValue,
  Timestamp,
  type CollectionReference,
  type DocumentData,
  type DocumentReference,
  type DocumentSnapshot,
  type Firestore,
  type Transaction,
} from 'firebase-admin/firestore';
import { isDocId } from '@functions/shared/push-media';
import { localMinutes } from '@functions/shared/calendar';
import { publicDisplayName } from '@/lib/member-directory';
import {
  coveredUntilAfterSave,
  doseLogId,
  doseRecordsOf,
  legacyCourseId,
  legacyMedicationKey,
  occurrenceByKey,
  planDose,
  pointerAfter,
  readCourse,
  scheduleChanged,
  validateCourseForm,
  withRecords,
  DOSE_BACKDATE_MAX_MS,
  DOSE_FUTURE_SLACK_MS,
  type CourseFields,
  type CourseFormValues,
  type DoseConfirm,
  type DosePointer,
  type DoseRefusal,
  type Occurrence,
} from '@/lib/pets/medication-course';
import { noteCreateFields, noteDate, recordDocId, validateNoteDraft, NOTE_TAGS, type NoteTag } from '@/lib/pets/notes';
import { validateWeightDraft, isWeightUnit, type WeightUnit } from '@/lib/pets/weights';
import { mayDeleteNote, mayDeleteWeight, mayEditNote, AUTHOR_DELETE_WINDOW_MS, type ActorPermissions } from '@/lib/pets/pet-actions';
import { mayMedication } from '@/lib/pets/medication-permissions';
import { checkFeedCorrection, mayCorrectFeedTime, planFeedCorrection, planFeedDelete, type StateLog } from '@/lib/pets/feed-plan';
import { FEEDING_STATE_ID, householdDay, householdDayStart, readFeedingState } from '@/lib/pets/feed-decision';
import { feedStateDocument } from '@/lib/pets/feed-documents';
import { confirmMealPlan, slotsFromDraft, validateMealDraft, type MealSlotDraft } from '@/lib/pets/meal-plan';
import { duplicatePetName } from '@/lib/pets/profile';
import { PORTION_UNITS, type PetProfile, type PortionUnit } from '@/lib/pets/types';
import type { OperationContext } from '@/lib/server/operation-context';
import { DeviceActionError } from '@/lib/server/device-errors';
import { assertActorRule, type DeviceAuthority } from '@/lib/server/device-gate';
import { assertUndoable, createdRecordUnchanged, type DeviceOp } from '@/lib/server/device-ops';
import {
  ADMIN_TIMES,
  PetFeedingError,
  householdRef,
  optionalPetId,
  petIdOf,
  readHousehold,
  stateFeedings,
  undoContext,
  type FeedAsOptions,
  type PetUndoOutcome,
} from '@/lib/server/pet-feeding';

// The rest of the Pets device actions (F4b-2; docs/modules/devices/README.md, "Device
// actions: pets (F4b-2)"; design 8.2, 9, 10, 11, 20 R1-R6). Each runs as the operation's
// actor in ONE Admin SDK transaction, in the order of `operation-context.ts`: the gate's
// precheck first (a replay of the same opId returns the stored result and writes nothing),
// then the reads, then the writes, then finalize (op ledger, PIN-session slide, and the
// `device.action` activity entry for PIN-level actions). The decisions are the pure ones the
// personal paths use (`planDose`, `pointerAfter`, `validateCourseForm`, `noteCreateFields`,
// `validateWeightDraft`, `mayEditNote`/`mayDeleteNote`/`mayDeleteWeight`,
// `checkFeedCorrection`/`planFeedCorrection`, `confirmMealPlan`, `duplicatePetName`), and
// every write is a document the rules would accept from the person's own client (Admin
// writes bypass the rules, so `tests/server/device-pets-records.test.ts` replays them through
// the rules as that person), plus the server-only `deviceAttribution` on created records.

type DeviceCtx = OperationContext & { authority?: DeviceAuthority };
type ActorFacts = { uid: string; permissions: ActorPermissions };

const ID = /^[A-Za-z0-9_-]{1,128}$/;
const OCCURRENCE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}(T([01][0-9]|2[0-3]):[0-5][0-9])?$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const LATEST_DOSES = 6;

const nameOf = (snap: DocumentSnapshot): string | null => (typeof snap.get('name') === 'string' ? (snap.get('name') as string) : null);
const toMillis = (value: unknown): number | null => {
  if (value instanceof Timestamp) return value.toMillis();
  if (value instanceof Date) return value.getTime();
  return null;
};
const docIdOf = (value: unknown): string => {
  if (!isDocId(value)) throw new PetFeedingError('invalid');
  return value;
};
/** The device actor with its effective permissions (re-checked by precheck). */
const actorFacts = (ctx: DeviceCtx): ActorFacts => {
  const actor = undoContext(ctx).actor;
  if (!actor) throw new DeviceActionError('actor_required');
  return { uid: actor.uid, permissions: actor.permissions };
};
const authorName = (ctx: OperationContext) => publicDisplayName(ctx.actor.name, 'Someone');
const deviceExtra = (ctx: OperationContext) => (ctx.actor.device ? { deviceAttribution: ctx.actor.device } : {});

/** A chosen earlier time (ISO), at most a minute ahead of the server; null when absent. */
const chosenTime = (value: unknown, now: Date): Date | null => {
  if (value === undefined || value === null || value === '') return null;
  const at = typeof value === 'string' ? new Date(value) : null;
  if (!at || Number.isNaN(at.getTime()) || at.getTime() <= 0) throw new PetFeedingError('invalid');
  if (at.getTime() > now.getTime() + DOSE_FUTURE_SLACK_MS) throw new PetFeedingError('invalid');
  return at;
};
export const doseGivenAtOf = chosenTime;

/* ------------------------------------------------------------------------- */
/* Doses (pets.dose.give, .old, pets.dose.undo)                               */
/* ------------------------------------------------------------------------- */

/** The Admin twin of `readCourseDoses` (medication-transaction.ts): the newest doses and every one tied at the cutoff occurrence. */
async function courseDoses(tx: Transaction, logs: CollectionReference, courseId: string, excludeId?: string) {
  const newest = await tx.get(logs.where('courseId', '==', courseId).orderBy('occurrenceAt', 'desc').limit(LATEST_DOSES));
  const docs = [...newest.docs];
  const cutoff = docs.length >= LATEST_DOSES ? docs[docs.length - 1].get('occurrenceAt') : undefined;
  if (cutoff !== undefined && cutoff !== null) {
    const seen = new Set(docs.map((entry) => entry.id));
    const tied = await tx.get(logs.where('courseId', '==', courseId).where('occurrenceAt', '==', cutoff));
    for (const entry of tied.docs) if (!seen.has(entry.id)) docs.push(entry);
  }
  const stored = new Map<string, DocumentData>();
  const list = docs.filter((entry) => entry.id !== excludeId).map((entry) => {
    stored.set(entry.id, entry.data());
    return { id: entry.id, ...entry.data() };
  });
  return { records: doseRecordsOf(courseId, list), stored };
}

/** A pointer as written: the stored values of its log (the Admin twin of `storedPointer`). */
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

/**
 * Every online dose write from a tablet goes through here (a dose created, an Undo, an older
 * dose deleted): the log, and the course's pointer when it moves. One place, so a course
 * field every dose write must also touch (P3's planned course revision) is added once.
 */
function writeDose(
  tx: Transaction,
  write: { log: { ref: DocumentReference; data: Record<string, unknown> } | { ref: DocumentReference; delete: true }; course?: { ref: DocumentReference; pointer: DocumentData | null } | null },
) {
  if ('delete' in write.log) tx.delete(write.log.ref);
  else tx.set(write.log.ref, write.log.data);
  if (write.course?.pointer) tx.update(write.course.ref, write.course.pointer);
}

const plainOccurrence = (occurrence: Occurrence | null) =>
  (occurrence ? { key: occurrence.key, day: occurrence.day, time: occurrence.time ?? null, at: occurrence.at } : null);

export type DoseAsInput = {
  petId: unknown;
  courseId: unknown;
  occurrenceKey: unknown;
  /** A chosen earlier given-at time (ISO); absent = now. */
  givenAt?: unknown;
  notes?: unknown;
  /** The answer to "Already given?": the dose it named. */
  confirm?: unknown;
};

type PlainOccurrence = { key: string; day: string; time: string | null; at: number };

/** What a tablet (or a retry) receives: JSON-safe, names only, no emails. */
export type DoseAsResult =
  | {
      status: 'needsConfirm';
      staleConfirm: boolean;
      /** The `DoseCheck` the personal dialog shows (`doseRepeatReason`): the latest dose named and the occurrence. */
      check: { last: DosePointer | null; occurrence: PlainOccurrence; reason: 'given' | 'moved' | 'recent' };
    }
  | { status: 'refused'; reason: DoseRefusal }
  | {
      status: 'saved';
      petId: string;
      courseId: string;
      logId: string;
      occurrence: PlainOccurrence | null;
      nextAfter: PlainOccurrence | null;
      /** From the offline queue: recorded at the device's time, not checked against other doses. */
      offline?: true;
      replayed?: true;
    };

const confirmOf = (value: unknown): DoseConfirm | null => {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object') throw new PetFeedingError('invalid');
  const raw = (value as { lastLogId?: unknown }).lastLogId;
  if (raw === null) return { lastLogId: null };
  if (typeof raw !== 'string' || !ID.test(raw)) throw new PetFeedingError('invalid');
  return { lastLogId: raw };
};

const notesOf = (value: unknown, max = 2000): string => {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string' || value.length > max) throw new PetFeedingError('invalid');
  return value.trim();
};

/**
 * Gives a dose of a course as the actor (`pets.dose.give`, or `.old` for a given-at time
 * older than 12 hours, picked by the server): the Admin twin of `runGiveDose`. Precheck,
 * then this press's log (id = opId), the course, whether its latest dose survives and its
 * newest doses (ties at the cutoff included), then `planDose`: "Already given?" (or an
 * early dose) is answered `needsConfirm` with the dose it names (nothing written, no ledger
 * entry); the answer comes back with the same opId and is bound to that dose (a newer dose
 * since: asked again with `staleConfirm`). Otherwise the log credited to the actor and the
 * course's pointer derived from the surviving doses (`pointerAfter`), as the personal path.
 * A queued replay is recorded at the device's time as an offline dose (`repeat: 'offline'`,
 * `clockSource: 'device'`, no pointer write, never asked), as the personal offline path.
 */
export async function giveDoseAs(db: Firestore, householdId: string, input: DoseAsInput, ctx: OperationContext, options: FeedAsOptions = {}): Promise<DoseAsResult> {
  const house = householdRef(db, householdId);
  if (!input || typeof input !== 'object') throw new PetFeedingError('invalid');
  const petId = petIdOf(input.petId);
  const courseId = docIdOf(input.courseId);
  if (typeof input.occurrenceKey !== 'string' || !OCCURRENCE.test(input.occurrenceKey)) throw new PetFeedingError('invalid');
  const occurrenceKey = input.occurrenceKey;
  const givenAt = chosenTime(input.givenAt, ctx.now);
  const notes = notesOf(input.notes);
  const confirm = confirmOf(input.confirm);
  const logId = doseLogId(ctx.opId ?? randomUUID());
  const pet = house.collection('pets').doc(petId);
  const logs = pet.collection('medication-logs');
  const logRef = logs.doc(logId);
  const courseRef = pet.collection('medication-courses').doc(courseId);
  return db.runTransaction(async (tx) => {
    const { replay } = (await ctx.hooks?.precheck(tx)) ?? {};
    if (replay) {
      // The same opId for another pet or course is a different action: never its answer (review S3).
      if (replay.targetPath !== logRef.path) throw new PetFeedingError('conflict');
      return { ...(replay.summary.result as DoseAsResult), replayed: true } as DoseAsResult;
    }
    const timeZone = await readHousehold(tx, house);
    const [existing, petSnap, courseSnap] = await Promise.all([tx.get(logRef), tx.get(pet), tx.get(courseRef)]);
    if (!petSnap.exists) throw new PetFeedingError('not-found');
    const actor = ctx.actor;
    const now = ctx.now;
    const byName = authorName(ctx);
    const course = courseSnap.exists ? readCourse(courseId, courseSnap.data() ?? {}) : null;
    const finalize = (result: DoseAsResult) => {
      ctx.hooks?.finalize(tx, { targetPath: logRef.path, summary: { result }, targetName: nameOf(petSnap) });
      return result;
    };

    if (options.queuedAt) {
      // Offline on the tablet (11.3): it happened, so it is never asked; the device's clock
      // is recorded as such and the pointer is left to readers (`withOfflineDoses`).
      if (existing.exists) {
        if (existing.get('loggedByUid') !== actor.uid) throw new PetFeedingError('conflict');
        return finalize({ status: 'saved', petId, courseId, logId, occurrence: null, nextAfter: null, offline: true, replayed: true });
      }
      if (!course) return { status: 'refused', reason: 'missing' };
      if (!course.schedule) return { status: 'refused', reason: 'finished' };
      const occurrence = occurrenceByKey({ schedule: course.schedule, startDay: course.startDay, endDay: course.endDay }, occurrenceKey, timeZone);
      if (!occurrence) return { status: 'refused', reason: 'occurrence' };
      const at = givenAt ?? options.queuedAt;
      if (at.getTime() < now.getTime() - DOSE_BACKDATE_MAX_MS) return { status: 'refused', reason: 'too-old' };
      // An offline dose: the log alone (readers combine it with the course), as the personal offline path.
      writeDose(tx, { log: { ref: logRef, data: {
        courseId,
        occurrence: occurrence.key,
        occurrenceAt: Timestamp.fromMillis(occurrence.at),
        date: Timestamp.fromDate(at),
        loggedAt: FieldValue.serverTimestamp(),
        medication: course.name,
        dosage: course.dosage,
        notes,
        loggedByUid: actor.uid,
        loggedByName: byName,
        repeat: 'offline',
        clockSource: 'device',
        ...(givenAt ? { backdated: true } : {}),
        ...deviceExtra(ctx),
      } } });
      return finalize({ status: 'saved', petId, courseId, logId, occurrence: plainOccurrence(occurrence), nextAfter: null, offline: true });
    }

    const lastLogId = course?.lastDose?.logId ?? null;
    const lastDoseSurvives = lastLogId ? (await tx.get(logs.doc(lastLogId))).exists : false;
    const doses = course ? await courseDoses(tx, logs, courseId) : null;
    const plan = planDose(
      {
        now, timeZone, course: course && doses ? withRecords(course, doses.records) : course, lastDoseSurvives,
        existing: existing.exists ? { loggedByUid: (existing.get('loggedByUid') as string | undefined) ?? null, courseId: (existing.get('courseId') as string | undefined) ?? null } : null,
      },
      { userUid: actor.uid, occurrenceKey, givenAt, confirm },
    );
    if (plan.kind === 'already') return finalize({ status: 'saved', petId, courseId, logId, occurrence: null, nextAfter: null, replayed: true });
    if (plan.kind === 'refused') {
      if (plan.reason === 'conflict') throw new PetFeedingError('conflict');
      // Nothing written and no ledger entry: the tablet says why.
      return { status: 'refused', reason: plan.reason };
    }
    if (plan.kind === 'needsConfirm') {
      const last = plan.check.last ? { ...plan.check.last, byName: publicDisplayName(plan.check.last.byName, '') || null } : null;
      return { status: 'needsConfirm', staleConfirm: plan.staleConfirm, check: { last, occurrence: plainOccurrence(plan.check.occurrence)!, reason: plan.check.reason } };
    }
    const given = plan.live ? FieldValue.serverTimestamp() : Timestamp.fromDate(plan.givenAt);
    const occurrenceAt = Timestamp.fromMillis(plan.occurrence.at);
    const logData = {
      courseId,
      occurrence: plan.occurrence.key,
      occurrenceAt,
      date: given,
      loggedAt: FieldValue.serverTimestamp(),
      medication: course!.name,
      dosage: course!.dosage,
      notes,
      loggedByUid: actor.uid,
      loggedByName: byName,
      repeat: plan.repeat,
      ...(plan.repeat === 'confirmed' ? { confirmOf: plan.confirmOf } : {}),
      ...(plan.live ? {} : { backdated: true }),
      ...deviceExtra(ctx),
    };
    // The pointer is the derived state after this dose, exactly as the personal path writes it.
    const fresh: DosePointer = { logId, occurrence: plan.occurrence.key, occurrenceAt: plan.occurrence.at, givenAt: plan.givenAt.getTime(), byUid: actor.uid, byName };
    const next = pointerAfter(course!, [...doses!.records, fresh]);
    const freshValue = { logId, occurrence: plan.occurrence.key, occurrenceAt, givenAt: given, byUid: actor.uid, byName };
    writeDose(tx, {
      log: { ref: logRef, data: logData },
      course: {
        ref: courseRef,
        pointer: next.write
          ? { lastDose: storedPointer(next.latest, doses!.stored, { logId, value: freshValue }), prevDose: storedPointer(next.prev, doses!.stored, { logId, value: freshValue }) }
          : null,
      },
    });
    return finalize({ status: 'saved', petId, courseId, logId, occurrence: plainOccurrence(plan.occurrence), nextAfter: plainOccurrence(plan.nextAfter) });
  });
}

/* ------------------------------------------------------------------------- */
/* Notes and weights (pets.note.add, pets.weight.add)                         */
/* ------------------------------------------------------------------------- */

export type NoteAsInput = { petId: unknown; text: unknown; tag?: unknown; day?: unknown; pinned?: unknown };
export type RecordAsResult =
  | { status: 'added'; petId: string; recordId: string; replayed?: true }
  | { status: 'refused'; reason: 'invalid'; errors: Record<string, string> };

/** Creates a record under the opId once; a retry by the same person finds it (no second record). */
async function createRecordOnce(
  db: Firestore,
  householdId: string,
  ctx: OperationContext,
  petId: string,
  collection: 'notes' | 'weights',
  build: (timeZone: string, now: Date) => { data: Record<string, unknown> } | { errors: Record<string, string> },
  options: FeedAsOptions,
): Promise<RecordAsResult> {
  const house = householdRef(db, householdId);
  const recordId = recordDocId(ctx.opId ?? randomUUID());
  const pet = house.collection('pets').doc(petId);
  const ref = pet.collection(collection).doc(recordId);
  return db.runTransaction(async (tx) => {
    const { replay } = (await ctx.hooks?.precheck(tx)) ?? {};
    if (replay) {
      if (replay.targetPath !== ref.path) throw new PetFeedingError('conflict');
      return { ...(replay.summary.result as RecordAsResult), replayed: true } as RecordAsResult;
    }
    const timeZone = await readHousehold(tx, house);
    const [existing, petSnap] = await Promise.all([tx.get(ref), tx.get(pet)]);
    if (!petSnap.exists) throw new PetFeedingError('not-found');
    if (existing.exists && existing.get('loggedByUid') !== ctx.actor.uid) throw new PetFeedingError('conflict');
    // A queued replay is dated by the device's clock (at most the gate's 5 minutes ahead).
    const built = build(timeZone, options.queuedAt ?? ctx.now);
    if ('errors' in built) return { status: 'refused', reason: 'invalid', errors: built.errors };
    const result: RecordAsResult = { status: 'added', petId, recordId, ...(existing.exists ? { replayed: true as const } : {}) };
    if (!existing.exists) {
      tx.set(ref, { ...built.data, loggedAt: FieldValue.serverTimestamp(), loggedByUid: ctx.actor.uid, loggedByName: authorName(ctx), ...deviceExtra(ctx) });
    }
    ctx.hooks?.finalize(tx, { targetPath: ref.path, summary: { result }, targetName: nameOf(petSnap) });
    return result;
  });
}

const tagOf = (value: unknown): NoteTag | '' => {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string' || !(NOTE_TAGS as readonly string[]).includes(value)) throw new PetFeedingError('invalid');
  return value as NoteTag;
};
const dayOf = (value: unknown): string => {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string' || !DAY.test(value)) throw new PetFeedingError('invalid');
  return value;
};

/**
 * A dated behaviour entry as the actor (`pets.note.add`): the shape `runCreateNote` writes
 * (`noteCreateFields`, `noteDate` in the household's zone, `loggedAt` at server time), id =
 * opId. Pinned notes are profile facts: pinning is `pets.note.pin` (PIN, JC-14), so a pinned
 * add is refused here.
 */
export async function addNoteAs(db: Firestore, householdId: string, input: NoteAsInput, ctx: OperationContext, options: FeedAsOptions = {}): Promise<RecordAsResult> {
  if (!input || typeof input !== 'object' || (input.pinned !== undefined && input.pinned !== false)) throw new PetFeedingError('invalid');
  const petId = petIdOf(input.petId);
  if (typeof input.text !== 'string' || input.text.length > 2000) throw new PetFeedingError('invalid');
  const draft = { text: input.text, tag: tagOf(input.tag), pinned: false, day: dayOf(input.day) };
  return createRecordOnce(db, householdId, ctx, petId, 'notes', (timeZone, at) => {
    const errors = validateNoteDraft(draft, householdDay(at, timeZone));
    if (Object.keys(errors).length > 0) return { errors: errors as Record<string, string> };
    const fields = noteCreateFields(draft, { uid: ctx.actor.uid, name: authorName(ctx) }, noteDate(draft, at, timeZone));
    return { data: { ...fields, date: Timestamp.fromDate(fields.date) } };
  }, options);
}

export type WeightAsInput = { petId: unknown; value: unknown; unit: unknown; day?: unknown };

/** A weighing as the actor (`pets.weight.add`): the shape `runCreateWeight` writes, id = opId. */
export async function addWeightAs(db: Firestore, householdId: string, input: WeightAsInput, ctx: OperationContext, options: FeedAsOptions = {}): Promise<RecordAsResult> {
  if (!input || typeof input !== 'object') throw new PetFeedingError('invalid');
  const petId = petIdOf(input.petId);
  if (typeof input.value !== 'number' || !Number.isFinite(input.value) || !isWeightUnit(input.unit)) throw new PetFeedingError('invalid');
  const unit: WeightUnit = input.unit;
  const value = input.value;
  const day = dayOf(input.day);
  return createRecordOnce(db, householdId, ctx, petId, 'weights', (timeZone, at) => {
    const errors = validateWeightDraft({ value: String(value), unit, day }, householdDay(at, timeZone));
    if (Object.keys(errors).length > 0) return { errors: errors as Record<string, string> };
    // The weighing's effective time: now for today, noon (household time) of an earlier day (as weight-card.tsx).
    return { data: { value, unit, date: Timestamp.fromDate(noteDate({ pinned: false, day }, at, timeZone)) } };
  }, options);
}

/* ------------------------------------------------------------------------- */
/* Undo of a created record (dose, note, weight)                              */
/* ------------------------------------------------------------------------- */

type UndoCollection = 'medication-logs' | 'notes' | 'weights';

/** The record a ledger entry points at: `households/h/pets/<pet>/<collection>/<id>`. */
const recordOfEntry = (house: DocumentReference, entry: DeviceOp, collection: UndoCollection, petId: string | null) => {
  const prefix = `${house.path}/pets/`;
  const rest = entry.targetPath?.startsWith(prefix) ? entry.targetPath.slice(prefix.length).split('/') : [];
  if (rest.length !== 3 || rest[1] !== collection || !isDocId(rest[0]) || !isDocId(rest[2])) throw new DeviceActionError('not_undoable');
  if (petId !== null && rest[0] !== petId) throw new DeviceActionError('invalid_input');
  const pet = house.collection('pets').doc(rest[0]);
  return { pet, record: pet.collection(collection).doc(rest[2]) };
};

/**
 * The Undo of a tablet's dose, note or weighing, by the original's opId (design 10.1-10.2),
 * as `undoFeedAs`: no ledger entry yet → a tombstone (`not_applied`); already undone →
 * `already`; applied → the same tablet generation, the original person (or at PIN level a
 * holder of pets.deleteLogs), inside the window, and the record unchanged since it was
 * created (`changed_since`: an edit, a pin, a delete by anyone). A dose's Undo moves the
 * course's pointer off it in the same commit (`pointerAfter` over the surviving doses),
 * so a later dose by anyone stays the latest.
 */
async function undoCreatedRecord(db: Firestore, householdId: string, input: { petId?: unknown; opId?: unknown }, ctx: DeviceCtx, collection: UndoCollection): Promise<PetUndoOutcome> {
  const house = householdRef(db, householdId);
  const authority = undoContext(ctx);
  if (input?.opId !== undefined && input.opId !== ctx.opId) throw new DeviceActionError('invalid_input');
  const petId = optionalPetId(input?.petId);
  return db.runTransaction(async (tx) => {
    const plan = await ctx.hooks!.precheck(tx);
    if (plan.undo === 'already') return { status: 'already', petId: null, logId: null };
    if (plan.undo === 'tombstone' || !plan.original) {
      ctx.hooks!.finalize(tx, { targetPath: '', summary: {}, undo: 'tombstone' });
      return { status: 'not_applied', petId: null, logId: null };
    }
    const original = plan.original;
    const actor = authority.actor!;
    assertActorRule(authority, original.actorUid);
    assertUndoable(original, {
      generation: authority.generation, actorUid: actor.uid, now: authority.now,
      actorRuleAllows: actor.uid !== original.actorUid,
      queuedUndo: authority.queued, queuedUndoCreatedAt: authority.queuedCreatedAt,
    });
    // A replayed or refused action recorded nothing new: its Undo never removes a record it did not write.
    const stored = original.summary.result as { replayed?: unknown; status?: unknown } | undefined;
    if (stored?.replayed === true || (stored?.status !== 'saved' && stored?.status !== 'added')) return { status: 'already', petId: null, logId: null };
    const { pet, record } = recordOfEntry(house, original, collection, petId);
    const [snap, petSnap] = await Promise.all([tx.get(record), tx.get(pet)]);
    if (!createdRecordUnchanged(snap)) throw new DeviceActionError('changed_since');
    // The record this tablet wrote for this person, not another one recreated under the same id (review S3).
    const attribution = snap.get('deviceAttribution') as { deviceId?: unknown } | undefined;
    if (snap.get('loggedByUid') !== original.actorUid || attribution?.deviceId !== authority.deviceId) throw new DeviceActionError('changed_since');
    let pointer: { ref: DocumentReference; value: DocumentData } | null = null;
    const courseId = collection === 'medication-logs' ? snap.get('courseId') : null;
    if (typeof courseId === 'string' && isDocId(courseId)) {
      const courseRef = pet.collection('medication-courses').doc(courseId);
      const courseSnap = await tx.get(courseRef);
      const course = courseSnap.exists ? readCourse(courseId, courseSnap.data() ?? {}) : null;
      if (course) {
        const doses = await courseDoses(tx, pet.collection('medication-logs'), courseId, record.id);
        const next = pointerAfter(course, doses.records);
        if (next.write) pointer = { ref: courseRef, value: { lastDose: storedPointer(next.latest, doses.stored), prevDose: storedPointer(next.prev, doses.stored) } };
      }
    }
    if (collection === 'medication-logs') writeDose(tx, { log: { ref: record, delete: true }, course: pointer ? { ref: pointer.ref, pointer: pointer.value } : null });
    else tx.delete(record);
    ctx.hooks!.finalize(tx, { targetPath: record.path, summary: { petId: pet.id, logId: record.id }, undo: 'reversed', targetName: nameOf(petSnap) });
    return { status: 'undone', petId: pet.id, logId: record.id };
  });
}

export const undoDoseAs = (db: Firestore, householdId: string, input: { petId?: unknown; opId?: unknown }, ctx: DeviceCtx) => undoCreatedRecord(db, householdId, input, ctx, 'medication-logs');
export const undoNoteAs = (db: Firestore, householdId: string, input: { petId?: unknown; opId?: unknown }, ctx: DeviceCtx) => undoCreatedRecord(db, householdId, input, ctx, 'notes');
export const undoWeightAs = (db: Firestore, householdId: string, input: { petId?: unknown; opId?: unknown }, ctx: DeviceCtx) => undoCreatedRecord(db, householdId, input, ctx, 'weights');

/* ------------------------------------------------------------------------- */
/* PIN-level actions (JC-14, D-P6)                                            */
/* ------------------------------------------------------------------------- */

/** A PIN-level answer: done, nothing to do, or refused for a reason the tablet words. */
export type PetPinResult =
  | { status: 'saved' | 'deleted'; petId: string; replayed?: true; courseId?: string }
  | { status: 'already'; petId: string; replayed?: true }
  | { status: 'refused'; reason: string; errors?: Record<string, string> };

type PinBody = {
  /** The changed record (ledger and activity). */
  targetPath: string;
  result: PetPinResult;
  /** Writes only; run after every read. */
  write?: (tx: Transaction) => void;
};

/**
 * One PIN-level Pets action in one transaction: precheck (a replay returns the stored
 * answer), the household and the pet, the action's own reads (`body`), its writes, then
 * finalize, which also writes the `device.action` activity entry for the PIN-level actor.
 * A refusal writes nothing (no ledger entry: the same press may be tried again).
 */
async function pinPetAction(db: Firestore, householdId: string, petIdInput: unknown, ctx: DeviceCtx, targetOf: (pet: DocumentReference) => DocumentReference, body: (tx: Transaction, scope: { pet: DocumentReference; petSnap: DocumentSnapshot; timeZone: string; actor: ActorFacts; now: Date }) => Promise<PinBody>): Promise<PetPinResult> {
  const house = householdRef(db, householdId);
  undoContext(ctx);
  const petId = petIdOf(petIdInput);
  const pet = house.collection('pets').doc(petId);
  // The record this request acts on, known before any read: a replay of the same opId for another record is a conflict (review S3).
  const target = targetOf(pet).path;
  return db.runTransaction(async (tx) => {
    const { replay } = (await ctx.hooks!.precheck(tx)) ?? {};
    if (replay) {
      if (replay.targetPath !== target) throw new PetFeedingError('conflict');
      return { ...(replay.summary.result as PetPinResult), replayed: true } as PetPinResult;
    }
    const timeZone = await readHousehold(tx, house);
    const petSnap = await tx.get(pet);
    if (!petSnap.exists) throw new PetFeedingError('not-found');
    const outcome = await body(tx, { pet, petSnap, timeZone, actor: actorFacts(ctx), now: ctx.now });
    if (outcome.result.status === 'refused') return outcome.result;
    outcome.write?.(tx);
    ctx.hooks!.finalize(tx, { targetPath: target, summary: { result: outcome.result }, targetName: nameOf(petSnap) });
    return outcome.result;
  });
}

const refused = (reason: string, errors?: Record<string, string>): PinBody => ({ targetPath: '', result: { status: 'refused', reason, ...(errors ? { errors } : {}) } });
const authored = (snap: DocumentSnapshot) => ({
  loggedByUid: typeof snap.get('loggedByUid') === 'string' ? (snap.get('loggedByUid') as string) : null,
  loggedAt: toMillis(snap.get('loggedAt')) === null ? null : new Date(toMillis(snap.get('loggedAt'))!),
});

/** `pets.note.pin` / `pets.note.unpin`: as `runSetNotePinned` (pinning a pinned note moves it first). */
export function setNotePinnedAs(db: Firestore, householdId: string, input: { petId: unknown; noteId: unknown; pinned: boolean }, ctx: DeviceCtx) {
  const noteId = docIdOf(input?.noteId);
  return pinPetAction(db, householdId, input?.petId, ctx, (pet) => pet.collection('notes').doc(noteId), async (tx, { pet, actor }) => {
    const ref = pet.collection('notes').doc(noteId);
    const snap = await tx.get(ref);
    if (!snap.exists) return refused('gone');
    // The author with pets.addLogs, or pets.editProfiles (the rules' petNoteUpdate, D-P11).
    if (!mayEditNote(authored(snap), actor)) throw new DeviceActionError('forbidden');
    if (!input.pinned && snap.get('pinned') !== true) return { targetPath: ref.path, result: { status: 'already', petId: pet.id } };
    return {
      targetPath: ref.path,
      result: { status: 'saved', petId: pet.id },
      write: (t) => t.update(ref, input.pinned ? { pinned: true, pinnedAt: FieldValue.serverTimestamp() } : { pinned: false, pinnedAt: FieldValue.delete() }),
    };
  });
}

/** `pets.note.editPinned` (a note's text and tag): bound to what the form opened with, as `runEditNote`. */
export function editNoteAs(db: Firestore, householdId: string, input: { petId: unknown; noteId: unknown; expected: unknown; text: unknown; tag?: unknown }, ctx: DeviceCtx) {
  const noteId = docIdOf(input?.noteId);
  const expected = input?.expected as { text?: unknown; tag?: unknown } | null;
  if (!expected || typeof expected.text !== 'string' || typeof input.text !== 'string') throw new PetFeedingError('invalid');
  const text = input.text.trim();
  const tag = tagOf(input.tag) || null;
  const expectedTag = expected.tag === null || expected.tag === undefined || expected.tag === '' ? null : tagOf(expected.tag);
  if (!text || text.length > 500) throw new PetFeedingError('invalid');
  return pinPetAction(db, householdId, input.petId, ctx, (pet) => pet.collection('notes').doc(noteId), async (tx, { pet, actor }) => {
    const ref = pet.collection('notes').doc(noteId);
    const snap = await tx.get(ref);
    if (!snap.exists) return refused('gone');
    if (!mayEditNote(authored(snap), actor)) throw new DeviceActionError('forbidden');
    if (snap.get('text') !== expected.text || (snap.get('tag') ?? null) !== expectedTag) return refused('changed');
    return {
      targetPath: ref.path,
      result: { status: 'saved', petId: pet.id },
      write: (t) => t.update(ref, {
        text,
        tag: tag ?? FieldValue.delete(),
        editedAt: FieldValue.serverTimestamp(),
        editedByUid: actor.uid,
        editedByName: authorName(ctx),
      }),
    };
  });
}

/** `pets.note.delete`: pets.deleteLogs; a pinned note also pets.editProfiles; the author within 10 minutes (`mayDeleteNote`). */
export function deleteNoteAs(db: Firestore, householdId: string, input: { petId: unknown; noteId: unknown }, ctx: DeviceCtx) {
  const noteId = docIdOf(input?.noteId);
  return pinPetAction(db, householdId, input?.petId, ctx, (pet) => pet.collection('notes').doc(noteId), async (tx, { pet, actor, now }) => {
    const ref = pet.collection('notes').doc(noteId);
    const snap = await tx.get(ref);
    if (!snap.exists) return { targetPath: ref.path, result: { status: 'already', petId: pet.id } };
    if (!mayDeleteNote({ ...authored(snap), pinned: snap.get('pinned') === true }, actor, marginNow(now))) throw new DeviceActionError('forbidden');
    return { targetPath: ref.path, result: { status: 'deleted', petId: pet.id }, write: (t) => t.delete(ref) };
  });
}

export const DELETABLE_LOGS = ['feeding-logs', 'care-logs', 'medication-logs', 'weights'] as const;
export type DeletableLog = (typeof DELETABLE_LOGS)[number];

/**
 * The rules measure the author's 10 minutes at commit (`request.time`); the server checks
 * at precheck, so it closes the window this much earlier (review N1): a check that passes
 * here still holds when the transaction commits.
 */
export const AUTHOR_WINDOW_MARGIN_MS = 5_000;
const marginNow = (now: Date) => new Date(now.getTime() + AUTHOR_WINDOW_MARGIN_MS);

/** Within the author's 10 minutes, measured from the server's `loggedAt` (the rules' window, minus the margin). */
const authorWithin = (snap: DocumentSnapshot, actor: ActorFacts, now: Date) => {
  const at = toMillis(snap.get('loggedAt'));
  return actor.permissions['pets.addLogs'] === true && snap.get('loggedByUid') === actor.uid && at !== null && marginNow(now).getTime() < at + AUTHOR_DELETE_WINDOW_MS;
};

/**
 * `pets.log.delete`: an older feeding, care entry, dose or weighing (beyond the face Undo),
 * by exactly whom the rules allow: feedings and doses pets.deleteLogs or their author within
 * 10 minutes, care entries pets.deleteLogs, weighings `mayDeleteWeight`. A feeding's state
 * and a dose's course pointer are derived again from the surviving records in the same
 * commit (`planFeedDelete`, `pointerAfter`), as the personal delete.
 */
export function deleteLogAs(db: Firestore, householdId: string, input: { petId: unknown; kind: unknown; logId: unknown }, ctx: DeviceCtx) {
  const kind = input?.kind as DeletableLog;
  if (!(DELETABLE_LOGS as readonly unknown[]).includes(kind)) throw new PetFeedingError('invalid');
  const logId = docIdOf(input.logId);
  return pinPetAction(db, householdId, input.petId, ctx, (pet) => pet.collection(kind).doc(logId), async (tx, { pet, timeZone, actor, now }) => {
    const ref = pet.collection(kind).doc(logId);
    const snap = await tx.get(ref);
    if (!snap.exists) return { targetPath: ref.path, result: { status: 'already', petId: pet.id } };
    const deleteLogs = actor.permissions['pets.deleteLogs'] === true;
    // Care entries: pets.deleteLogs or the author within 10 minutes of `loggedAt`, as feedings (rules after the F4b-1 review; review N5).
    const allowed = kind === 'weights' ? mayDeleteWeight(authored(snap), actor, marginNow(now)) : deleteLogs || authorWithin(snap, actor, now);
    if (!allowed) throw new DeviceActionError('forbidden');
    let derived: ((t: Transaction) => void) | null = null;
    let dosePointer: { ref: DocumentReference; pointer: DocumentData | null } | null = null;
    if (kind === 'feeding-logs') {
      const stateRef = pet.collection('feeding-state').doc(FEEDING_STATE_ID);
      const stateSnap = await tx.get(stateRef);
      const logs = await stateFeedings(tx, pet.collection('feeding-logs'), householdDayStart(householdDay(now, timeZone), timeZone));
      const state = planFeedDelete({ now, timeZone, logs, logId, hasState: stateSnap.exists, slots: Boolean(stateSnap.exists && readFeedingState(stateSnap.data())?.slotsFed) });
      if (state) derived = (t) => t.set(stateRef, feedStateDocument(state, null, ADMIN_TIMES));
    } else if (kind === 'medication-logs') {
      const courseId = snap.get('courseId');
      if (typeof courseId === 'string' && isDocId(courseId)) {
        const courseRef = pet.collection('medication-courses').doc(courseId);
        const courseSnap = await tx.get(courseRef);
        const course = courseSnap.exists ? readCourse(courseId, courseSnap.data() ?? {}) : null;
        if (course) {
          const doses = await courseDoses(tx, pet.collection('medication-logs'), courseId, logId);
          const next = pointerAfter(course, doses.records);
          dosePointer = { ref: courseRef, pointer: next.write ? { lastDose: storedPointer(next.latest, doses.stored), prevDose: storedPointer(next.prev, doses.stored) } : null };
        }
      }
    }
    return {
      targetPath: ref.path,
      result: { status: 'deleted', petId: pet.id },
      write: (t) => {
        if (kind === 'medication-logs') writeDose(t, { log: { ref, delete: true }, course: dosePointer });
        else t.delete(ref);
        derived?.(t);
      },
    };
  });
}

/** The household's AM/PM of an instant (the legacy `ampm` field, in the household's zone). */
const ampmOf = (at: Date, timeZone: string) => (localMinutes(at, timeZone) < 12 * 60 ? 'AM' : 'PM');

/**
 * `pets.log.correctTime`: a feeding's effective time, as `runCorrectFeedTime`: allowed to
 * pets.deleteLogs or the author within 10 minutes (`checkFeedCorrection`), at most a minute
 * ahead (the form's margin), `originalDate` kept from the first correction, and the state
 * derived again (`planFeedCorrection`).
 */
export function correctFeedTimeAs(db: Firestore, householdId: string, input: { petId: unknown; logId: unknown; date: unknown }, ctx: DeviceCtx) {
  const logId = docIdOf(input?.logId);
  const date = typeof input?.date === 'string' ? new Date(input.date) : null;
  if (!date || Number.isNaN(date.getTime())) throw new PetFeedingError('invalid');
  return pinPetAction(db, householdId, input.petId, ctx, (pet) => pet.collection('feeding-logs').doc(logId), async (tx, { pet, timeZone, actor, now }) => {
    const ref = pet.collection('feeding-logs').doc(logId);
    const stateRef = pet.collection('feeding-state').doc(FEEDING_STATE_ID);
    const [snap, stateSnap] = await Promise.all([tx.get(ref), tx.get(stateRef)]);
    if (!snap.exists) return refused('gone');
    const data = snap.data() ?? {};
    const canDeleteLogs = actor.permissions['pets.deleteLogs'] === true;
    // The author's window with the commit margin (review N1); the rest of the check at the server's time.
    if (!canDeleteLogs && !mayCorrectFeedTime(data, actor.uid, false, marginNow(now))) throw new DeviceActionError('forbidden');
    const check = checkFeedCorrection({ log: data, viewerUid: actor.uid, canDeleteLogs, newDate: date, now, futureMarginMs: 60_000 });
    if (!check.ok) {
      if (check.reason === 'not-allowed') throw new DeviceActionError('forbidden');
      return refused(check.reason);
    }
    const read = await stateFeedings(tx, pet.collection('feeding-logs'), householdDayStart(householdDay(now, timeZone), timeZone));
    const stamp = Timestamp.fromDate(date);
    const state = planFeedCorrection({
      now, timeZone, logs: [...read, { id: logId, ...data } as StateLog], logId, newDate: date, rawNewDate: stamp,
      hasState: stateSnap.exists, slots: Boolean(stateSnap.exists && readFeedingState(stateSnap.data())?.slotsFed),
    });
    return {
      targetPath: ref.path,
      result: { status: 'saved', petId: pet.id },
      write: (t) => {
        t.update(ref, {
          date: stamp,
          ampm: ampmOf(date, timeZone),
          ...('originalDate' in data ? {} : { originalDate: data.date ?? null }),
          dateCorrectedAt: FieldValue.serverTimestamp(),
          dateCorrectedByUid: actor.uid,
          dateCorrectedByName: authorName(ctx),
        });
        if (state) t.set(stateRef, feedStateDocument(state, null, ADMIN_TIMES));
      },
    };
  });
}

/** `pets.course.finish` and `pets.course.resume`: as `runFinishCourse` / `runResumeCourse` (idempotent). */
export function setCourseFinishedAs(db: Firestore, householdId: string, input: { petId: unknown; courseId: unknown; finished: boolean }, ctx: DeviceCtx) {
  const courseId = docIdOf(input?.courseId);
  return pinPetAction(db, householdId, input?.petId, ctx, (pet) => pet.collection('medication-courses').doc(courseId), async (tx, { pet, actor }) => {
    if (!mayMedication('pets.course.finish', actor.permissions)) throw new DeviceActionError('forbidden');
    const ref = pet.collection('medication-courses').doc(courseId);
    const snap = await tx.get(ref);
    if (!snap.exists) return refused('missing');
    const base = { targetPath: ref.path };
    if (input.finished) {
      if (snap.get('status') === 'finished') return { ...base, result: { status: 'already', petId: pet.id } };
      return { ...base, result: { status: 'saved', petId: pet.id, courseId }, write: (t) => t.update(ref, { status: 'finished', finishedAt: FieldValue.serverTimestamp(), finishedByUid: actor.uid, finishedByName: authorName(ctx) }) };
    }
    if (snap.get('status') === 'active') return { ...base, result: { status: 'already', petId: pet.id } };
    if (!snap.get('schedule')) return refused('not-active');
    return { ...base, result: { status: 'saved', petId: pet.id, courseId }, write: (t) => t.update(ref, { status: 'active', finishedAt: null, finishedByUid: null, finishedByName: null }) };
  });
}

const STRING_FIELDS = ['name', 'dosage', 'kind', 'everyDays', 'everyHours', 'firstTime', 'startDay', 'endDay'] as const;
const formValuesOf = (value: unknown): CourseFormValues => {
  const raw = (value && typeof value === 'object' ? value : null) as Record<string, unknown> | null;
  if (!raw) throw new PetFeedingError('invalid');
  for (const key of STRING_FIELDS) if (typeof raw[key] !== 'string' || (raw[key] as string).length > 200) throw new PetFeedingError('invalid');
  if (raw.kind !== 'days' && raw.kind !== 'hours') throw new PetFeedingError('invalid');
  if (!Array.isArray(raw.times) || raw.times.length > 24 || raw.times.some((time) => typeof time !== 'string' || time.length > 10)) throw new PetFeedingError('invalid');
  return { ...(Object.fromEntries(STRING_FIELDS.map((key) => [key, raw[key]])) as Omit<CourseFormValues, 'times'>), times: raw.times as string[] };
};

const scheduleData = (fields: CourseFields) => ({ name: fields.name, dosage: fields.dosage, schedule: fields.schedule, startDay: fields.startDay, endDay: fields.endDay });

/**
 * `pets.course.edit` (create or edit) and `pets.medication.confirmLegacy`: the course form's
 * values checked by `validateCourseForm` against the pet's other active courses read here,
 * then written as `runSaveCourse` does (create once under the form's id; an edit keeps the
 * id and history and recomputes `coveredUntil` from the surviving doses).
 */
export function saveCourseAs(db: Firestore, householdId: string, input: { petId: unknown; courseId?: unknown; create: boolean; values: unknown; legacyKey?: unknown }, ctx: DeviceCtx) {
  const values = formValuesOf(input?.values);
  let legacyKey: string | null = null;
  if (input.legacyKey !== undefined && input.legacyKey !== null) {
    if (typeof input.legacyKey !== 'string' || !input.legacyKey.trim() || input.legacyKey.length > 200) throw new PetFeedingError('invalid');
    legacyKey = input.legacyKey;
  }
  let courseId: string;
  try {
    courseId = legacyKey ? legacyCourseId(legacyKey) : docIdOf(input.courseId);
  } catch {
    throw new PetFeedingError('invalid');
  }
  const create = legacyKey ? true : input.create === true;
  return pinPetAction(db, householdId, input.petId, ctx, (pet) => pet.collection('medication-courses').doc(courseId), async (tx, { pet, timeZone, actor }) => {
    if (!mayMedication(legacyKey ? 'pets.medication.confirmLegacy' : 'pets.course.edit', actor.permissions)) throw new DeviceActionError('forbidden');
    const ref = pet.collection('medication-courses').doc(courseId);
    const [snap, active] = await Promise.all([tx.get(ref), tx.get(pet.collection('medication-courses').where('status', '==', 'active'))]);
    const activeNames = active.docs.filter((entry) => entry.id !== courseId).map((entry) => legacyMedicationKey(entry.get('name')));
    const { errors, fields } = validateCourseForm(values, activeNames);
    if (!fields) return refused('invalid', errors as Record<string, string>);
    const base = { targetPath: ref.path };
    const by = { uid: actor.uid, name: authorName(ctx) };
    if (create) {
      if (snap.exists) return { ...base, result: { status: 'already', petId: pet.id } };
      return {
        ...base,
        result: { status: 'saved', petId: pet.id, courseId },
        write: (t) => t.set(ref, {
          ...scheduleData(fields),
          status: 'active',
          legacyKeys: legacyKey ? [legacyKey] : [],
          lastDose: null,
          prevDose: null,
          coveredUntil: null,
          createdAt: FieldValue.serverTimestamp(),
          createdByUid: by.uid,
          createdByName: by.name,
          updatedAt: FieldValue.serverTimestamp(),
          updatedByUid: by.uid,
          updatedByName: by.name,
        }),
      };
    }
    if (!snap.exists) return refused('missing');
    if (snap.get('status') !== 'active') return refused('not-active');
    const read = readCourse(courseId, snap.data() ?? {});
    const doses = read ? await courseDoses(tx, pet.collection('medication-logs'), courseId) : null;
    const stored = read && doses ? withRecords(read, doses.records) : read;
    const moved = Boolean(stored && scheduleChanged(stored, fields));
    const coveredUntil = moved && stored ? coveredUntilAfterSave(stored, fields, timeZone) : undefined;
    return {
      ...base,
      result: { status: 'saved', petId: pet.id, courseId },
      write: (t) => t.update(ref, {
        ...scheduleData(fields),
        ...(moved ? { coveredUntil: coveredUntil === null || coveredUntil === undefined ? null : Timestamp.fromMillis(coveredUntil) } : {}),
        updatedAt: FieldValue.serverTimestamp(),
        updatedByUid: by.uid,
        updatedByName: by.name,
      }),
    };
  });
}

/** Fields a profile edit may change from a tablet (no photo: photos are not on tablets). */
export type ProfileAsInput = { petId: unknown; name?: unknown; vetName?: unknown; vetClinic?: unknown; vetPhone?: unknown; weightUnit?: unknown };
const VET_PHONE = /^[+]?[0-9 ().-]{3,30}$/;

/**
 * `pets.profile.edit`: rename (the duplicate check reads the household's pets inside the
 * transaction, case-insensitively, the pet itself excluded: `duplicatePetName`), vet contact
 * and weight unit, validated as the rules' `petProfileFieldsValid`; a null optional value
 * removes it. Only the fields sent change.
 */
export function editProfileAs(db: Firestore, householdId: string, input: ProfileAsInput, ctx: DeviceCtx) {
  if (!input || typeof input !== 'object') throw new PetFeedingError('invalid');
  const update: DocumentData = {};
  let rename: string | null = null;
  if (input.name !== undefined) {
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    if (!name || name.length > 40) throw new PetFeedingError('invalid');
    update.name = name;
    rename = name;
  }
  for (const key of ['vetName', 'vetClinic'] as const) {
    if (input[key] === undefined) continue;
    const value = input[key] === null ? '' : typeof input[key] === 'string' ? (input[key] as string).trim() : null;
    if (value === null || value.length > 80) throw new PetFeedingError('invalid');
    update[key] = value ? value : FieldValue.delete();
  }
  if (input.vetPhone !== undefined) {
    const value = input.vetPhone === null ? '' : typeof input.vetPhone === 'string' ? input.vetPhone.trim() : null;
    if (value === null || (value && !VET_PHONE.test(value))) throw new PetFeedingError('invalid');
    update.vetPhone = value ? value : FieldValue.delete();
  }
  if (input.weightUnit !== undefined) {
    if (!isWeightUnit(input.weightUnit)) throw new PetFeedingError('invalid');
    update.weightUnit = input.weightUnit;
  }
  if (Object.keys(update).length === 0) throw new PetFeedingError('invalid');
  return pinPetAction(db, householdId, input.petId, ctx, (pet) => pet, async (tx, { pet, petSnap }) => {
    if (rename !== null && rename.toLocaleLowerCase('en-US') !== String(petSnap.get('name') ?? '').trim().toLocaleLowerCase('en-US')) {
      const pets = await tx.get(pet.parent);
      if (duplicatePetName(rename, pets.docs.map((entry) => ({ id: entry.id, name: entry.get('name') as unknown })), pet.id)) return refused('duplicate-name');
    }
    return { targetPath: pet.path, result: { status: 'saved', petId: pet.id }, write: (t) => t.update(pet, update) };
  });
}

const SLOT_ID = /^[A-Za-z0-9_-]{1,64}$/;
const slotRowsOf = (value: unknown): MealSlotDraft[] => {
  if (!Array.isArray(value) || value.length === 0 || value.length > 12) throw new PetFeedingError('invalid');
  return value.map((row) => {
    const raw = (row && typeof row === 'object' ? row : null) as Record<string, unknown> | null;
    if (!raw || typeof raw.id !== 'string' || !SLOT_ID.test(raw.id) || typeof raw.name !== 'string' || raw.name.length > 100 || typeof raw.time !== 'string') throw new PetFeedingError('invalid');
    const amount = typeof raw.amount === 'number' ? String(raw.amount) : raw.amount;
    if (typeof amount !== 'string' || amount.length > 20 || !(PORTION_UNITS as readonly unknown[]).includes(raw.unit)) throw new PetFeedingError('invalid');
    const offDays = raw.offDays === undefined ? [] : raw.offDays;
    if (!Array.isArray(offDays) || offDays.length > 7 || offDays.some((day) => !Number.isInteger(day))) throw new PetFeedingError('invalid');
    return { id: raw.id, name: raw.name, time: raw.time, amount, unit: raw.unit as PortionUnit, offDays: offDays as number[] };
  });
};

/**
 * `pets.slots.edit`: the meal plan (PE-22k), validated as the editor does
 * (`validateMealDraft`) and confirmed by the actor at server time with the plan history
 * the rules require (`confirmMealPlan` against the pet read here). A plan the same as the
 * stored one changes nothing (`already`).
 */
export function saveMealPlanAs(db: Firestore, householdId: string, input: { petId: unknown; rows: unknown }, ctx: DeviceCtx) {
  const rows = slotRowsOf(input?.rows);
  return pinPetAction(db, householdId, input.petId, ctx, (pet) => pet, async (_tx, { pet, petSnap, timeZone, actor, now }) => {
    const checked = validateMealDraft(rows);
    const rowErrors = checked.rows.map((errors, index) => Object.entries(errors).map(([field, message]) => [`${index}.${field}`, message] as const)).flat();
    if (checked.plan || rowErrors.length > 0) return refused('invalid', Object.fromEntries([...rowErrors, ...(checked.plan ? [['plan', checked.plan] as const] : [])]));
    const confirmed = confirmMealPlan(petSnap.data() as PetProfile, slotsFromDraft(rows), householdDay(now, timeZone));
    if (!confirmed) return { targetPath: pet.path, result: { status: 'already', petId: pet.id } };
    return {
      targetPath: pet.path,
      result: { status: 'saved', petId: pet.id },
      write: (t) => t.update(pet, {
        mealPlan: { ...confirmed.mealPlan, confirmedAt: FieldValue.serverTimestamp(), confirmedByUid: actor.uid, confirmedByName: authorName(ctx) },
        mealPlanHistory: confirmed.mealPlanHistory,
        feedingsPerDay: confirmed.feedingsPerDay,
        portionAmount: confirmed.portionAmount,
        portionUnit: confirmed.portionUnit,
      }),
    };
  });
}
