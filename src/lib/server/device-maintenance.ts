import 'server-only';

import { adminDb } from '@/lib/server/firebase-admin';
import { exceedsPayloadBudget } from '@/ai/action-auth';
import { withoutEmails } from '@/lib/devices/without-emails';
import { authorizeDeviceAction, DEVICE_REQUEST_MAX_BYTES, type DeviceAuthority } from '@/lib/server/device-gate';
import { DeviceActionError } from '@/lib/server/device-errors';
import { deviceOperationContext } from '@/lib/server/operation-context';
import type { DeviceCapability } from '@/lib/devices/action-policy';
import {
  MaintenanceOperationError,
  completeMaintenanceScheduleAs,
  deleteMaintenanceLogAs,
  saveHomeAssetAs,
  saveMaintenanceLogAs,
  saveVehicleAs,
  snoozeMaintenanceScheduleAs,
  undoMaintenanceCompletionAs,
  undoMaintenanceLogAs,
  undoMaintenanceSnoozeAs,
  type CompleteResult,
  type DeleteLogResult,
  type DeviceUndoAnswer,
  type LogUndoResult,
  type MaintenanceOperationOptions,
  type SaveResult,
  type SnoozeResult,
  type UndoResult,
} from '@/lib/server/maintenance-operations';

// Maintenance from a registered wall tablet (docs/modules/devices/README.md, "Device actions:
// maintenance (M8a)"; audit 15, 16.2, 17.2; WT-6a/6b, WT-18, WT-20, WT-22). Each passes the
// device action gate (`authorizeDeviceAction`: the tablet, its household and generation, the
// person chosen in "Who's here?", that person's own maintenance permissions (completing needs
// both maintenance.edit and maintenance.createLogs, `permissionsAll`), the Maintenance section
// switch, the level: Done, Log service and Snooze face once their Undo is proven, editing
// schedules and deleting a log at PIN level, never the points PIN), then runs the Maintenance
// Center's own operation (src/lib/server/maintenance-operations.ts) with the gate's hooks
// inside that operation's transaction: precheck first, finalize last. Requests are built here
// from an allow-list: the author, the device, the level and the opId never come from the
// client's fields (the opId is the gate's, validated and lower-cased).

export type DeviceMaintenanceRequest = {
  idToken: unknown;
  householdId: unknown;
  actorUid: unknown;
  pinSessionId?: unknown;
  opId: unknown;
  queued?: { createdAt: string; generation?: unknown };
};

/** `clock`: the server clock (the real time unless a test injects one); `cleanup`: tests replace the reminder cleanup. */
export type DeviceMaintenanceOptions = { clock?: () => Date; clientAddress?: string; cleanup?: MaintenanceOperationOptions['cleanup'] };

/** A face action's request (ids, a cycle, a few fields of text): the gate's 16 KB. */
const FACE_MAX_BYTES = DEVICE_REQUEST_MAX_BYTES;
/** Editing schedules carries up to 100 schedules twice (what the form opened with and its values), as the personal action allows. */
const SCHEDULES_MAX_BYTES = 96 * 1024;

const sized = (input: unknown, max: number) => {
  if (!input || typeof input !== 'object' || exceedsPayloadBudget(input, max)) throw new DeviceActionError('invalid_input');
};

const authorize = (capability: DeviceCapability, input: DeviceMaintenanceRequest, options: DeviceMaintenanceOptions) => authorizeDeviceAction({
  idToken: input.idToken as string,
  householdId: input.householdId as string,
  capability,
  actorUid: typeof input.actorUid === 'string' ? input.actorUid : undefined,
  pinSessionId: typeof input.pinSessionId === 'string' ? input.pinSessionId : undefined,
  opId: input.opId as string,
  // The gate refuses a queued entry whose generation is missing or not the token's.
  ...(input.queued && typeof input.queued.createdAt === 'string' ? { queued: { createdAt: input.queued.createdAt, generation: input.queued.generation as number } } : {}),
}, { clientAddress: options.clientAddress, clock: options.clock });

