import 'server-only';

import { randomUUID } from 'node:crypto';
import { FieldValue, Timestamp, type DocumentReference, type Firestore, type Transaction } from 'firebase-admin/firestore';
import { safeTimeZone } from '@functions/shared/calendar';
import { isDocId } from '@functions/shared/push-media';
import { publicDisplayName } from '@/lib/member-directory';
import { FOOD_TYPES, PORTION_UNITS, type FoodType, type PetProfile, type PortionUnit } from '@/lib/pets/types';
import { isValidPortion } from '@/lib/pets/schedule-parser';
import { planForDay } from '@/lib/pets/meal-plan';
import {
  FEEDING_STATE_ID,
  feedReadStartFor,
  householdDay,
  householdDayStart,
  readFeedingState,
} from '@/lib/pets/feed-decision';
import { feedLogId, planFeed, planFeedDelete, type FeedConfirm, type StateLog } from '@/lib/pets/feed-plan';
import { feedLogDocument, feedStateDocument, withStampFor, type FeedTimes } from '@/lib/pets/feed-documents';
import type { OperationContext } from '@/lib/server/operation-context';
import { DeviceActionError } from '@/lib/server/device-errors';
import { assertActorRule, type DeviceAuthority } from '@/lib/server/device-gate';
import { assertUndoable, createdRecordUnchanged, type DeviceOp } from '@/lib/server/device-ops';

// Pets feeding and care as an actor (docs/modules/pets/README.md, "Shared feed operation";
// docs/modules/devices/README.md, "Device actions: pets"; design 9, 10). The server side of
// the shared feed operation, on the Admin SDK, with the pure planning the client
// transaction uses (`planFeed`, `planFeedDelete`, `planForDay`) and the same document
// builders (`feed-documents.ts`), so the log and the state are exactly what the rules
// accept from a member (stage R2): the actor in `loggedByUid`, a live feed at server time
// paired with the derived state, a backdated or queued entry at its own time, the slot of
// the plan in force, the "Feed again?" answer bound to the state it was shown for.
// Admin writes bypass the rules, so every invariant they enforce is enforced here by
// construction (and `tests/server/device-pets-undo.test.ts` replays the writes through the
// rules as the actor). Order inside the one transaction: the device hooks' precheck, then
// the reads, then the writes, then finalize.

export class PetFeedingError extends Error {
  constructor(readonly reason: 'invalid' | 'not-found' | 'conflict') {
    super(`pet-feeding-${reason}`);
    this.name = 'PetFeedingError';
  }
}

/** The Admin SDK's two time values for the shared document builders. */
export const ADMIN_TIMES: FeedTimes = { serverTime: () => FieldValue.serverTimestamp(), timestamp: (at) => Timestamp.fromDate(at) };

/** A backdated time may be at most this far ahead of the server clock (the detailed form's margin). */
const BACKDATED_FUTURE_MS = 60_000;
const DAY_READ_LIMIT = 100;
const MIN_TIMESTAMP = Timestamp.fromMillis(-62135596800000);
const ID = /^[A-Za-z0-9_-]{1,128}$/;

export const householdRef = (db: Firestore, householdId: string) => {
  if (!isDocId(householdId)) throw new PetFeedingError('invalid');
  return db.collection('households').doc(householdId);
};

export const petIdOf = (value: unknown): string => {
  if (!isDocId(value)) throw new PetFeedingError('invalid');
  return value;
};

/** The household (must exist and not be deleting) and its time zone. */
export const readHousehold = async (tx: Transaction, ref: DocumentReference) => {
  const snap = await tx.get(ref);
  if (!snap.exists || snap.get('deletingAt')) throw new PetFeedingError('not-found');
  return safeTimeZone(snap.get('timeZone'));
};

/**
 * Feedings dated from `start` on (both date shapes, at most 100 each) plus the newest
 * Timestamp-dated ones, read inside the transaction: what the state is derived from (the
 * Admin twin of `stateFeedings` in feed-transaction.ts).
 */
