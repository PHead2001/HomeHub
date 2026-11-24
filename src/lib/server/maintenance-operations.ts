import 'server-only';

import { FieldValue, Timestamp, type DocumentReference, type DocumentSnapshot, type Firestore } from 'firebase-admin/firestore';
import { localDay, safeTimeZone } from '@functions/shared/calendar';
import { stableSlugify } from '@functions/shared/ids';
import { isDocId } from '@functions/shared/push-media';
import { actionableReminders, buildMaintenanceReminders, type AssetInput, type VehicleInput } from '@functions/shared/maintenance-reminders';
import { publicDisplayName } from '@/lib/member-directory';
import type { OperationContext } from '@/lib/server/operation-context';
import { UNDO_WINDOW_MS } from '@/lib/undo-window';
import {
  ASSET_SCHEDULE_FIELDS,
  VEHICLE_SCHEDULE_FIELDS,
  isRealDay,
  legacyScheduleKey,
  mileagePatch,
  parseCycle,
  planCompletion,
  planRecordEdit,
  planSnooze,
  planUndoCompletion,
  planUndoSnooze,
  scheduleListField,
  withScheduleIds,
  type CompletionRecord,
  type CompletionRefusal,
  type FieldValues,
  type KeptField,
  type MaintenanceCycle,
  type MaintenanceOwnerType,
  type StoredSchedule,
} from '@/lib/maintenance/operations';

/**
 * Maintenance writes through the Admin SDK (M1, audit 17.3: MA-3 to MA-8, MA-20).
 *
 * Every operation is one transaction with the shape of chore-completion.ts:
 * device hooks' precheck first, then the reads (household, member, op ledger,
 * the record), then the writes, then the hooks' finalize. The actor comes from
 * the OperationContext (a verified ID token, or later a device), never from the
 * request. Each write carries a client op id: the ledger
 * `households/{h}/maintenance-ops/{opId}` makes a retry replay the stored result.
 */

export type MaintenanceErrorCode = 'invalid' | 'not_found' | 'conflict' | 'forbidden';

export class MaintenanceOperationError extends Error {
  constructor(readonly code: MaintenanceErrorCode) {
    super(code);
    this.name = 'MaintenanceOperationError';
  }
}

const invalid = () => new MaintenanceOperationError('invalid');

/** The server's latency allowance on top of the shared 10 s Undo window. */
export const MAINTENANCE_UNDO_GRACE_MS = 5_000;

export type CleanupState = 'done' | 'pending';

export type CompleteResult =
  | { status: 'completed'; opId: string; logId: string; next: MaintenanceCycle; replay: boolean; cleanup: CleanupState }
  | { status: 'already_done'; byName: string; completedDate: string; at: string }
  | { status: 'changed' }
  | { status: 'gone' }
  | { status: 'refused'; reason: CompletionRefusal };

export type SnoozeResult =
  | { status: 'snoozed'; opId: string; nextDueDate: string; replay: boolean; cleanup: CleanupState }
  | { status: 'changed' }
  | { status: 'gone' }
  | { status: 'refused'; reason: 'not_snoozable' };

export type UndoResult =
  | { status: 'undone'; kept: KeptField[] }
  | { status: 'already_undone' }
  | { status: 'superseded' }
  | { status: 'expired' };

export type SaveResult = { status: 'saved'; id: string; created: boolean; replay: boolean };

type OpKind = 'complete' | 'snooze' | 'save_asset' | 'save_vehicle' | 'save_log';

/* -------------------------------------------------------------------------- */
/* Input                                                                       */
/* -------------------------------------------------------------------------- */

const OP_ID = /^[A-Za-z0-9-]{8,64}$/;
// Schedule ids are array-element ids (never document ids): any short string without a slash.
const SCHEDULE_ID = /^[^/]{1,1500}$/;

const opIdOf = (value: unknown): string => {
  if (typeof value !== 'string' || !OP_ID.test(value)) throw invalid();
  return value;
};
const docIdOf = (value: unknown): string => {
  if (!isDocId(value)) throw invalid();
  return value;
};
const ownerTypeOf = (value: unknown): MaintenanceOwnerType => {
  if (value !== 'home_asset' && value !== 'vehicle') throw invalid();
  return value;
};
const scheduleIdOf = (value: unknown): string => {
  if (typeof value !== 'string' || !SCHEDULE_ID.test(value)) throw invalid();
  return value;
};
const cycleIn = (value: unknown): MaintenanceCycle => {
  const cycle = parseCycle(value);
  if (!cycle) throw invalid();
  return cycle;
};
const optionalText = (value: unknown, max: number): string | null => {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.length > max) throw invalid();
  return value.trim() || null;
};
const optionalNumber = (value: unknown, min: number, max: number, integer = false): number | null => {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw invalid();
  if (integer && !Number.isInteger(value)) throw invalid();
  return value;
};
const enumOf = <T extends string>(value: unknown, values: readonly T[], fallback: T | null = null): T | null => {
  if (value === undefined || value === null || value === '') return fallback;
  if (!values.includes(value as T)) throw invalid();
  return value as T;
};
const recordOf = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  return value as Record<string, unknown>;
};

const LOG_TYPES = ['repair', 'routine', 'inspection', 'cleaning', 'replacement', 'issue', 'other'] as const;
const MAX_COST = 1_000_000_000;

/* -------------------------------------------------------------------------- */
/* Shared reads and writes                                                     */
/* -------------------------------------------------------------------------- */

const householdRef = (db: Firestore, householdId: string) => db.collection('households').doc(docIdOf(householdId));
const ownerCollection = (ownerType: MaintenanceOwnerType) => (ownerType === 'home_asset' ? 'home-assets' : 'vehicles');
const ledgerRef = (house: DocumentReference, opId: string) => house.collection('maintenance-ops').doc(opId);

