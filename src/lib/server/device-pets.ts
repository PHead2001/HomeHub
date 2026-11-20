import 'server-only';

import { adminDb, adminStorageBucket } from '@/lib/server/firebase-admin';
import { authorizeDeviceAction, QUEUED_MAX_AGE_MS } from '@/lib/server/device-gate';
import { DeviceActionError } from '@/lib/server/device-errors';
import { deviceOperationContext } from '@/lib/server/operation-context';
import { withoutEmails } from '@/lib/server/device-chores';
import { DOSE_CAPABILITIES, FEED_CAPABILITIES, doseCapability, feedCapability, type DeviceCapability } from '@/lib/devices/action-policy';
import {
  PetFeedingError,
  addCareAs,
  backdatedTimeOf,
  feedPetAs,
  undoCareAs,
  undoFeedAs,
  type CareAsResult,
  type FeedAsResult,
  type PetUndoOutcome,
} from '@/lib/server/pet-feeding';
import {
  addNoteAs,
  addWeightAs,
  correctFeedTimeAs,
  deleteLogAs,
  deleteNoteAs,
  doseGivenAtOf,
  editNoteAs,
  editProfileAs,
  giveDoseAs,
  saveCourseAs,
  saveMealPlanAs,
  setCourseFinishedAs,
  setNotePinnedAs,
  undoDoseAs,
  undoNoteAs,
  undoWeightAs,
  type DoseAsResult,
  type PetPinResult,
  type ProfileAsInput,
  type RecordAsResult,
} from '@/lib/server/pet-records';
import { deletePetCascade, petDeletePending, PetDeleteIncomplete, type PetPhotoBucket } from '@/lib/server/pet-delete';
import { isPetId } from '@/lib/pets/profile';
import { publicDisplayName } from '@/lib/member-directory';

// Pets feeding and care from a registered wall tablet (docs/modules/devices/README.md,
// "Device actions: pets"; design 8.2, 9, 10; PE-2c/d, PE-17a/c, PE-23l). Each passes the
// device action gate (`authorizeDeviceAction`: the tablet, its household and generation,
// the person chosen in "Who's here?", their pets permission from the same constants the
// personal paths use (R5), the Pets section, the level: face once the Undo is proven, a
// backdated feed older than 12 hours at PIN level (JC-27), never the points PIN (D-P6)),
// then runs the Pets operation with the gate's hooks inside its own transaction.

export type DevicePetsRequest = {
  idToken: unknown;
  householdId: unknown;
  actorUid: unknown;
  pinSessionId?: unknown;
  opId: unknown;
  queued?: { createdAt: string; generation?: unknown };
};

/** `clock`: the server clock (the real time unless a test injects one); read again at every precheck. */
export type DevicePetsOptions = { clock?: () => Date; clientAddress?: string };

const authorize = (capability: DeviceCapability, input: DevicePetsRequest, options: DevicePetsOptions, replayFamily?: readonly DeviceCapability[]) => authorizeDeviceAction({
  idToken: input.idToken as string,
  householdId: input.householdId as string,
  capability,
  actorUid: typeof input.actorUid === 'string' ? input.actorUid : undefined,
  pinSessionId: typeof input.pinSessionId === 'string' ? input.pinSessionId : undefined,
  opId: input.opId as string,
  // The gate refuses a queued entry whose generation is missing or not the token's.
  ...(input.queued && typeof input.queued.createdAt === 'string' ? { queued: { createdAt: input.queued.createdAt, generation: input.queued.generation as number } } : {}),
}, { clientAddress: options.clientAddress, clock: options.clock, ...(replayFamily ? { replayFamily } : {}) });

/** Pets module errors as device refusals (a missing pet or bad input is invalid input). */
const asDeviceError = (error: unknown): never => {
  if (error instanceof PetFeedingError) throw new DeviceActionError(error.reason === 'conflict' ? 'conflict' : 'invalid_input');
  // An opId that is not a valid record id (`doseLogId`, `recordDocId`).
  if (error instanceof Error && /^invalid-(dose|record)-operation$/.test(error.message)) throw new DeviceActionError('invalid_input');
  throw error;
};