/** Maintenance errors as device refusals (bad input, an opId reused, a person who may not). */
const asDeviceError = (error: unknown): never => {
  if (error instanceof MaintenanceOperationError) {
    if (error.code === 'conflict') throw new DeviceActionError('conflict');
    if (error.code === 'forbidden') throw new DeviceActionError('forbidden');
    throw new DeviceActionError('invalid_input');
  }
  throw error;
};

/**
 * Binds a retried opId to what it first acted on (as Pets does): the maintenance ledger entry
 * for this opId, once written, never changes its kind or target, so an opId sent again for
 * another record (or another kind) is a `conflict`, never the first record's answer.
 */
const assertSameTarget = async (authority: DeviceAuthority, kind: string, target: { ownerType?: unknown; ownerId?: unknown }) => {
  const entry = await adminDb.collection('households').doc(authority.householdId).collection('maintenance-ops').doc(authority.opId!).get();
  if (!entry.exists) return;
  if (entry.get('kind') !== kind) throw new DeviceActionError('conflict');
  if (target.ownerType !== undefined && entry.get('ownerType') !== target.ownerType) throw new DeviceActionError('conflict');
  if (target.ownerId !== undefined && entry.get('ownerId') !== target.ownerId) throw new DeviceActionError('conflict');
};

const levelOf = (authority: DeviceAuthority): 'face' | 'pin' => (authority.level === 'pin' ? 'pin' : 'face');

const undoContext = (authority: DeviceAuthority) => ({ ...deviceOperationContext(authority), authority });

/** Plain objects without emails (WT-10e). */
const answer = <T,>(value: T): T => withoutEmails(JSON.parse(JSON.stringify(value)) as T);

// --- Done (maintenance.complete) ----------------------------------------------------------

export type CompleteIntent = {
  ownerType: unknown;
  ownerId: unknown;
  scheduleId: unknown;
  /** The cycle the tablet showed (its nextDueDate / nextDueMileage): a moved cycle is `changed`. */
  seen: unknown;
  completedDate: unknown;
  mileage?: unknown;
  nextDueDate?: unknown;
  nextDueMileage?: unknown;
  notes?: unknown;
  details?: unknown;
};

export type DeviceCompleteResult = { result: CompleteResult; level: 'face' | 'pin' };

/**
 * `maintenance.complete`: one cycle of a schedule, credited to the selected person (the
 * log's `doneByUid`/`doneByName`, the schedule's `lastCompletion`) with the tablet's
 * `deviceAttribution` on the log. A queued Done whose cycle moved meanwhile is answered
 * `changed` and writes nothing (the tablet drops it with a plain notice).
 */
export async function completeFromTablet(input: DeviceMaintenanceRequest & CompleteIntent, options: DeviceMaintenanceOptions = {}): Promise<DeviceCompleteResult> {
  sized(input, FACE_MAX_BYTES);
  const authority = await authorize('maintenance.complete', input, options);
  await assertSameTarget(authority, 'complete', { ownerType: input.ownerType, ownerId: input.ownerId });
  const result = await completeMaintenanceScheduleAs(adminDb, authority.householdId, {
    opId: authority.opId, ownerType: input.ownerType, ownerId: input.ownerId, scheduleId: input.scheduleId, seen: input.seen,
    completedDate: input.completedDate, mileage: input.mileage, nextDueDate: input.nextDueDate, nextDueMileage: input.nextDueMileage,
    notes: input.notes, details: input.details,
  }, deviceOperationContext(authority), { cleanup: options.cleanup }).catch(asDeviceError);
  return { result: answer(result), level: levelOf(authority) };
}

export type DeviceUndoResult = UndoResult | DeviceUndoAnswer;

/**
 * `maintenance.complete.undo`: by the original's opId only (the same tablet and credential
 * generation, the same person, the window). Compare-and-revert as on a phone; a schedule
 * completed again since is `changed_since`; a log with files is answered `has_attachments`.
 */
export async function undoCompleteFromTablet(input: DeviceMaintenanceRequest, options: DeviceMaintenanceOptions = {}): Promise<DeviceUndoResult> {
  sized(input, FACE_MAX_BYTES);
  const authority = await authorize('maintenance.complete.undo', input, options);
  const result = await undoMaintenanceCompletionAs(adminDb, authority.householdId, { opId: authority.opId }, undoContext(authority)).catch(asDeviceError);
  if (result.status === 'superseded') throw new DeviceActionError('changed_since');
  return answer(result);
}