export async function stateFeedings(tx: Transaction, logs: FirebaseFirestore.CollectionReference, start: Date): Promise<StateLog[]> {
  const stringFloor = new Date(start.getTime() - 24 * 3_600_000).toISOString().slice(0, 10);
  const [stamped, strings, newest] = await Promise.all([
    tx.get(logs.where('date', '>=', Timestamp.fromDate(start)).orderBy('date', 'desc').limit(DAY_READ_LIMIT)),
    tx.get(logs.where('date', '>=', stringFloor).orderBy('date', 'desc').limit(DAY_READ_LIMIT)),
    tx.get(logs.where('date', '>=', MIN_TIMESTAMP).orderBy('date', 'desc').limit(5)),
  ]);
  return [...stamped.docs, ...strings.docs, ...newest.docs].map((entry) => ({ id: entry.id, ...entry.data() }) as StateLog);
}

export type FeedAsInput = {
  petId: unknown;
  portion: unknown;
  /** Log the assigned meal slot's portion (quick feeds); `portion` is the fallback. */
  portionFromSlot?: unknown;
  food: unknown;
  comments?: unknown;
  /** The answer to "Feed again?": the state it was shown for. */
  confirm?: unknown;
  /** A chosen earlier time (ISO): `backdated: true`, no repeat check. */
  backdatedAt?: unknown;
};

/** A feed from the tablet's offline queue: recorded at the device's time, never asked "Feed again?" (11.3). */
export type FeedAsOptions = { queuedAt?: Date | null };

type ValidFeed = {
  petId: string;
  portion: { amount: number; unit: PortionUnit };
  portionFromSlot: boolean;
  food: FoodType;
  comments: string;
  confirm: FeedConfirm | null;
  backdatedAt: Date | null;
};

const confirmOf = (value: unknown): FeedConfirm | null => {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object') throw new PetFeedingError('invalid');
  const raw = value as Record<string, unknown>;
  const lastLogId = raw.lastLogId === null ? null : typeof raw.lastLogId === 'string' && ID.test(raw.lastLogId) ? raw.lastLogId : undefined;
  const countToday = typeof raw.countToday === 'number' && Number.isInteger(raw.countToday) && raw.countToday >= 0 && raw.countToday <= 1000 ? raw.countToday : undefined;
  if (lastLogId === undefined || countToday === undefined) throw new PetFeedingError('invalid');
  if (raw.slotId !== undefined && raw.slotId !== null && (typeof raw.slotId !== 'string' || !ID.test(raw.slotId))) throw new PetFeedingError('invalid');
  return { lastLogId, countToday, ...(raw.slotId !== undefined ? { slotId: (raw.slotId as string | null) } : {}) };
};

/** Parses a backdated time (ISO); null when absent. */
export const backdatedTimeOf = (value: unknown, now: Date): Date | null => {
  if (value === undefined || value === null || value === '') return null;
  const at = typeof value === 'string' ? new Date(value) : null;
  if (!at || Number.isNaN(at.getTime()) || at.getTime() <= 0) throw new PetFeedingError('invalid');
  if (at.getTime() > now.getTime() + BACKDATED_FUTURE_MS) throw new PetFeedingError('invalid');
  return at;
};

const validFeed = (input: FeedAsInput, now: Date): ValidFeed => {
  if (!input || typeof input !== 'object') throw new PetFeedingError('invalid');
  const portion = input.portion as { amount?: unknown; unit?: unknown } | null;
  const amount = typeof portion?.amount === 'number' ? portion.amount : NaN;
  const unit = portion?.unit;
  if (!isValidPortion(amount) || !(PORTION_UNITS as readonly unknown[]).includes(unit)) throw new PetFeedingError('invalid');
  if (!(FOOD_TYPES as readonly unknown[]).includes(input.food)) throw new PetFeedingError('invalid');
  const comments = input.comments === undefined || input.comments === null ? '' : input.comments;
  if (typeof comments !== 'string' || comments.length > 2000) throw new PetFeedingError('invalid');
  return {
    petId: petIdOf(input.petId),
    portion: { amount, unit: unit as PortionUnit },
    portionFromSlot: input.portionFromSlot === true,
    food: input.food as FoodType,
    comments,
    confirm: confirmOf(input.confirm),
    backdatedAt: backdatedTimeOf(input.backdatedAt, now),
  };
};