/** The household (must exist and not be deleting): its timezone and today. */
const householdDay = (home: DocumentSnapshot, now: Date) => {
  if (!home.exists || home.get('deletingAt')) throw new MaintenanceOperationError('not_found');
  const timeZone = safeTimeZone(home.get('timeZone'));
  return { timeZone, today: localDay(now, timeZone) };
};

/** Shown to every member: a name, never an email (MA-20, HO-9). */
const actorName = (member: DocumentSnapshot, ctx: OperationContext) =>
  publicDisplayName(member.get('displayName'), '') || publicDisplayName(ctx.actor.name);

/**
 * A ledger entry for this op id: the same actor and kind replay it; anything
 * else reusing the id is refused (`conflict`).
 */
const replayOf = (entry: DocumentSnapshot, kind: OpKind, ctx: OperationContext): Record<string, unknown> | null => {
  if (!entry.exists) return null;
  if (entry.get('kind') !== kind || entry.get('actorUid') !== ctx.actor.uid) throw new MaintenanceOperationError('conflict');
  return (entry.get('result') ?? {}) as Record<string, unknown>;
};

/** A patch for tx.update: null deletes the field. */
const toUpdate = (patch: FieldValues) =>
  Object.fromEntries(Object.entries(patch).map(([field, value]) => [field, value === null || value === undefined ? FieldValue.delete() : value]));

/** Drops null/undefined so a stored document or array element never holds them. */
const compact = (value: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== null && entry !== undefined));

const plain = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const findSchedule = (list: StoredSchedule[], scheduleId: string) => {
  const index = list.findIndex(schedule => schedule.id === scheduleId);
  return index < 0 ? null : { index, schedule: list[index] };
};

const sourceTypeOf = (ownerType: MaintenanceOwnerType) =>
  ownerType === 'home_asset' ? 'maintenance_asset_schedule' : 'maintenance_vehicle_service';

/** Every sourceId a reminder for this schedule may carry (current, legacy key, pre-key legacy ids). */
const scheduleSourceIds = (ownerId: string, scheduleId: string, legacyKey: string, index: number) => [
  ...new Set([`${ownerId}:${scheduleId}`, `${ownerId}:${legacyKey}`]),
  ...['due_soon', 'due_today', 'overdue'].map(status => `${ownerId}-${index}:${status}`),
];

type CleanupTarget = { ownerType: MaintenanceOwnerType; ownerId: string; sourceIds: string[] };

/* -------------------------------------------------------------------------- */
/* Notification cleanup (after the commit)                                     */
/* -------------------------------------------------------------------------- */

/**
 * Resolves the open reminder notifications of one schedule that are no longer
 * actionable (their sourceId and stateKey are not in the record's current
 * reminders). Runs after the completion or snooze committed, with the Admin SDK,
 * so the person needs no `notifications.view`. Only `sourceType ==` is queried
 * (no composite index); the sourceIds are matched here. A failure is reported as
 * `pending` by the caller: the hourly upkeep pass resolves the rest.
 */
export async function resolveScheduleNotifications(
  db: Firestore,
  householdId: string,
  target: CleanupTarget,
  ctx: Pick<OperationContext, 'actor' | 'now'>,
): Promise<number> {
  const house = householdRef(db, householdId);
  const [home, owner, notes] = await Promise.all([
    house.get(),
    house.collection(ownerCollection(target.ownerType)).doc(target.ownerId).get(),
    house.collection('notifications').where('sourceType', '==', sourceTypeOf(target.ownerType)).get(),
  ]);
  if (!home.exists || home.get('deletingAt')) return 0;
  const { timeZone, today } = householdDay(home, ctx.now);
  const sourceIds = new Set(target.sourceIds);
  const live = new Set<string>();
  if (owner.exists) {
    const data = { id: owner.id, ...owner.data() };
    const reminders = target.ownerType === 'home_asset'
      ? buildMaintenanceReminders([data as AssetInput], [], today, timeZone)
      : buildMaintenanceReminders([], [data as VehicleInput], today, timeZone);
    for (const reminder of actionableReminders(reminders)) live.add(`${reminder.sourceId}|${reminder.stateKey}`);
  }
  const open = notes.docs.filter(note => !note.get('resolvedAt')
    && sourceIds.has(note.get('sourceId'))
    && !live.has(`${note.get('sourceId')}|${note.get('stateKey')}`));
  if (open.length === 0) return 0;
  const batch = db.batch();
  const resolvedBy = { at: Timestamp.fromDate(ctx.now), uid: ctx.actor.uid, displayName: publicDisplayName(ctx.actor.name) };
  for (const note of open) batch.update(note.ref, { resolvedAt: Timestamp.fromDate(ctx.now), resolvedBy });
  await batch.commit();
  return open.length;
}

export type MaintenanceOperationOptions = {
  /** The cleanup step (tests replace it to simulate a failure). */
  cleanup?: typeof resolveScheduleNotifications;
};

const runCleanup = async (
  db: Firestore, householdId: string, target: CleanupTarget | null, ctx: OperationContext, options: MaintenanceOperationOptions,
  actorName: string,
): Promise<CleanupState> => {
  if (!target) return 'done';
  try {
    // `resolvedBy` names the person as the transaction resolved them (members see it).
    await (options.cleanup ?? resolveScheduleNotifications)(db, householdId, target, { now: ctx.now, actor: { ...ctx.actor, name: actorName } });
    return 'done';
  } catch (error) {
    // Never turns a saved completion into a failure: upkeep retries every hour.
    console.error('Maintenance notification cleanup failed', error);
    return 'pending';
  }
};

const cleanupOf = (value: unknown): CleanupTarget | null => {
  if (!value || typeof value !== 'object') return null;
  const entry = value as Record<string, unknown>;
  if ((entry.ownerType !== 'home_asset' && entry.ownerType !== 'vehicle') || typeof entry.ownerId !== 'string' || !Array.isArray(entry.sourceIds)) return null;
  return { ownerType: entry.ownerType, ownerId: entry.ownerId, sourceIds: entry.sourceIds.filter((id): id is string => typeof id === 'string') };
};