// --- Log service (maintenance.log) --------------------------------------------------------

/** The fields of a new log a tablet may send (never an id, a base, an author or a completion). */
export type LogIntent = {
  values: {
    targetType?: unknown; assetId?: unknown; vehicleId?: unknown; title?: unknown; date?: unknown; type?: unknown;
    notes?: unknown; cost?: unknown; partsUsed?: unknown; serviceProvider?: unknown; mileage?: unknown;
  };
};

const LOG_FIELDS = ['targetType', 'assetId', 'vehicleId', 'title', 'date', 'type', 'notes', 'cost', 'partsUsed', 'serviceProvider', 'mileage'] as const;

export type DeviceLogResult = { result: SaveResult | { status: 'gone' }; level: 'face' | 'pin' };

/**
 * `maintenance.log`: a new maintenance log (never an edit: no id or base is forwarded), credited
 * to the selected person, with the tablet's `deviceAttribution`; a vehicle reading raises the
 * vehicle's mileage by the max rule. A target record deleted meanwhile is `gone`.
 */
export async function logFromTablet(input: DeviceMaintenanceRequest & LogIntent, options: DeviceMaintenanceOptions = {}): Promise<DeviceLogResult> {
  sized(input, FACE_MAX_BYTES);
  const source = input.values && typeof input.values === 'object' && !Array.isArray(input.values) ? input.values as Record<string, unknown> : null;
  if (!source) throw new DeviceActionError('invalid_input');
  const values = Object.fromEntries(LOG_FIELDS.filter(field => field in source).map(field => [field, source[field]]));
  const authority = await authorize('maintenance.log', input, options);
  await assertSameTarget(authority, 'save_log', { ownerType: values.targetType ?? 'general' });
  try {
    const result = await saveMaintenanceLogAs(adminDb, authority.householdId, { opId: authority.opId, values }, deviceOperationContext(authority));
    return { result: answer(result), level: levelOf(authority) };
  } catch (error) {
    if (error instanceof MaintenanceOperationError && error.code === 'not_found') return { result: { status: 'gone' }, level: levelOf(authority) };
    return asDeviceError(error);
  }
}

/**
 * `maintenance.log.undo`: deletes the log that op created while it is unchanged and has no
 * files, and takes back its mileage contribution (compare-and-revert). An edited or deleted
 * log is `changed_since`; a log with files is answered `has_attachments`.
 */
export async function undoLogFromTablet(input: DeviceMaintenanceRequest, options: DeviceMaintenanceOptions = {}): Promise<LogUndoResult | DeviceUndoAnswer> {
  sized(input, FACE_MAX_BYTES);
  const authority = await authorize('maintenance.log.undo', input, options);
  const result = await undoMaintenanceLogAs(adminDb, authority.householdId, { opId: authority.opId }, undoContext(authority)).catch(asDeviceError);
  if (result.status === 'changed') throw new DeviceActionError('changed_since');
  return answer(result);
}

// --- Snooze (maintenance.snooze) ----------------------------------------------------------

export type SnoozeIntent = { ownerType: unknown; ownerId: unknown; scheduleId: unknown; seen: unknown };

export type DeviceSnoozeResult = { result: SnoozeResult; level: 'face' | 'pin' };

/** `maintenance.snooze`: one cycle by a week under the card's rules; a moved cycle is `changed`. */
export async function snoozeFromTablet(input: DeviceMaintenanceRequest & SnoozeIntent, options: DeviceMaintenanceOptions = {}): Promise<DeviceSnoozeResult> {
  sized(input, FACE_MAX_BYTES);
  const authority = await authorize('maintenance.snooze', input, options);
  await assertSameTarget(authority, 'snooze', { ownerType: input.ownerType, ownerId: input.ownerId });
  const result = await snoozeMaintenanceScheduleAs(adminDb, authority.householdId, {
    opId: authority.opId, ownerType: input.ownerType, ownerId: input.ownerId, scheduleId: input.scheduleId, seen: input.seen,
  }, deviceOperationContext(authority), { cleanup: options.cleanup }).catch(asDeviceError);
  return { result: answer(result), level: levelOf(authority) };
}