/** What a tablet (or a retry) receives: JSON-safe, names only, no emails. */
export type FeedAsResult =
  | {
      status: 'needsConfirm';
      staleConfirm: boolean;
      reason: 'recent' | 'complete' | 'slot-fed' | 'off-day' | null;
      lastLogId: string | null;
      /** ISO. */
      lastFedAt: string | null;
      lastFedByUid: string | null;
      lastFedByName: string | null;
      countToday: number;
      perDay: number | null;
      slotId?: string | null;
      slotName?: string | null;
      slotTime?: string | null;
    }
  | {
      status: 'saved';
      petId: string;
      logId: string;
      countToday: number;
      perDay: number | null;
      slot: { id: string; name: string } | null;
      portion: { amount: number; unit: PortionUnit };
      mealsComplete: boolean;
      /** Recorded at the device's time from the offline queue (`repeat: 'offline'`). */
      offline?: true;
      /** This press had already been recorded (nothing written now). */
      replayed?: true;
    };

/**
 * Logs a feeding as the operation's actor (design 9): precheck first (a replay of the same
 * opId returns the stored result and writes nothing), then the reads (household, this
 * press's log, the pet, the state and whether its latest log survives, the surviving
 * feedings), then the log (id = opId) and the derived state, then finalize. Returns
 * `needsConfirm` (nothing written, no ledger entry) when the shared check asks "Feed
 * again?"; the answer is bound to the state it was shown for (PE-23g). A queued replay is
 * recorded at the device's time as an offline entry (no state write, as the client's
 * offline path) and is never asked.
 */