/* -------------------------------------------------------------------------- */
/* Completion                                                                  */
/* -------------------------------------------------------------------------- */

export type CompleteInput = {
  opId: unknown;
  ownerType: unknown;
  ownerId: unknown;
  /** The schedule's id, or its legacy key (`legacy-{index}-{slug}`) when it has none. */
  scheduleId: unknown;
  /** The cycle the person saw (the schedule's nextDueDate/nextDueMileage). */
  seen: unknown;
  completedDate: unknown;
  mileage?: unknown;
  nextDueDate?: unknown;
  nextDueMileage?: unknown;
  notes?: unknown;
  /** Details from the full log form (Log service). */
  details?: unknown;
};

const parseDetails = (value: unknown) => {
  if (value === undefined || value === null) return {};
  const details = recordOf(value);
  return {
    title: optionalText(details.title, 1000),
    type: enumOf(details.type, LOG_TYPES),
    cost: optionalNumber(details.cost, -MAX_COST, MAX_COST),
    partsUsed: optionalText(details.partsUsed, 20000),
    serviceProvider: optionalText(details.serviceProvider, 1000),
  };
};

/**
 * Completes one cycle of a schedule as the operation's actor: one routine log
 * (id derived from the op id), the schedule advanced by id, the vehicle's mileage
 * (max rule) and the ledger entry, all in one transaction; then the schedule's
 * reminder notifications are resolved (best effort, `cleanup`).
 *
 * A legacy schedule without an id gets its legacy key as a durable id in the
 * same write. The request names the cycle it saw: if that cycle was completed
 * already the answer is `already_done` (who, when); if the schedule moved on
 * otherwise it is `changed`. Nothing is written in either case.
 */
export async function completeMaintenanceScheduleAs(
  db: Firestore, householdId: string, input: CompleteInput, ctx: OperationContext, options: MaintenanceOperationOptions = {},
): Promise<CompleteResult> {
  const house = householdRef(db, householdId);
  const request = recordOf(input);
  const opId = opIdOf(request.opId);
  const ownerType = ownerTypeOf(request.ownerType);
  const ownerId = docIdOf(request.ownerId);
  const scheduleKey = scheduleIdOf(request.scheduleId);
  const seen = cycleIn(request.seen);
  const notes = optionalText(request.notes, 20000);
  const details = parseDetails(request.details);
  if (typeof request.completedDate !== 'string' || request.completedDate.length > 40) throw invalid();
  for (const value of [request.mileage, request.nextDueMileage]) {
    if (value !== undefined && value !== null && typeof value !== 'number') throw invalid();
  }
  if (request.nextDueDate !== undefined && request.nextDueDate !== null && (typeof request.nextDueDate !== 'string' || request.nextDueDate.length > 40)) throw invalid();

  const outcome = await db.runTransaction(async (tx): Promise<{ result: CompleteResult; cleanup: CleanupTarget | null; name?: string }> => {
    const { replay } = (await ctx.hooks?.precheck(tx)) ?? {};
    if (replay) {
      const stored = replay.summary.result as CompleteResult;
      return { result: stored, cleanup: cleanupOf(replay.summary.cleanup) };
    }
    const ownerRef = house.collection(ownerCollection(ownerType)).doc(ownerId);
    const [home, member, ledger, owner] = await tx.getAll(house, house.collection('members').doc(ctx.actor.uid), ledgerRef(house, opId), ownerRef);
    const { today } = householdDay(home, ctx.now);
    const stored = replayOf(ledger, 'complete', ctx);
    if (stored) {
      const result = stored as CompleteResult;
      return {
        result: result.status === 'completed' ? { ...result, replay: true } : result,
        cleanup: cleanupOf(ledger.get('cleanup')),
        name: typeof ledger.get('actorName') === 'string' ? ledger.get('actorName') : undefined,
      };
    }
    if (!owner.exists) return { result: { status: 'gone' }, cleanup: null };
    const listField = scheduleListField(ownerType);
    const { list } = withScheduleIds(owner.get(listField), ownerType);
    const found = findSchedule(list, scheduleKey);
    if (!found) return { result: { status: 'gone' }, cleanup: null };
    const name = actorName(member, ctx);
    const vehicle = ownerType === 'vehicle'
      ? { currentMileage: owner.get('currentMileage'), mileageUpdatedAt: owner.get('mileageUpdatedAt') }
      : null;
    const plan = planCompletion({
      ownerType,
      schedule: found.schedule,
      vehicle,
      seen,
      values: { completedDate: request.completedDate, mileage: request.mileage, nextDueDate: request.nextDueDate, nextDueMileage: request.nextDueMileage },
      today,
      completion: { opId, byUid: ctx.actor.uid, byName: name, completedDate: '', at: ctx.now.toISOString() },
    });
    if (plan.kind === 'already_done') {
      const { byName, completedDate, at } = plan.lastCompletion;
      return { result: { status: 'already_done', byName: publicDisplayName(byName), completedDate, at }, cleanup: null };
    }
    if (plan.kind === 'changed') return { result: { status: 'changed' }, cleanup: null };
    if (plan.kind === 'refused') return { result: { status: 'refused', reason: plan.reason }, cleanup: null };

    const scheduleId = String(found.schedule.id);
    const nextList = list.map((schedule, index) => (index === found.index ? compact(plan.schedule) : schedule));
    const nowIso = ctx.now.toISOString();
    tx.update(ownerRef, { [listField]: nextList, updatedAt: nowIso, ...toUpdate(plan.vehiclePatch) });

    const scheduleName = (ownerType === 'home_asset' ? found.schedule.scheduleName : found.schedule.serviceName) as string | undefined;
    const title = details.title || scheduleName || (ownerType === 'home_asset' ? 'Scheduled maintenance' : 'Scheduled service');
    const logId = `${stableSlugify(title).slice(0, 60) || 'service'}-${opId}`;
    const logRef = house.collection('maintenance').doc(logId);
    const record: CompletionRecord = { scheduleId, ownerType, ownerId, ...plan.record };
    tx.create(logRef, compact({
      householdId,
      targetType: ownerType,
      assetId: ownerType === 'home_asset' ? ownerId : null,
      vehicleId: ownerType === 'vehicle' ? ownerId : null,
      title,
      item: title,
      date: plan.schedule.lastCompletedDate,
      type: details.type || 'routine',
      notes,
      cost: details.cost,
      partsUsed: details.partsUsed,
      serviceProvider: details.serviceProvider,
      mileage: ownerType === 'vehicle' && typeof request.mileage === 'number' ? request.mileage : null,
      createdAt: nowIso,
      updatedAt: nowIso,
      doneByUid: ctx.actor.uid,
      doneByName: name,
      createdAtServer: FieldValue.serverTimestamp(),
      opId,
      completion: record,
      deviceAttribution: ctx.actor.device ?? null,
    }));

    const cleanup: CleanupTarget = {
      ownerType, ownerId,
      sourceIds: scheduleSourceIds(ownerId, scheduleId, legacyScheduleKey(found.schedule, found.index, ownerType), found.index),
    };
    const result: CompleteResult = { status: 'completed', opId, logId, next: plan.next, replay: false, cleanup: 'done' };
    tx.set(ledgerRef(house, opId), {
      kind: 'complete',
      actorUid: ctx.actor.uid,
      actorName: name,
      ownerType,
      ownerId,
      scheduleId,
      logId,
      appliedAt: Timestamp.fromDate(ctx.now),
      undoneAt: null,
      completion: record,
      cleanup,
      result,
    });
    ctx.hooks?.finalize(tx, { targetPath: logRef.path, summary: plain({ result, cleanup }), targetName: title });
    return { result, cleanup, name };
  });

  if (outcome.result.status !== 'completed') return outcome.result;
  return { ...outcome.result, cleanup: await runCleanup(db, householdId, outcome.cleanup, ctx, options, outcome.name ?? publicDisplayName(ctx.actor.name)) };
}