/** The device's clock for a queued replay (the gate has already bounded it, JC-18). */
const queuedAtOf = (createdAt: string | null): Date | null => (createdAt ? new Date(createdAt) : null);

/**
 * A queued entry's time for deciding the 12-hour line: no later than the server clock, and
 * only within the gate's 24-hour limit (an older or malformed one is left to the gate, which
 * refuses it as `stale_intent`, the queue's notice).
 */
const queuedLineTime = (queued: DevicePetsRequest['queued'], now: Date): Date | null => {
  const at = queued && typeof queued.createdAt === 'string' ? Date.parse(queued.createdAt) : NaN;
  if (!Number.isFinite(at) || now.getTime() - at > QUEUED_MAX_AGE_MS) return null;
  return new Date(Math.min(at, now.getTime()));
};

export type DeviceFeedResult = { result: FeedAsResult; level: 'face' | 'pin'; capability: DeviceCapability };

export type DeviceFeedRequest = DevicePetsRequest & {
  petId: unknown;
  portion: unknown;
  portionFromSlot?: unknown;
  food: unknown;
  comments?: unknown;
  confirm?: unknown;
  backdatedAt?: unknown;
};

/**
 * `pets.feed` (Feed, hold, quick add, dashboard Fed on a tablet) and the detailed form's
 * backdated feed: the server picks the capability from the feeding's effective time, never
 * from the client (`feedCapability`): the chosen time, or a queued replay's queue time; more
 * than 12 hours old is `pets.feed.backdated.old` (PIN, not queueable). A retry or replay of
 * an opId already applied keeps the capability it was recorded under (the gate's
 * `replayFamily`), so an attempt on the other side of the line gets the stored answer.
 */
export async function feedPetFromTablet(input: DeviceFeedRequest, options: DevicePetsOptions = {}): Promise<DeviceFeedResult> {
  const now = (options.clock ?? (() => new Date()))();
  let capability: DeviceCapability = 'pets.feed';
  try {
    capability = feedCapability({ backdatedAt: backdatedTimeOf(input.backdatedAt, now), queuedAt: queuedLineTime(input.queued, now) }, now);
  } catch (error) {
    asDeviceError(error);
  }
  const authority = await authorize(capability, input, options, FEED_CAPABILITIES);
  const ctx = deviceOperationContext(authority);
  const result = await feedPetAs(adminDb, authority.householdId, {
    petId: input.petId, portion: input.portion, portionFromSlot: input.portionFromSlot, food: input.food,
    comments: input.comments, confirm: input.confirm, backdatedAt: input.backdatedAt,
  }, ctx, { queuedAt: queuedAtOf(authority.queuedCreatedAt) }).catch(asDeviceError);
  return { result: withoutEmails(result), level: authority.level === 'pin' ? 'pin' : 'face', capability: authority.capability };
}

/** `pets.feed.undo`: by the original's opId only. */
export async function undoFeedFromTablet(input: DevicePetsRequest & { petId?: unknown }, options: DevicePetsOptions = {}): Promise<PetUndoOutcome> {
  const authority = await authorize('pets.feed.undo', input, options);
  return undoFeedAs(adminDb, authority.householdId, { petId: input.petId }, { ...deviceOperationContext(authority), authority }).catch(asDeviceError);
}

/** `pets.care.add`: a care entry credited to the chosen person. */
export async function addCareFromTablet(input: DevicePetsRequest & { petId: unknown; activity: unknown; notes?: unknown }, options: DevicePetsOptions = {}): Promise<CareAsResult> {
  const authority = await authorize('pets.care.add', input, options);
  return withoutEmails(await addCareAs(adminDb, authority.householdId, { petId: input.petId, activity: input.activity, notes: input.notes }, deviceOperationContext(authority), { queuedAt: queuedAtOf(authority.queuedCreatedAt) }).catch(asDeviceError));
}

/** `pets.care.undo`: by the original's opId only. */
export async function undoCareFromTablet(input: DevicePetsRequest & { petId?: unknown }, options: DevicePetsOptions = {}): Promise<PetUndoOutcome> {
  const authority = await authorize('pets.care.undo', input, options);
  return undoCareAs(adminDb, authority.householdId, { petId: input.petId }, { ...deviceOperationContext(authority), authority }).catch(asDeviceError);
}