export async function feedPetAs(db: Firestore, householdId: string, input: FeedAsInput, ctx: OperationContext, options: FeedAsOptions = {}): Promise<FeedAsResult> {
  const house = householdRef(db, householdId);
  const feed = validFeed(input, ctx.now);
  const logId = feedLogId(ctx.opId ?? randomUUID());
  const pet = house.collection('pets').doc(feed.petId);
  const logs = pet.collection('feeding-logs');
  const logRef = logs.doc(logId);
  const stateRef = pet.collection('feeding-state').doc(FEEDING_STATE_ID);
  return db.runTransaction(async (tx) => {
    const { replay } = (await ctx.hooks?.precheck(tx)) ?? {};
    // The same opId for another pet (or another kind of log) is a different action: never its answer.
    if (replay) {
      if (replay.targetPath !== logRef.path) throw new PetFeedingError('conflict');
      return { ...(replay.summary.result as FeedAsResult), replayed: true } as FeedAsResult;
    }
    const timeZone = await readHousehold(tx, house);
    const [existing, petSnap, stateSnap] = await Promise.all([tx.get(logRef), tx.get(pet), tx.get(stateRef)]);
    if (!petSnap.exists) throw new PetFeedingError('not-found');
    const petName = typeof petSnap.get('name') === 'string' ? (petSnap.get('name') as string) : null;
    // Read after precheck: the gate may have re-checked the level there.
    const actor = ctx.actor;
    const extra = actor.device ? { deviceAttribution: actor.device } : {};
    const now = ctx.now;
    const today = householdDay(now, timeZone);
    const dayPlan = planForDay(petSnap.data() as PetProfile, today);
    const perDay = dayPlan.kind === 'legacy' ? dayPlan.plan.perDay : dayPlan.slots.length;
    const user = { uid: actor.uid, name: publicDisplayName(actor.name, 'Someone') };
    const logInput = { portion: feed.portion, food: feed.food, comments: feed.comments, backdatedAt: feed.backdatedAt, user };

    if (existing.exists && existing.get('loggedByUid') !== actor.uid) throw new PetFeedingError('conflict');

    if (options.queuedAt) {
      // Offline on the tablet (11.3): it happened, so it is never asked; the device's clock is
      // recorded as such and the state is left to the next online writer, as the client's offline path.
      const fedAt = feed.backdatedAt ?? options.queuedAt;
      const sameDay = householdDay(fedAt, timeZone) === today;
      // The day's count is the next online writer's to derive; this entry's own day is all that is known here.
      const result: FeedAsResult = {
        status: 'saved', petId: feed.petId, logId, countToday: sameDay ? 1 : 0, perDay, slot: null, portion: feed.portion, mealsComplete: false, offline: true,
        ...(existing.exists ? { replayed: true as const } : {}),
      };
      if (!existing.exists) {
        tx.set(logRef, feedLogDocument(logInput, { fedAt, live: false, repeat: 'offline' }, ADMIN_TIMES, { extra }));
      }
      ctx.hooks?.finalize(tx, { targetPath: logRef.path, summary: { result }, targetName: petName });
      return result;
    }

    const stored = readFeedingState(stateSnap.exists ? stateSnap.data() : null);
    const latestSurvives = stored?.lastLogId ? (await tx.get(logs.doc(stored.lastLogId))).exists : false;
    // A backdated feed's own day is read too: its meal is judged with that day's feedings.
    const recent = await stateFeedings(tx, logs, feedReadStartFor(today, now, timeZone, feed.backdatedAt));
    let plan;
    try {
      plan = planFeed(
        {
          now, timeZone, perDay: dayPlan.kind === 'legacy' ? dayPlan.plan.perDay : null, dayPlan, stored, latestSurvives, recent, known: null,
          pet: petSnap.data() as PetProfile,
          existing: existing.exists ? { loggedByUid: (existing.get('loggedByUid') as string | undefined) ?? null } : null,
        },
        { userUid: actor.uid, userName: user.name, logId, confirm: feed.confirm, backdatedAt: feed.backdatedAt },
      );
    } catch {
      throw new PetFeedingError('conflict');
    }
    if (plan.kind === 'needsConfirm') {
      // Nothing written and no ledger entry: the answer comes back with the same opId.
      const check = plan.check;
      return {
        status: 'needsConfirm', staleConfirm: plan.staleConfirm, reason: check.reason,
        lastLogId: check.lastLogId, lastFedAt: check.lastFedAt ? check.lastFedAt.toISOString() : null,
        lastFedByUid: check.lastFedByUid, lastFedByName: check.lastFedByName ? publicDisplayName(check.lastFedByName, '') || null : null,
        countToday: check.countToday, perDay: check.perDay,
        ...(check.slotId !== undefined ? { slotId: check.slotId, slotName: check.slotName ?? null, slotTime: check.slotTime ?? null } : {}),
      };
    }
    if (plan.kind === 'already') {
      const result: FeedAsResult = { status: 'saved', petId: feed.petId, logId, countToday: plan.countToday, perDay: plan.perDay, slot: null, portion: feed.portion, mealsComplete: false, replayed: true };
      ctx.hooks?.finalize(tx, { targetPath: logRef.path, summary: { result }, targetName: petName });
      return result;
    }
    // The planned portion (a live slot's, or a backdated feed's plan in force that day), as the personal path.
    const portion = feed.portionFromSlot && plan.planned ? plan.planned : feed.portion;
    // A backdated entry's log and state carry the same stored time.
    const stamp = Timestamp.fromDate(plan.fedAt);
    tx.set(logRef, feedLogDocument(logInput, { fedAt: plan.fedAt, live: plan.live, repeat: plan.repeat, confirmOf: plan.confirmOf, slotId: plan.slotId, extra: plan.extra }, ADMIN_TIMES, { stamp, portion, extra }));
    const state = plan.live ? plan.state : withStampFor(plan.state, logId, stamp);
    tx.set(stateRef, feedStateDocument(state, plan.live ? logId : null, ADMIN_TIMES));
    const result: FeedAsResult = {
      status: 'saved', petId: feed.petId, logId, countToday: plan.countToday, perDay: plan.perDay,
      slot: plan.slot ? { id: plan.slot.id, name: plan.slot.name } : null, portion, mealsComplete: plan.mealsComplete,
    };
    ctx.hooks?.finalize(tx, { targetPath: logRef.path, summary: { result }, targetName: petName });
    return result;
  });
}