/* -------------------------------------------------------------------------- */
/* Undo                                                                        */
/* -------------------------------------------------------------------------- */

const windowOpen = (appliedAt: unknown, now: Date) =>
  appliedAt instanceof Timestamp && now.getTime() <= appliedAt.toMillis() + UNDO_WINDOW_MS + MAINTENANCE_UNDO_GRACE_MS;

/** Reads the ledger entry an Undo names and checks who and when; returns it or an answer. */
const undoEntry = (entry: DocumentSnapshot, kind: OpKind, ctx: OperationContext): UndoResult | null => {
  if (!entry.exists) throw new MaintenanceOperationError('not_found');
  if (entry.get('kind') !== kind) throw new MaintenanceOperationError('conflict');
  // Only the person who made the change can take it back (a device passes that person).
  if (entry.get('actorUid') !== ctx.actor.uid) throw new MaintenanceOperationError('forbidden');
  if (entry.get('undoneAt')) return { status: 'already_undone' };
  if (!windowOpen(entry.get('appliedAt'), ctx.now)) return { status: 'expired' };
  return null;
};

const fieldValuesOf = (value: unknown): FieldValues => (value && typeof value === 'object' && !Array.isArray(value) ? value as FieldValues : {});

/**
 * Undoes a completion within the Undo window (10 s plus a 5 s server grace,
 * measured from the ledger's `appliedAt`): the log is deleted and every field
 * the completion changed goes back only while it still holds the completion's
 * value. A field someone changed since keeps its value and is returned in
 * `kept`. A schedule completed again since is `superseded` (nothing changes, the
 * log stays). A schedule or record deleted since is not brought back.
 */
export async function undoMaintenanceCompletionAs(db: Firestore, householdId: string, input: { opId: unknown }, ctx: OperationContext): Promise<UndoResult> {
  const house = householdRef(db, householdId);
  const opId = opIdOf(recordOf(input).opId);
  return db.runTransaction(async tx => {
    const { replay } = (await ctx.hooks?.precheck(tx)) ?? {};
    if (replay) return replay.summary.result as UndoResult;
    const [home, entry] = await tx.getAll(house, ledgerRef(house, opId));
    householdDay(home, ctx.now);
    const answer = undoEntry(entry, 'complete', ctx);
    if (answer) return answer;
    const record = entry.get('completion') as CompletionRecord;
    const ownerType = ownerTypeOf(record.ownerType);
    const ownerRef = house.collection(ownerCollection(ownerType)).doc(docIdOf(record.ownerId));
    const logRef = house.collection('maintenance').doc(docIdOf(entry.get('logId')));
    const [owner, log] = await tx.getAll(ownerRef, logRef);
    const listField = scheduleListField(ownerType);
    const list: StoredSchedule[] = owner.exists && Array.isArray(owner.get(listField)) ? owner.get(listField) : [];
    const found = owner.exists ? findSchedule(list, record.scheduleId) : null;
    const plan = planUndoCompletion({
      opId,
      schedule: found?.schedule ?? null,
      vehicle: owner.exists && ownerType === 'vehicle' ? { currentMileage: owner.get('currentMileage'), mileageUpdatedAt: owner.get('mileageUpdatedAt') } : null,
      record: { before: fieldValuesOf(record.before), after: fieldValuesOf(record.after) },
    });
    if (plan.kind === 'superseded') return { status: 'superseded' } as UndoResult;
    if (owner.exists) {
      const update: Record<string, unknown> = toUpdate(plan.vehiclePatch);
      if (found && plan.schedule) update[listField] = list.map((schedule, index) => (index === found.index ? compact(plan.schedule!) : schedule));
      if (Object.keys(update).length > 0) tx.update(ownerRef, { ...update, updatedAt: ctx.now.toISOString() });
    }
    if (log.exists) tx.delete(logRef);
    const result: UndoResult = { status: 'undone', kept: plain(plan.kept) };
    tx.update(entry.ref, { undoneAt: Timestamp.fromDate(ctx.now), undoResult: result });
    ctx.hooks?.finalize(tx, { targetPath: ownerRef.path, summary: { result }, undo: 'reversed' });
    return result;
  });
}