// --- F4b-2: doses, notes and weights (face* with their Undo proven) -------------------------

export type DeviceDoseResult = { result: DoseAsResult; level: 'face' | 'pin'; capability: DeviceCapability };

export type DeviceDoseRequest = DevicePetsRequest & {
  petId: unknown;
  courseId: unknown;
  occurrenceKey: unknown;
  givenAt?: unknown;
  notes?: unknown;
  confirm?: unknown;
  medication?: unknown;
  dosage?: unknown;
  occurrenceAt?: unknown;
};

/**
 * `pets.dose.give` (Give dose from the card chip, the pet's medication list or a reminder's
 * `?dose=` link): the server picks `pets.dose.give` (face) or `pets.dose.give.old` (PIN, not
 * queueable, JC-27) from the dose's effective time, never from the client (`doseCapability`:
 * the given-at time, else a queued replay's queue time). A retry of an opId already applied
 * keeps the capability it was recorded under (the gate's `replayFamily`, DOSE_CAPABILITIES).
 */
export async function giveDoseFromTablet(input: DeviceDoseRequest, options: DevicePetsOptions = {}): Promise<DeviceDoseResult> {
  const now = (options.clock ?? (() => new Date()))();
  let capability: DeviceCapability = 'pets.dose.give';
  try {
    capability = doseCapability({ givenAt: doseGivenAtOf(input.givenAt, now), queuedAt: queuedLineTime(input.queued, now) }, now);
  } catch (error) {
    asDeviceError(error);
  }
  const authority = await authorize(capability, input, options, DOSE_CAPABILITIES);
  const result = await giveDoseAs(adminDb, authority.householdId, {
    petId: input.petId, courseId: input.courseId, occurrenceKey: input.occurrenceKey, givenAt: input.givenAt, notes: input.notes, confirm: input.confirm,
    medication: input.medication, dosage: input.dosage, occurrenceAt: input.occurrenceAt,
  }, deviceOperationContext(authority), { queuedAt: queuedAtOf(authority.queuedCreatedAt) }).catch(asDeviceError);
  return { result: withoutEmails(result), level: authority.level === 'pin' ? 'pin' : 'face', capability: authority.capability };
}

/** `pets.dose.undo`: by the original's opId only; removes the record and moves the course's pointer off it. */
export async function undoDoseFromTablet(input: DevicePetsRequest & { petId?: unknown }, options: DevicePetsOptions = {}): Promise<PetUndoOutcome> {
  const authority = await authorize('pets.dose.undo', input, options);
  return undoDoseAs(adminDb, authority.householdId, { petId: input.petId }, { ...deviceOperationContext(authority), authority }).catch(asDeviceError);
}

/** `pets.note.add`: a dated behaviour entry credited to the chosen person. */
export async function addNoteFromTablet(input: DevicePetsRequest & { petId: unknown; text: unknown; tag?: unknown; day?: unknown }, options: DevicePetsOptions = {}): Promise<RecordAsResult> {
  const authority = await authorize('pets.note.add', input, options);
  return withoutEmails(await addNoteAs(adminDb, authority.householdId, { petId: input.petId, text: input.text, tag: input.tag, day: input.day, pinned: (input as { pinned?: unknown }).pinned }, deviceOperationContext(authority), { queuedAt: queuedAtOf(authority.queuedCreatedAt) }).catch(asDeviceError));
}

/** `pets.note.undo`: by the original's opId only. */
export async function undoNoteFromTablet(input: DevicePetsRequest & { petId?: unknown }, options: DevicePetsOptions = {}): Promise<PetUndoOutcome> {
  const authority = await authorize('pets.note.undo', input, options);
  return undoNoteAs(adminDb, authority.householdId, { petId: input.petId }, { ...deviceOperationContext(authority), authority }).catch(asDeviceError);
}

/** `pets.weight.add`: a weighing credited to the chosen person. */
export async function addWeightFromTablet(input: DevicePetsRequest & { petId: unknown; value: unknown; unit: unknown; day?: unknown }, options: DevicePetsOptions = {}): Promise<RecordAsResult> {
  const authority = await authorize('pets.weight.add', input, options);
  return withoutEmails(await addWeightAs(adminDb, authority.householdId, { petId: input.petId, value: input.value, unit: input.unit, day: input.day }, deviceOperationContext(authority), { queuedAt: queuedAtOf(authority.queuedCreatedAt) }).catch(asDeviceError));
}