/** Device Undo answers. */
export type PetUndoOutcome =
  | { status: 'undone'; petId: string; logId: string }
  | { status: 'not_applied' | 'already'; petId: null; logId: null };

export const undoContext = (ctx: OperationContext & { authority?: DeviceAuthority }) => {
  if (!ctx.authority || !ctx.opId || !ctx.hooks) throw new DeviceActionError('invalid_input');
  return ctx.authority;
};

/** The log a ledger entry points at: `households/h/pets/<pet>/<collection>/<id>`. */
const logOfEntry = (house: DocumentReference, entry: DeviceOp, collection: 'feeding-logs' | 'care-logs', petId: string | null): { pet: DocumentReference; log: DocumentReference } => {
  const prefix = `${house.path}/pets/`;
  const rest = entry.targetPath?.startsWith(prefix) ? entry.targetPath.slice(prefix.length).split('/') : [];
  if (rest.length !== 3 || rest[1] !== collection || !isDocId(rest[0]) || !isDocId(rest[2])) throw new DeviceActionError('not_undoable');
  if (petId !== null && rest[0] !== petId) throw new DeviceActionError('invalid_input');
  const pet = house.collection('pets').doc(rest[0]);
  return { pet, log: pet.collection(collection).doc(rest[2]) };
};

export const optionalPetId = (value: unknown): string | null => (value === undefined || value === null ? null : petIdOf(value));

/**
 * The Undo of a tablet's feed (`pets.feed.undo`), by the original's opId (design 10.1-10.2):
 * no ledger entry yet → a tombstone, `not_applied`; already undone → `already`; applied →
 * the same tablet generation, the original person (or a PIN holder with pets.deleteLogs),
 * inside the window, and the log unchanged since it was created and still this tablet's log for
 * that person (`changed_since` after a time correction, a delete by anyone, or a log recreated
 * under the same id by someone else). It deletes the log and stores the state derived
 * from the surviving logs, so a later feed (by anyone, on any device) stays the latest.
 */
export async function undoFeedAs(db: Firestore, householdId: string, input: { petId?: unknown; opId?: unknown }, ctx: OperationContext & { authority?: DeviceAuthority }): Promise<PetUndoOutcome> {
  return undoCreatedLog(db, householdId, input, ctx, 'feeding-logs');
}

/** The Undo of a tablet's care entry (`pets.care.undo`), as `undoFeedAs` without a state to derive. */
export async function undoCareAs(db: Firestore, householdId: string, input: { petId?: unknown; opId?: unknown }, ctx: OperationContext & { authority?: DeviceAuthority }): Promise<PetUndoOutcome> {
  return undoCreatedLog(db, householdId, input, ctx, 'care-logs');
}