/* -------------------------------------------------------------------------- */
/* Snooze                                                                      */
/* -------------------------------------------------------------------------- */

export type SnoozeInput = { opId: unknown; ownerType: unknown; ownerId: unknown; scheduleId: unknown; seen: unknown };

/**
 * Snoozes one schedule's current cycle by a week (MA-3b): only `nextDueDate` and
 * `snoozedUntil` of the schedule named by id change, under the reminder card's
 * eligibility rules, if the cycle is still the one the person saw.
 */
export async function snoozeMaintenanceScheduleAs(
  db: Firestore, householdId: string, input: SnoozeInput, ctx: OperationContext, options: MaintenanceOperationOptions = {},
): Promise<SnoozeResult> {
  const house = householdRef(db, householdId);
  const request = recordOf(input);
  const opId = opIdOf(request.opId);
  const ownerType = ownerTypeOf(request.ownerType);
  const ownerId = docIdOf(request.ownerId);
  const scheduleKey = scheduleIdOf(request.scheduleId);
  const seen = cycleIn(request.seen);

  const outcome = await db.runTransaction(async (tx): Promise<{ result: SnoozeResult; cleanup: CleanupTarget | null; name?: string }> => {
    const { replay } = (await ctx.hooks?.precheck(tx)) ?? {};
    if (replay) return { result: replay.summary.result as SnoozeResult, cleanup: cleanupOf(replay.summary.cleanup) };
    const ownerRef = house.collection(ownerCollection(ownerType)).doc(ownerId);
    const [home, member, ledger, owner] = await tx.getAll(house, house.collection('members').doc(ctx.actor.uid), ledgerRef(house, opId), ownerRef);
    const { timeZone, today } = householdDay(home, ctx.now);
    const stored = replayOf(ledger, 'snooze', ctx);
    if (stored) {
      const result = stored as SnoozeResult;
      return {
        result: result.status === 'snoozed' ? { ...result, replay: true } : result,
        cleanup: cleanupOf(ledger.get('cleanup')),
        name: typeof ledger.get('actorName') === 'string' ? ledger.get('actorName') : undefined,
      };
    }
    if (!owner.exists) return { result: { status: 'gone' }, cleanup: null };
    const listField = scheduleListField(ownerType);
    const { list } = withScheduleIds(owner.get(listField), ownerType);
    const found = findSchedule(list, scheduleKey);
    if (!found) return { result: { status: 'gone' }, cleanup: null };
    const plan = planSnooze({ ownerType, owner: { id: owner.id, ...owner.data() }, schedule: found.schedule, seen, today, timeZone });
    if (plan.kind !== 'apply') return { result: plan.kind === 'changed' ? { status: 'changed' } : { status: 'refused', reason: plan.reason }, cleanup: null };
    const scheduleId = String(found.schedule.id);
    const name = actorName(member, ctx);
    tx.update(ownerRef, {
      [listField]: list.map((schedule, index) => (index === found.index ? compact(plan.schedule) : schedule)),
      updatedAt: ctx.now.toISOString(),
    });
    const cleanup: CleanupTarget = {
      ownerType, ownerId,
      sourceIds: scheduleSourceIds(ownerId, scheduleId, legacyScheduleKey(found.schedule, found.index, ownerType), found.index),
    };
    const result: SnoozeResult = { status: 'snoozed', opId, nextDueDate: plan.nextDueDate, replay: false, cleanup: 'done' };
    tx.set(ledgerRef(house, opId), {
      kind: 'snooze',
      actorUid: ctx.actor.uid,
      actorName: name,
      ownerType,
      ownerId,
      scheduleId,
      appliedAt: Timestamp.fromDate(ctx.now),
      undoneAt: null,
      before: plan.before,
      after: plan.after,
      cleanup,
      result,
    });
    ctx.hooks?.finalize(tx, { targetPath: ownerRef.path, summary: plain({ result, cleanup }) });
    return { result, cleanup, name };
  });

  if (outcome.result.status !== 'snoozed') return outcome.result;
  return { ...outcome.result, cleanup: await runCleanup(db, householdId, outcome.cleanup, ctx, options, outcome.name ?? publicDisplayName(ctx.actor.name)) };
}

/** Undoes a snooze (compare-and-revert of nextDueDate and snoozedUntil). */
export async function undoMaintenanceSnoozeAs(db: Firestore, householdId: string, input: { opId: unknown }, ctx: OperationContext): Promise<UndoResult> {
  const house = householdRef(db, householdId);
  const opId = opIdOf(recordOf(input).opId);
  return db.runTransaction(async tx => {
    const { replay } = (await ctx.hooks?.precheck(tx)) ?? {};
    if (replay) return replay.summary.result as UndoResult;
    const [home, entry] = await tx.getAll(house, ledgerRef(house, opId));
    householdDay(home, ctx.now);
    const answer = undoEntry(entry, 'snooze', ctx);
    if (answer) return answer;
    const ownerType = ownerTypeOf(entry.get('ownerType'));
    const ownerRef = house.collection(ownerCollection(ownerType)).doc(docIdOf(entry.get('ownerId')));
    const owner = await tx.get(ownerRef);
    const listField = scheduleListField(ownerType);
    const list: StoredSchedule[] = owner.exists && Array.isArray(owner.get(listField)) ? owner.get(listField) : [];
    const found = owner.exists ? findSchedule(list, String(entry.get('scheduleId'))) : null;
    let kept: KeptField[] = [];
    if (found) {
      const plan = planUndoSnooze(found.schedule, fieldValuesOf(entry.get('before')), fieldValuesOf(entry.get('after')));
      kept = plan.kept;
      tx.update(ownerRef, {
        [listField]: list.map((schedule, index) => (index === found.index ? compact(plan.schedule) : schedule)),
        updatedAt: ctx.now.toISOString(),
      });
    }
    const result: UndoResult = { status: 'undone', kept: plain(kept) };
    tx.update(entry.ref, { undoneAt: Timestamp.fromDate(ctx.now), undoResult: result });
    ctx.hooks?.finalize(tx, { targetPath: ownerRef.path, summary: { result }, undo: 'reversed' });
    return result;
  });
}