/** `pets.weight.undo`: by the original's opId only. */
export async function undoWeightFromTablet(input: DevicePetsRequest & { petId?: unknown }, options: DevicePetsOptions = {}): Promise<PetUndoOutcome> {
  const authority = await authorize('pets.weight.undo', input, options);
  return undoWeightAs(adminDb, authority.householdId, { petId: input.petId }, { ...deviceOperationContext(authority), authority }).catch(asDeviceError);
}

// --- F4b-2: PIN-level Pets actions (JC-14, D-P6) ---------------------------------------------

const pinAction = async (capability: DeviceCapability, input: DevicePetsRequest, options: DevicePetsOptions, run: (ctx: Parameters<typeof setNotePinnedAs>[3], householdId: string) => Promise<PetPinResult>): Promise<PetPinResult> => {
  const authority = await authorize(capability, input, options);
  return withoutEmails(await run({ ...deviceOperationContext(authority), authority }, authority.householdId).catch(asDeviceError));
};

/** `pets.note.pin` / `pets.note.unpin`. */
export const setNotePinnedFromTablet = (input: DevicePetsRequest & { petId: unknown; noteId: unknown; pinned: unknown }, options: DevicePetsOptions = {}) =>
  pinAction(input.pinned === true ? 'pets.note.pin' : 'pets.note.unpin', input, options, (ctx, h) => setNotePinnedAs(adminDb, h, { petId: input.petId, noteId: input.noteId, pinned: input.pinned === true }, ctx));

/** `pets.note.editPinned`: a note's text and tag, bound to what the form opened with. */
export const editNoteFromTablet = (input: DevicePetsRequest & { petId: unknown; noteId: unknown; expected: unknown; text: unknown; tag?: unknown }, options: DevicePetsOptions = {}) =>
  pinAction('pets.note.editPinned', input, options, (ctx, h) => editNoteAs(adminDb, h, { petId: input.petId, noteId: input.noteId, expected: input.expected, text: input.text, tag: input.tag }, ctx));

/** `pets.note.delete`. */
export const deleteNoteFromTablet = (input: DevicePetsRequest & { petId: unknown; noteId: unknown }, options: DevicePetsOptions = {}) =>
  pinAction('pets.note.delete', input, options, (ctx, h) => deleteNoteAs(adminDb, h, { petId: input.petId, noteId: input.noteId }, ctx));

/** `pets.log.delete`: an older feeding, care entry, dose or weighing. */
export const deleteLogFromTablet = (input: DevicePetsRequest & { petId: unknown; kind: unknown; logId: unknown }, options: DevicePetsOptions = {}) =>
  pinAction('pets.log.delete', input, options, (ctx, h) => deleteLogAs(adminDb, h, { petId: input.petId, kind: input.kind, logId: input.logId }, ctx));

/** `pets.log.correctTime`: a feeding's effective time. */
export const correctFeedTimeFromTablet = (input: DevicePetsRequest & { petId: unknown; logId: unknown; date: unknown }, options: DevicePetsOptions = {}) =>
  pinAction('pets.log.correctTime', input, options, (ctx, h) => correctFeedTimeAs(adminDb, h, { petId: input.petId, logId: input.logId, date: input.date }, ctx));

/** `pets.course.finish` and `pets.course.resume`. */
export const setCourseFinishedFromTablet = (input: DevicePetsRequest & { petId: unknown; courseId: unknown; finished: unknown }, options: DevicePetsOptions = {}) =>
  pinAction(input.finished === true ? 'pets.course.finish' : 'pets.course.resume', input, options, (ctx, h) => setCourseFinishedAs(adminDb, h, { petId: input.petId, courseId: input.courseId, finished: input.finished === true }, ctx));