async function undoCreatedLog(
  db: Firestore,
  householdId: string,
  input: { petId?: unknown; opId?: unknown },
  ctx: OperationContext & { authority?: DeviceAuthority },
  collection: 'feeding-logs' | 'care-logs',
): Promise<PetUndoOutcome> {
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
    // The original person, or (at PIN level) a holder of pets.deleteLogs.
    assertActorRule(authority, original.actorUid);
    assertUndoable(original, {
      generation: authority.generation, actorUid: actor.uid, now: authority.now,
      actorRuleAllows: actor.uid !== original.actorUid,
      queuedUndo: authority.queued, queuedUndoCreatedAt: authority.queuedCreatedAt,
    });
    // A replayed feed recorded nothing new: its Undo never removes a log it did not write.
    if ((original.summary.result as { replayed?: unknown } | undefined)?.replayed === true) return { status: 'already', petId: null, logId: null };
    const { pet, log } = logOfEntry(house, original, collection, petId);
    const timeZone = await readHousehold(tx, house);
    const [logSnap, petSnap, stateSnap] = await Promise.all([
      tx.get(log),
      tx.get(pet),
      collection === 'feeding-logs' ? tx.get(pet.collection('feeding-state').doc(FEEDING_STATE_ID)) : Promise.resolve(null),
    ]);
    // Changed since the action (a time correction, a delete): never reverted here.
    if (!createdRecordUnchanged(logSnap)) throw new DeviceActionError('changed_since');
    // The log is the one this tablet wrote for this person (not a different log recreated
    // under the same id after a delete): its author and tablet match the ledger.
    const attribution = logSnap.get('deviceAttribution') as { deviceId?: unknown } | undefined;
    if (logSnap.get('loggedByUid') !== original.actorUid || attribution?.deviceId !== authority.deviceId) {
      throw new DeviceActionError('changed_since');
    }
    let derived = null;
    if (collection === 'feeding-logs' && stateSnap) {
      const now = authority.now;
      const logs = await stateFeedings(tx, pet.collection('feeding-logs'), householdDayStart(householdDay(now, timeZone), timeZone));
      derived = planFeedDelete({
        now, timeZone, logs, logId: log.id, hasState: stateSnap.exists,
        slots: Boolean(stateSnap.exists && readFeedingState(stateSnap.data())?.slotsFed),
      });
    }
    tx.delete(log);
    if (derived) tx.set(pet.collection('feeding-state').doc(FEEDING_STATE_ID), feedStateDocument(derived, null, ADMIN_TIMES));
    const targetName = typeof petSnap.get('name') === 'string' ? (petSnap.get('name') as string) : null;
    ctx.hooks!.finalize(tx, { targetPath: log.path, summary: { petId: pet.id, logId: log.id }, undo: 'reversed', targetName });
    return { status: 'undone', petId: pet.id, logId: log.id };
  });
}

export type CareAsInput = { petId: unknown; activity: unknown; notes?: unknown };
export type CareAsResult = { status: 'added'; petId: string; logId: string; replayed?: true };

/**
 * Adds a care entry as the actor (`pets.care.add`): the entry's id is the opId, its date the
 * server's time (a queued replay: the device's time), `loggedAt` the server time of the write
 * (the author's 10-minute delete window in the rules), its author the actor; the shape the
 * rules accept from a member (`validCareLogFields`), plus `deviceAttribution`.
 */
export async function addCareAs(db: Firestore, householdId: string, input: CareAsInput, ctx: OperationContext, options: FeedAsOptions = {}): Promise<CareAsResult> {
  const house = householdRef(db, householdId);
  const petId = petIdOf(input?.petId);
  const activity = typeof input?.activity === 'string' ? input.activity.trim() : '';
  const notes = input?.notes === undefined || input?.notes === null ? '' : input.notes;
  if (!activity || activity.length > 200 || typeof notes !== 'string' || notes.length > 2000) throw new PetFeedingError('invalid');
  const logId = feedLogId(ctx.opId ?? randomUUID());
  const pet = house.collection('pets').doc(petId);
  const logRef = pet.collection('care-logs').doc(logId);
  return db.runTransaction(async (tx) => {
    const { replay } = (await ctx.hooks?.precheck(tx)) ?? {};
    if (replay) {
      if (replay.targetPath !== logRef.path) throw new PetFeedingError('conflict');
      return { ...(replay.summary.result as CareAsResult), replayed: true };
    }
    await readHousehold(tx, house);
    const [existing, petSnap] = await Promise.all([tx.get(logRef), tx.get(pet)]);
    if (!petSnap.exists) throw new PetFeedingError('not-found');
    const actor = ctx.actor;
    if (existing.exists && existing.get('loggedByUid') !== actor.uid) throw new PetFeedingError('conflict');
    const result: CareAsResult = { status: 'added', petId, logId, ...(existing.exists ? { replayed: true as const } : {}) };
    if (!existing.exists) {
      tx.set(logRef, {
        date: (options.queuedAt ?? ctx.now).toISOString(),
        loggedAt: FieldValue.serverTimestamp(),
        activity,
        notes: notes.trim(),
        loggedByUid: actor.uid,
        loggedByName: publicDisplayName(actor.name, 'Someone'),
        ...(actor.device ? { deviceAttribution: actor.device } : {}),
      });
    }
    ctx.hooks?.finalize(tx, { targetPath: logRef.path, summary: { result }, targetName: typeof petSnap.get('name') === 'string' ? petSnap.get('name') : null });
    return result;
  });
}