/* -------------------------------------------------------------------------- */
/* Edits                                                                       */
/* -------------------------------------------------------------------------- */

type FieldSpec =
  | { kind: 'text'; max: number; required?: boolean }
  | { kind: 'day' }
  | { kind: 'number'; min: number; max: number; integer?: boolean }
  | { kind: 'enum'; values: readonly string[] };

/**
 * Normalizes one form field. Types and sizes are checked always (fail closed);
 * formats and ranges (a real day, a required name, an integer mileage, a known
 * option) only for values the form changed, so an untouched legacy value never
 * blocks an unrelated edit.
 */
const normalize = (spec: FieldSpec, value: unknown): unknown => {
  if (value === undefined || value === null || value === '') return null;
  switch (spec.kind) {
    case 'text':
      if (typeof value !== 'string' || value.length > spec.max) throw invalid();
      return value.trim() || null;
    case 'day':
    case 'enum':
      if (typeof value !== 'string' || value.length > 40) throw invalid();
      return value;
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) throw invalid();
      return value;
  }
};

const checkFormat = (spec: FieldSpec, value: unknown) => {
  if (spec.kind === 'text' && spec.required && value === null) throw invalid();
  if (value === null) return;
  if (spec.kind === 'day' && !isRealDay(value)) throw invalid();
  if (spec.kind === 'enum' && !spec.values.includes(value as string)) throw invalid();
  if (spec.kind === 'number') optionalNumber(value, spec.min, spec.max, spec.integer);
};

const normalizeRecord = (specs: Record<string, FieldSpec>, value: unknown) => {
  const source = value === undefined || value === null ? {} : recordOf(value);
  return Object.fromEntries(Object.entries(specs).map(([field, spec]) => [field, normalize(spec, source[field])]));
};

const ASSET_SPECS: Record<string, FieldSpec> = {
  name: { kind: 'text', max: 1000, required: true },
  category: { kind: 'text', max: 1000 },
  location: { kind: 'text', max: 1000 },
  brand: { kind: 'text', max: 1000 },
  model: { kind: 'text', max: 1000 },
  serialNumber: { kind: 'text', max: 1000 },
  purchaseDate: { kind: 'day' },
  purchasePrice: { kind: 'number', min: -MAX_COST, max: MAX_COST },
  warrantyExpiration: { kind: 'day' },
  warrantyProvider: { kind: 'text', max: 1000 },
  status: { kind: 'enum', values: ['active', 'needs_attention', 'retired'] },
  notes: { kind: 'text', max: 20000 },
};

const VEHICLE_SPECS: Record<string, FieldSpec> = {
  nickname: { kind: 'text', max: 1000, required: true },
  year: { kind: 'number', min: 1800, max: 3000, integer: true },
  make: { kind: 'text', max: 1000 },
  model: { kind: 'text', max: 1000 },
  trim: { kind: 'text', max: 1000 },
  vin: { kind: 'text', max: 1000 },
  licensePlate: { kind: 'text', max: 1000 },
  currentMileage: { kind: 'number', min: 0, max: 2_000_000, integer: true },
  purchaseDate: { kind: 'day' },
  purchasePrice: { kind: 'number', min: -MAX_COST, max: MAX_COST },
  insuranceProvider: { kind: 'text', max: 1000 },
  registrationExpiration: { kind: 'day' },
  inspectionExpiration: { kind: 'day' },
  status: { kind: 'enum', values: ['active', 'needs_attention', 'retired', 'sold'] },
  notes: { kind: 'text', max: 20000 },
};

const MODE: FieldSpec = { kind: 'enum', values: ['scheduled', 'checklist'] };
const ASSET_SCHEDULE_SPECS: Record<string, FieldSpec> = {
  mode: MODE,
  scheduleName: { kind: 'text', max: 1000, required: true },
  frequencyType: { kind: 'enum', values: ['days', 'weeks', 'months', 'years'] },
  intervalValue: { kind: 'number', min: 1, max: 10000, integer: true },
  lastCompletedDate: { kind: 'day' },
  nextDueDate: { kind: 'day' },
  snoozedUntil: { kind: 'day' },
};
const VEHICLE_SCHEDULE_SPECS: Record<string, FieldSpec> = {
  mode: MODE,
  serviceName: { kind: 'text', max: 1000, required: true },
  intervalMiles: { kind: 'number', min: 1, max: 2_000_000, integer: true },
  intervalMonths: { kind: 'number', min: 1, max: 1200, integer: true },
  lastCompletedMileage: { kind: 'number', min: 0, max: 2_000_000, integer: true },
  lastCompletedDate: { kind: 'day' },
  nextDueMileage: { kind: 'number', min: 0, max: 2_000_000, integer: true },
  nextDueDate: { kind: 'day' },
  snoozedUntil: { kind: 'day' },
};

const LOG_SPECS: Record<string, FieldSpec> = {
  targetType: { kind: 'enum', values: ['general', 'home_asset', 'vehicle'] },
  assetId: { kind: 'text', max: 1500 },
  vehicleId: { kind: 'text', max: 1500 },
  title: { kind: 'text', max: 1000, required: true },
  date: { kind: 'day' },
  type: { kind: 'enum', values: LOG_TYPES },
  notes: { kind: 'text', max: 20000 },
  cost: { kind: 'number', min: -MAX_COST, max: MAX_COST },
  partsUsed: { kind: 'text', max: 20000 },
  serviceProvider: { kind: 'text', max: 1000 },
  mileage: { kind: 'number', min: 0, max: 2_000_000, integer: true },
};