/** `pets.course.edit` (create or edit) and, with a legacy name, `pets.medication.confirmLegacy`. */
export const saveCourseFromTablet = (input: DevicePetsRequest & { petId: unknown; courseId?: unknown; create?: unknown; values: unknown; legacyKey?: unknown; base?: unknown }, options: DevicePetsOptions = {}) =>
  pinAction(input.legacyKey !== undefined && input.legacyKey !== null ? 'pets.medication.confirmLegacy' : 'pets.course.edit', input, options, (ctx, h) => saveCourseAs(adminDb, h, { petId: input.petId, courseId: input.courseId, create: input.create === true, values: input.values, legacyKey: input.legacyKey, base: input.base }, ctx));

/** `pets.profile.edit`: rename, vet contact, weight unit (no photo: not on tablets). */
export const editPetProfileFromTablet = (input: DevicePetsRequest & Omit<ProfileAsInput, 'petId'> & { petId: unknown }, options: DevicePetsOptions = {}) =>
  pinAction('pets.profile.edit', input, options, (ctx, h) => editProfileAs(adminDb, h, { petId: input.petId, name: input.name, vetName: input.vetName, vetClinic: input.vetClinic, vetPhone: input.vetPhone, weightUnit: input.weightUnit }, ctx));

/** `pets.slots.edit`: the meal plan, confirmed by the chosen person. */
export const saveMealPlanFromTablet = (input: DevicePetsRequest & { petId: unknown; rows: unknown }, options: DevicePetsOptions = {}) =>
  pinAction('pets.slots.edit', input, options, (ctx, h) => saveMealPlanAs(adminDb, h, { petId: input.petId, rows: input.rows }, ctx));

/**
 * `pets.pet.delete` (D-P12): the existing cascade (`deletePetCascade`) with the gate's hooks
 * in its barrier transaction (precheck first, finalize last: op ledger and the activity
 * entry), shared with the hourly upkeep (functions/src/shared/pet-delete.ts). A retry with
 * the same opId finishes whatever the sweep left (the barrier is a replay). A failure after
 * the barrier (the tombstone is there) answers `finishing`, as the personal action: the pet
 * has left every list and the upkeep's `resumePetDeletions` finishes it; any other failure is
 * `unavailable` (try again).
 */
export async function deletePetFromTablet(input: DevicePetsRequest & { petId: unknown }, options: DevicePetsOptions = {}): Promise<{ status: 'deleted' | 'already' | 'finishing'; petId: string }> {
  const authority = await authorize('pets.pet.delete', input, options);
  if (!isPetId(input.petId)) throw new DeviceActionError('invalid_input');
  const petId = input.petId;
  const actor = authority.actor!;
  const targetPath = `households/${authority.householdId}/pets/${petId}`;
  // A replay answers what the first run answered (review N2); another pet under the same opId is a conflict (S3).
  let stored: { status?: unknown } | null = null;
  try {
    const outcome = await deletePetCascade(adminDb, adminStorageBucket() as unknown as PetPhotoBucket | null, {
      householdId: authority.householdId,
      petId,
      actor: {
        uid: actor.uid, name: publicDisplayName(actor.name, 'Someone'), email: null,
        device: { deviceId: authority.deviceId, deviceName: authority.deviceName, level: authority.level === 'pin' ? 'pin' : 'face' },
      },
      now: authority.now,
    }, {
      device: {
        precheck: async (tx) => {
          const pre = await authority.hooks.precheck(tx);
          if (pre.replay) {
            if (pre.replay.targetPath !== targetPath) throw new DeviceActionError('conflict');
            stored = (pre.replay.summary.result ?? null) as { status?: unknown } | null;
          }
          return pre;
        },
        finalize: (tx, existed, name) => authority.hooks.finalize(tx, { targetPath, summary: { result: { status: existed ? 'deleted' : 'already', petId } }, targetName: name }),
      },
    });
    const replayed = (stored as { status?: unknown } | null)?.status;
    return { status: replayed === 'deleted' || replayed === 'already' ? replayed : outcome.status, petId };
  } catch (error) {
    if (error instanceof DeviceActionError) throw error;
    if (!(error instanceof PetDeleteIncomplete)) console.error('Tablet pet delete failed', error instanceof Error ? error.message : String(error));
    if (await petDeletePending(adminDb, authority.householdId, petId).catch(() => false)) return { status: 'finishing', petId };
    throw new DeviceActionError('unavailable');
  }
}