/** `maintenance.snooze.undo`: compare-and-revert of the snoozed fields, by the original's opId only. */
export async function undoSnoozeFromTablet(input: DeviceMaintenanceRequest, options: DeviceMaintenanceOptions = {}): Promise<DeviceUndoResult> {
  sized(input, FACE_MAX_BYTES);
  const authority = await authorize('maintenance.snooze.undo', input, options);
  return answer(await undoMaintenanceSnoozeAs(adminDb, authority.householdId, { opId: authority.opId }, undoContext(authority)).catch(asDeviceError));
}

// --- PIN level ----------------------------------------------------------------------------

export type EditSchedulesIntent = {
  ownerType: unknown;
  ownerId: unknown;
  /** The schedules the form opened with. */
  base: unknown;
  /** The schedules as edited. */
  values: unknown;
};

export type DeviceEditSchedulesResult = { result: SaveResult | { status: 'gone' } | { status: 'too_many_schedules' }; level: 'pin' };

/**
 * `maintenance.editSchedules` (PIN): the record save operation with only the schedule list
 * (`schedules` or `serviceSchedules`) in `base` and `values`, so no other field of the
 * asset or vehicle can change; schedules merge by id as on a phone. A record deleted
 * meanwhile is `gone`; past 100 schedules after the merge `too_many_schedules`.
 */
export async function editSchedulesFromTablet(input: DeviceMaintenanceRequest & EditSchedulesIntent, options: DeviceMaintenanceOptions = {}): Promise<DeviceEditSchedulesResult> {
  sized(input, SCHEDULES_MAX_BYTES);
  if (input.ownerType !== 'home_asset' && input.ownerType !== 'vehicle') throw new DeviceActionError('invalid_input');
  if (!Array.isArray(input.base) || !Array.isArray(input.values)) throw new DeviceActionError('invalid_input');
  // Always an existing record: never a create.
  if (typeof input.ownerId !== 'string' || !input.ownerId) throw new DeviceActionError('invalid_input');
  const listField = input.ownerType === 'home_asset' ? 'schedules' : 'serviceSchedules';
  const authority = await authorize('maintenance.editSchedules', input, options);
  const kind = input.ownerType === 'home_asset' ? 'save_asset' : 'save_vehicle';
  await assertSameTarget(authority, kind, { ownerId: input.ownerId });
  const save = { opId: authority.opId, id: input.ownerId, base: { [listField]: input.base }, values: { [listField]: input.values } };
  const ctx = deviceOperationContext(authority);
  try {
    const result = input.ownerType === 'home_asset'
      ? await saveHomeAssetAs(adminDb, authority.householdId, save, ctx)
      : await saveVehicleAs(adminDb, authority.householdId, save, ctx);
    return { result: answer(result), level: 'pin' };
  } catch (error) {
    if (error instanceof MaintenanceOperationError && error.code === 'not_found') return { result: { status: 'gone' }, level: 'pin' };
    if (error instanceof MaintenanceOperationError && error.code === 'too_many_schedules') return { result: { status: 'too_many_schedules' }, level: 'pin' };
    return asDeviceError(error);
  }
}

export type DeviceDeleteLogResult = { result: DeleteLogResult; level: 'pin' };

/** `maintenance.log.delete` (PIN): a log deleted permanently; a log with files is answered `has_attachments`. */
export async function deleteLogFromTablet(input: DeviceMaintenanceRequest & { logId: unknown }, options: DeviceMaintenanceOptions = {}): Promise<DeviceDeleteLogResult> {
  sized(input, FACE_MAX_BYTES);
  const authority = await authorize('maintenance.log.delete', input, options);
  const result = await deleteMaintenanceLogAs(adminDb, authority.householdId, { opId: authority.opId, logId: input.logId }, deviceOperationContext(authority)).catch(asDeviceError);
  return { result: answer(result), level: 'pin' };
}