const MAX_SCHEDULES = 100;

const normalizeSchedules = (value: unknown, specs: Record<string, FieldSpec>): StoredSchedule[] => {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > MAX_SCHEDULES) throw invalid();
  const ids = new Set<string>();
  return value.map(entry => {
    const source = recordOf(entry);
    const id = scheduleIdOf(source.id);
    if (ids.has(id)) throw invalid();
    ids.add(id);
    return { id, ...normalizeRecord(specs, source) };
  });
};

/** Checks the formats of what the form changed (and of every field on a create). */
const checkChanged = (specs: Record<string, FieldSpec>, base: Record<string, unknown> | null, values: Record<string, unknown>) => {
  for (const [field, spec] of Object.entries(specs)) {
    if (base && JSON.stringify(base[field] ?? null) === JSON.stringify(values[field] ?? null)) continue;
    checkFormat(spec, values[field]);
  }
};

const checkSchedules = (specs: Record<string, FieldSpec>, base: StoredSchedule[] | null, values: StoredSchedule[]) => {
  const baseById = new Map((base ?? []).map(schedule => [schedule.id, schedule]));
  for (const schedule of values) checkChanged(specs, baseById.get(schedule.id) ?? null, schedule);
};

export type SaveInput = { opId: unknown; id?: unknown; base?: unknown; values: unknown };

/** A new record's id: readable slug plus a part of the op id (random, and the same on a retry). */
const newRecordId = (name: string, opId: string, fallback: string) =>
  `${stableSlugify(name).slice(0, 60) || fallback}-${opId.replace(/-/g, '').slice(0, 10).toLowerCase()}`;

type RecordKind = { kind: 'save_asset' | 'save_vehicle'; ownerType: MaintenanceOwnerType; specs: Record<string, FieldSpec>; scheduleSpecs: Record<string, FieldSpec>; nameField: string };

const ASSET_KIND: RecordKind = { kind: 'save_asset', ownerType: 'home_asset', specs: ASSET_SPECS, scheduleSpecs: ASSET_SCHEDULE_SPECS, nameField: 'name' };
const VEHICLE_KIND: RecordKind = { kind: 'save_vehicle', ownerType: 'vehicle', specs: VEHICLE_SPECS, scheduleSpecs: VEHICLE_SCHEDULE_SPECS, nameField: 'nickname' };

async function saveRecordAs(db: Firestore, householdId: string, input: SaveInput, ctx: OperationContext, spec: RecordKind): Promise<SaveResult> {
  const house = householdRef(db, householdId);
  const request = recordOf(input);
  const opId = opIdOf(request.opId);
  const existingId = request.id === undefined || request.id === null ? null : docIdOf(request.id);
  const listField = scheduleListField(spec.ownerType);
  const scheduleFields = spec.ownerType === 'home_asset' ? ASSET_SCHEDULE_FIELDS : VEHICLE_SCHEDULE_FIELDS;
  const values = normalizeRecord(spec.specs, request.values);
  const valueSchedules = normalizeSchedules(recordOf(request.values)[listField], spec.scheduleSpecs);
  const base = existingId ? normalizeRecord(spec.specs, request.base) : null;
  const baseSchedules = existingId ? normalizeSchedules(recordOf(request.base)[listField], spec.scheduleSpecs) : null;
  checkChanged(spec.specs, base, values);
  checkSchedules(spec.scheduleSpecs, baseSchedules, valueSchedules);

  return db.runTransaction(async tx => {
    const { replay } = (await ctx.hooks?.precheck(tx)) ?? {};
    if (replay) return replay.summary.result as SaveResult;
    const id = existingId ?? newRecordId(String(values[spec.nameField] ?? ''), opId, spec.ownerType === 'home_asset' ? 'asset' : 'vehicle');
    const ref = house.collection(ownerCollection(spec.ownerType)).doc(id);
    const [home, member, ledger, current] = await tx.getAll(house, house.collection('members').doc(ctx.actor.uid), ledgerRef(house, opId), ref);
    const { today } = householdDay(home, ctx.now);
    const stored = replayOf(ledger, spec.kind, ctx);
    if (stored) return { ...(stored as SaveResult), replay: true };
    const nowIso = ctx.now.toISOString();
    let created = false;
    if (!existingId) {
      // An id from the op id is new unless this op already ran (the ledger said no).
      if (current.exists) throw new MaintenanceOperationError('conflict');
      tx.create(ref, compact({
        householdId,
        ...values,
        [listField]: valueSchedules.map(schedule => compact(schedule)),
        ...(spec.ownerType === 'vehicle' && typeof values.currentMileage === 'number' ? { mileageUpdatedAt: today } : {}),
        createdAt: nowIso,
        updatedAt: nowIso,
      }));
      created = true;
    } else {
      // Never resurrects a record deleted meanwhile.
      if (!current.exists) throw new MaintenanceOperationError('not_found');
      const storedSchedules = withScheduleIds(current.get(listField), spec.ownerType).list;
      const plan = planRecordEdit({
        stored: current.data() ?? {},
        base: base!,
        values,
        fields: Object.keys(spec.specs),
        schedules: { field: listField, fields: scheduleFields, stored: storedSchedules, base: baseSchedules!, values: valueSchedules },
      });
      if (plan.changed) {
        const patch = { ...plan.patch };
        if (Array.isArray(patch[listField])) patch[listField] = (patch[listField] as StoredSchedule[]).map(schedule => compact(schedule));
        if (spec.ownerType === 'vehicle' && 'currentMileage' in patch) patch.mileageUpdatedAt = patch.currentMileage === null ? null : today;
        tx.update(ref, { ...toUpdate(patch), updatedAt: nowIso });
      }
    }
    const result: SaveResult = { status: 'saved', id, created, replay: false };
    tx.set(ledgerRef(house, opId), {
      kind: spec.kind,
      actorUid: ctx.actor.uid,
      actorName: actorName(member, ctx),
      ownerType: spec.ownerType,
      ownerId: id,
      appliedAt: Timestamp.fromDate(ctx.now),
      result,
    });
    ctx.hooks?.finalize(tx, { targetPath: ref.path, summary: { result } });
    return result;
  });
}

/**
 * Saves a home asset from the edit form: `{ id?, base, values }`. For an existing
 * asset only the fields whose value differs from `base` are written onto the
 * freshly read document, and schedules are merged by id (see `mergeSchedules`),
 * so a completion or snooze that happened meanwhile survives an unrelated edit.
 */
export const saveHomeAssetAs = (db: Firestore, householdId: string, input: SaveInput, ctx: OperationContext) =>
  saveRecordAs(db, householdId, input, ctx, ASSET_KIND);

/** Saves a vehicle the same way. An explicit current-mileage change is written as entered (a correction). */
export const saveVehicleAs = (db: Firestore, householdId: string, input: SaveInput, ctx: OperationContext) =>
  saveRecordAs(db, householdId, input, ctx, VEHICLE_KIND);

/**
 * Saves a maintenance log. A new log records who wrote it (`doneByUid`,
 * `doneByName`, `createdAtServer`, `opId`); an edit writes only the fields the
 * form changed and can never change those, nor a completion's record. A vehicle
 * log's mileage raises the vehicle's current mileage (max rule).
 */
export async function saveMaintenanceLogAs(db: Firestore, householdId: string, input: SaveInput, ctx: OperationContext): Promise<SaveResult> {
  const house = householdRef(db, householdId);
  const request = recordOf(input);
  const opId = opIdOf(request.opId);
  const existingId = request.id === undefined || request.id === null ? null : docIdOf(request.id);
  const values = normalizeRecord(LOG_SPECS, request.values);
  const base = existingId ? normalizeRecord(LOG_SPECS, request.base) : null;
  checkChanged(LOG_SPECS, base, values);
  // The target follows the target type; other target fields are cleared.
  const targetType = (values.targetType ?? 'general') as 'general' | 'home_asset' | 'vehicle';
  values.targetType = targetType;
  if (targetType !== 'home_asset') values.assetId = null;
  if (targetType !== 'vehicle') { values.vehicleId = null; values.mileage = null; }
  if (targetType === 'home_asset' && !values.assetId) throw invalid();
  if (targetType === 'vehicle' && !values.vehicleId) throw invalid();
  if (!existingId && !values.date) throw invalid();

  return db.runTransaction(async tx => {
    const { replay } = (await ctx.hooks?.precheck(tx)) ?? {};
    if (replay) return replay.summary.result as SaveResult;
    const id = existingId ?? newRecordId(String(values.title ?? ''), opId, 'log');
    const ref = house.collection('maintenance').doc(id);
    const targetRef = targetType === 'home_asset' ? house.collection('home-assets').doc(docIdOf(values.assetId))
      : targetType === 'vehicle' ? house.collection('vehicles').doc(docIdOf(values.vehicleId)) : null;
    const [home, member, ledger, current, target] = await tx.getAll(
      house, house.collection('members').doc(ctx.actor.uid), ledgerRef(house, opId), ref, ...(targetRef ? [targetRef] : []),
    );
    const { today } = householdDay(home, ctx.now);
    const stored = replayOf(ledger, 'save_log', ctx);
    if (stored) return { ...(stored as SaveResult), replay: true };
    const name = actorName(member, ctx);
    const nowIso = ctx.now.toISOString();
    let mileageChanged = false;
    let created = false;
    if (!existingId) {
      if (current.exists) throw new MaintenanceOperationError('conflict');
      if (targetRef && !target?.exists) throw new MaintenanceOperationError('not_found');
      tx.create(ref, compact({
        householdId,
        ...values,
        item: values.title,
        createdAt: nowIso,
        updatedAt: nowIso,
        doneByUid: ctx.actor.uid,
        doneByName: name,
        createdAtServer: FieldValue.serverTimestamp(),
        opId,
        deviceAttribution: ctx.actor.device ?? null,
      }));
      mileageChanged = typeof values.mileage === 'number';
      created = true;
    } else {
      if (!current.exists) throw new MaintenanceOperationError('not_found');
      // A log about a record that still exists keeps pointing at it; a new target must exist.
      const plan = planRecordEdit({ stored: current.data() ?? {}, base: base!, values, fields: Object.keys(LOG_SPECS) });
      if (('assetId' in plan.patch || 'vehicleId' in plan.patch) && targetRef && !target?.exists) throw new MaintenanceOperationError('not_found');
      if (plan.changed) {
        const patch = { ...plan.patch };
        if ('title' in patch) patch.item = patch.title;
        tx.update(ref, { ...toUpdate(patch), updatedAt: nowIso });
      }
      mileageChanged = 'mileage' in plan.patch && typeof values.mileage === 'number';
    }
    if (mileageChanged && target?.exists && targetType === 'vehicle') {
      const patch = mileagePatch({ currentMileage: target.get('currentMileage') }, values.mileage as number, today);
      if (Object.keys(patch).length > 0) tx.update(target.ref, patch as { [field: string]: number | string });
    }
    const result: SaveResult = { status: 'saved', id, created, replay: false };
    tx.set(ledgerRef(house, opId), {
      kind: 'save_log',
      actorUid: ctx.actor.uid,
      actorName: name,
      ownerType: targetType,
      ownerId: id,
      logId: id,
      appliedAt: Timestamp.fromDate(ctx.now),
      result,
    });
    ctx.hooks?.finalize(tx, { targetPath: ref.path, summary: { result } });
    return result;
  });
}

