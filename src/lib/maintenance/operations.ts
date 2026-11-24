// Maintenance operations as pure plans (M1: the completion contract). The server
// (src/lib/server/maintenance-operations.ts) reads the authoritative documents in
// one transaction, asks these functions what to write, and writes exactly that.
// Nothing here talks to Firestore, so the rules are unit-tested directly
// (tests/unit/maintenance-operations.test.ts).
//
// Schedules are elements of an array on the asset or vehicle (`schedules` /
// `serviceSchedules`). Firestore cannot patch one element, so every write
// rebuilds the array from the document read in the same transaction and changes
// only the schedule (by stable id) and the fields the operation owns.
import { stableSlugify } from '../../../functions/src/shared/ids';
import {
  buildMaintenanceReminders,
  type AssetInput,
  type VehicleInput,
} from '../../../functions/src/shared/maintenance-reminders';
import {
  calculateNextAssetDueDate,
  calculateNextVehicleDueDate,
  calculateNextVehicleMileage,
  canSnoozeReminder,
  snoozedDueDate,
} from './schedules';
import type { HomeAssetSchedule, VehicleServiceSchedule } from '../types';

export type MaintenanceOwnerType = 'home_asset' | 'vehicle';

/** A plain stored schedule (array element). */
export type StoredSchedule = Record<string, unknown> & { id?: string };

/** The occurrence a person saw: its due date and due mileage (null: none). */
export type MaintenanceCycle = { nextDueDate: string | null; nextDueMileage: number | null };

/** Stored on the schedule by every completion: who completed which cycle, and when. */
export type LastCompletion = {
  opId: string;
  byUid: string;
  byName: string;
  completedDate: string;
  /** Server time of the completion (ISO). */
  at: string;
  cycle: MaintenanceCycle;
};

/** Field values before and after an operation; null means "absent". */
export type FieldValues = Record<string, unknown>;

/** What a completion changed, kept on its log and in the op ledger (for Undo). */
export type CompletionRecord = {
  scheduleId: string;
  ownerType: MaintenanceOwnerType;
  ownerId: string;
  cycle: MaintenanceCycle;
  before: FieldValues;
  after: FieldValues;
};

/** The largest odometer reading HomeHub accepts. */
export const MAX_MILEAGE = 2_000_000;
/** A reading this far above the recorded mileage asks for confirmation in the UI. */
export const MILEAGE_JUMP_WARNING = 20_000;

/** Schedule fields a completion may change. */
export const COMPLETION_SCHEDULE_FIELDS = [
  'nextDueDate', 'nextDueMileage', 'lastCompletedDate', 'lastCompletedMileage', 'snoozedUntil', 'snoozedFrom', 'lastCompletion',
] as const;
/** Vehicle fields a completion (or a vehicle log) may change. */
export const COMPLETION_VEHICLE_FIELDS = ['currentMileage', 'mileageUpdatedAt'] as const;
/** Schedule fields a snooze changes. */
export const SNOOZE_FIELDS = ['nextDueDate', 'snoozedUntil', 'snoozedFrom'] as const;

export const scheduleListField = (ownerType: MaintenanceOwnerType) =>
  ownerType === 'home_asset' ? 'schedules' : 'serviceSchedules';

/* -------------------------------------------------------------------------- */
/* Values                                                                      */
/* -------------------------------------------------------------------------- */

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** A real calendar day "yyyy-MM-dd" (no Feb 30). */
export const isRealDay = (value: unknown): value is string => {
  if (typeof value !== 'string' || !DAY.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
};

export const isMileage = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= MAX_MILEAGE;

/** null for absent (undefined, null, ''), so before/after and comparisons agree. */
export const orNull = (value: unknown): unknown => (value === undefined || value === '' ? null : value);

const stable = (value: unknown): string => {
  if (value === undefined) return 'null';
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stable(entry)}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
};

/** Deep equality of stored values (absent == null == ''). */
export const sameValue = (a: unknown, b: unknown) => stable(orNull(a)) === stable(orNull(b));

/** Applies a patch to a plain object: null removes the key. */
export const applyPatch = <T extends Record<string, unknown>>(target: T, patch: FieldValues): T => {
  const next: Record<string, unknown> = { ...target };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null || value === undefined) delete next[key];
    else next[key] = value;
  }
  return next as T;
};

export const cycleOf = (schedule: StoredSchedule | null | undefined): MaintenanceCycle => ({
  nextDueDate: typeof schedule?.nextDueDate === 'string' && schedule.nextDueDate ? schedule.nextDueDate : null,
  nextDueMileage: typeof schedule?.nextDueMileage === 'number' ? schedule.nextDueMileage : null,
});

export const sameCycle = (a: MaintenanceCycle | null | undefined, b: MaintenanceCycle | null | undefined) =>
  Boolean(a && b) && (a!.nextDueDate ?? null) === (b!.nextDueDate ?? null) && (a!.nextDueMileage ?? null) === (b!.nextDueMileage ?? null);

/** A cycle from client input, or null when it is not one. */
export const parseCycle = (value: unknown): MaintenanceCycle | null => {
  if (!value || typeof value !== 'object') return null;
  const { nextDueDate, nextDueMileage } = value as Record<string, unknown>;
  const date = nextDueDate === undefined || nextDueDate === null || nextDueDate === '' ? null : nextDueDate;
  const mileage = nextDueMileage === undefined || nextDueMileage === null ? null : nextDueMileage;
  if (date !== null && (typeof date !== 'string' || date.length > 40)) return null;
  if (mileage !== null && (typeof mileage !== 'number' || !Number.isFinite(mileage))) return null;
  return { nextDueDate: date as string | null, nextDueMileage: mileage as number | null };
};

/* -------------------------------------------------------------------------- */
/* Schedule identity                                                           */
/* -------------------------------------------------------------------------- */

const scheduleTitle = (schedule: StoredSchedule, ownerType: MaintenanceOwnerType) => {
  const name = ownerType === 'home_asset' ? schedule.scheduleName : schedule.serviceName;
  return typeof name === 'string' && name ? name : ownerType === 'home_asset' ? 'Scheduled maintenance' : 'Scheduled service';
};

/**
 * The compatibility key of a schedule without an id (the reminder builder's
 * `legacy-{index}-{slug}`). It becomes the schedule's durable id, so the
 * reminder `sourceId`, deep links and open notifications stay the same.
 */
export const legacyScheduleKey = (schedule: StoredSchedule, index: number, ownerType: MaintenanceOwnerType) =>
  `legacy-${index}-${stableSlugify(scheduleTitle(schedule, ownerType))}`;

/** The key a client names a schedule by: its id, or its legacy key. */
export const scheduleRef = (schedule: StoredSchedule, index: number, ownerType: MaintenanceOwnerType) =>
  typeof schedule.id === 'string' && schedule.id ? schedule.id : legacyScheduleKey(schedule, index, ownerType);

/**
 * Gives every schedule without an id its legacy key as a durable id (a
 * `-2`, `-3` suffix only if that id is already taken). Idempotent: a list
 * where every schedule has an id comes back unchanged (`assigned: 0`).
 */
export const withScheduleIds = (list: unknown, ownerType: MaintenanceOwnerType): { list: StoredSchedule[]; assigned: number } => {
  const schedules = Array.isArray(list) ? list.filter((entry): entry is StoredSchedule => Boolean(entry) && typeof entry === 'object') : [];
  const taken = new Set(schedules.map(schedule => schedule.id).filter((id): id is string => typeof id === 'string' && id.length > 0));
  let assigned = 0;
  const next = schedules.map((schedule, index) => {
    if (typeof schedule.id === 'string' && schedule.id) return schedule;
    const base = legacyScheduleKey(schedule, index, ownerType);
    let id = base;
    for (let suffix = 2; taken.has(id); suffix += 1) id = `${base}-${suffix}`;
    taken.add(id);
    assigned += 1;
    return { ...schedule, id };
  });
  return { list: next, assigned };
};

/* -------------------------------------------------------------------------- */
/* Completion                                                                  */
/* -------------------------------------------------------------------------- */

export type CompletionValues = {
  completedDate: unknown;
  mileage?: unknown;
  nextDueDate?: unknown;
  nextDueMileage?: unknown;
};

export type CompletionRefusal =
  | 'invalid_date'
  | 'future_date'
  | 'invalid_mileage'
  | 'mileage_required'
  | 'next_due_required'
  | 'invalid_next_due'
  | 'next_due_mileage_low';

export type CompletionPlan =
  | { kind: 'already_done'; lastCompletion: LastCompletion }
  | { kind: 'changed' }
  | { kind: 'refused'; reason: CompletionRefusal }
  | {
    kind: 'apply';
    schedule: StoredSchedule;
    /** Vehicle field changes (currentMileage, mileageUpdatedAt); empty for assets. */
    vehiclePatch: FieldValues;
    record: Omit<CompletionRecord, 'scheduleId' | 'ownerType' | 'ownerId'>;
    next: MaintenanceCycle;
  };

export const parseLastCompletion = (value: unknown): LastCompletion | null => {
  if (!value || typeof value !== 'object') return null;
  const entry = value as Record<string, unknown>;
  const cycle = parseCycle(entry.cycle);
  if (typeof entry.opId !== 'string' || !cycle) return null;
  return {
    opId: entry.opId,
    byUid: typeof entry.byUid === 'string' ? entry.byUid : '',
    byName: typeof entry.byName === 'string' ? entry.byName : '',
    completedDate: typeof entry.completedDate === 'string' ? entry.completedDate : '',
    at: typeof entry.at === 'string' ? entry.at : '',
    cycle,
  };
};

/** Values before/after for the listed fields that differ (null: absent). */
const changes = (before: Record<string, unknown>, after: Record<string, unknown>, fields: readonly string[]) => {
  const out = { before: {} as FieldValues, after: {} as FieldValues };
  for (const field of fields) {
    if (sameValue(before[field], after[field])) continue;
    out.before[field] = orNull(before[field]);
    out.after[field] = orNull(after[field]);
  }
  return out;
};

/**
 * Plans completing one cycle of a schedule.
 *
 * - The cycle the person saw was already completed (the schedule's `lastCompletion`
 *   names it): `already_done`, with who and when. Checked first, so a completion
 *   that left the due values as they were still counts once.
 * - The schedule's current cycle differs from the one seen: `changed`.
 * - Otherwise the values are validated and the schedule advances; the next due
 *   date/mileage come from the request or the schedule's interval, and a completion
 *   that would leave neither is refused (`next_due_required`).
 */
export const planCompletion = (input: {
  ownerType: MaintenanceOwnerType;
  schedule: StoredSchedule;
  vehicle?: { currentMileage?: unknown; mileageUpdatedAt?: unknown } | null;
  seen: MaintenanceCycle;
  values: CompletionValues;
  today: string;
  completion: Omit<LastCompletion, 'cycle'>;
}): CompletionPlan => {
  const { ownerType, schedule, seen, values, today } = input;
  const last = parseLastCompletion(schedule.lastCompletion);
  if (last && sameCycle(last.cycle, seen)) return { kind: 'already_done', lastCompletion: last };
  if (!sameCycle(cycleOf(schedule), seen)) return { kind: 'changed' };

  if (!isRealDay(values.completedDate)) return { kind: 'refused', reason: 'invalid_date' };
  const completedDate = values.completedDate;
  if (completedDate > today) return { kind: 'refused', reason: 'future_date' };
  const mileage = values.mileage === undefined || values.mileage === null || values.mileage === '' ? undefined : values.mileage;
  if (mileage !== undefined && !isMileage(mileage)) return { kind: 'refused', reason: 'invalid_mileage' };
  const givenDate = values.nextDueDate === undefined || values.nextDueDate === null || values.nextDueDate === '' ? undefined : values.nextDueDate;
  if (givenDate !== undefined && !isRealDay(givenDate)) return { kind: 'refused', reason: 'invalid_next_due' };
  const givenMileage = values.nextDueMileage === undefined || values.nextDueMileage === null || values.nextDueMileage === '' ? undefined : values.nextDueMileage;
  if (givenMileage !== undefined && !isMileage(givenMileage)) return { kind: 'refused', reason: 'invalid_next_due' };

  let next: MaintenanceCycle;
  if (ownerType === 'home_asset') {
    const date = (givenDate as string | undefined) || calculateNextAssetDueDate(schedule as HomeAssetSchedule, completedDate);
    next = { nextDueDate: date ?? null, nextDueMileage: null };
  } else {
    const service = schedule as VehicleServiceSchedule;
    const mileageDriven = Boolean(service.intervalMiles) || typeof service.nextDueMileage === 'number';
    if (mileageDriven && mileage === undefined) return { kind: 'refused', reason: 'mileage_required' };
    const date = (givenDate as string | undefined) || calculateNextVehicleDueDate(service, completedDate);
    const dueMileage = (givenMileage as number | undefined) ?? calculateNextVehicleMileage(service, mileage as number | undefined);
    next = { nextDueDate: date ?? null, nextDueMileage: typeof dueMileage === 'number' ? dueMileage : null };
    if (next.nextDueMileage !== null && mileage !== undefined && next.nextDueMileage <= (mileage as number)) {
      return { kind: 'refused', reason: 'next_due_mileage_low' };
    }
  }
  if (next.nextDueDate === null && next.nextDueMileage === null) return { kind: 'refused', reason: 'next_due_required' };

  const lastCompletion: LastCompletion = { ...input.completion, completedDate, cycle: { ...seen } };
  const patch: FieldValues = {
    lastCompletedDate: completedDate,
    nextDueDate: next.nextDueDate,
    nextDueMileage: next.nextDueMileage,
    // Completing always ends a snooze, even if the new cycle lands on the snoozed date.
    snoozedUntil: null,
    snoozedFrom: null,
    lastCompletion,
  };
  // Vehicle services keep the reading they were done at (none: removed, as before M1).
  if (ownerType === 'vehicle') patch.lastCompletedMileage = mileage ?? null;
  const nextSchedule = applyPatch(schedule, patch);
  const scheduleChanges = changes(schedule, nextSchedule, COMPLETION_SCHEDULE_FIELDS);

  const vehiclePatch: FieldValues = {};
  if (ownerType === 'vehicle' && typeof mileage === 'number') Object.assign(vehiclePatch, mileagePatch(input.vehicle ?? {}, mileage, today));
  const vehicleChanges = changes(input.vehicle ?? {}, applyPatch({ ...(input.vehicle ?? {}) }, vehiclePatch), COMPLETION_VEHICLE_FIELDS);

  return {
    kind: 'apply',
    schedule: nextSchedule,
    vehiclePatch: Object.fromEntries(Object.keys(vehicleChanges.after).map(field => [field, vehiclePatch[field]])),
    record: {
      cycle: { ...seen },
      before: { ...scheduleChanges.before, ...vehicleChanges.before },
      after: { ...scheduleChanges.after, ...vehicleChanges.after },
    },
    next,
  };
};

/**
 * The max rule (MA-6b): a reading raises the vehicle's current mileage, never
 * lowers it; `mileageUpdatedAt` (household day) moves when the reading is at
 * least the current one.
 */
export const mileagePatch = (vehicle: { currentMileage?: unknown }, reading: number, today: string): FieldValues => {
  const current = typeof vehicle.currentMileage === 'number' ? vehicle.currentMileage : null;
  if (current !== null && reading < current) return {};
  return { ...(current === null || reading > current ? { currentMileage: reading } : {}), mileageUpdatedAt: today };
};

/* -------------------------------------------------------------------------- */
/* Compare-and-revert (Undo)                                                   */
/* -------------------------------------------------------------------------- */

export type KeptField = { field: string; value: unknown };

/**
 * For each field the operation changed: back to `before` only while the current
 * value still equals `after`. A field someone changed since keeps its current
 * value and is reported in `kept` (unless it already holds `before`).
 */
export const compareAndRevert = (current: Record<string, unknown>, before: FieldValues, after: FieldValues) => {
  const patch: FieldValues = {};
  const kept: KeptField[] = [];
  for (const field of Object.keys(after)) {
    if (sameValue(current[field], after[field])) patch[field] = orNull(before[field]);
    else if (!sameValue(current[field], before[field])) kept.push({ field, value: orNull(current[field]) });
  }
  return { patch, kept };
};

const pick = (values: FieldValues, fields: readonly string[]) =>
  Object.fromEntries(Object.entries(values).filter(([field]) => fields.includes(field)));

export type UndoCompletionPlan =
  | { kind: 'superseded' }
  | { kind: 'apply'; schedule: StoredSchedule | null; vehiclePatch: FieldValues; kept: KeptField[] };

/**
 * Plans undoing a completion. A schedule completed again since (its
 * `lastCompletion` is another operation's) is left alone: `superseded`, and
 * nothing changes. A schedule that is gone stays gone; only the vehicle's
 * mileage is considered then. Otherwise compare-and-revert per field.
 */
export const planUndoCompletion = (input: {
  opId: string;
  schedule: StoredSchedule | null;
  vehicle?: Record<string, unknown> | null;
  record: Pick<CompletionRecord, 'before' | 'after'>;
}): UndoCompletionPlan => {
  const { schedule, record } = input;
  if (schedule) {
    const last = parseLastCompletion(schedule.lastCompletion);
    if (!last || last.opId !== input.opId) return { kind: 'superseded' };
  }
  const kept: KeptField[] = [];
  let nextSchedule: StoredSchedule | null = null;
  if (schedule) {
    const result = compareAndRevert(schedule, pick(record.before, COMPLETION_SCHEDULE_FIELDS), pick(record.after, COMPLETION_SCHEDULE_FIELDS));
    nextSchedule = applyPatch(schedule, result.patch);
    kept.push(...result.kept);
  }
  let vehiclePatch: FieldValues = {};
  if (input.vehicle) {
    const result = compareAndRevert(input.vehicle, pick(record.before, COMPLETION_VEHICLE_FIELDS), pick(record.after, COMPLETION_VEHICLE_FIELDS));
    vehiclePatch = result.patch;
    // currentMileage raised by a later reading stays; mileageUpdatedAt follows it.
    if (result.kept.some(entry => entry.field === 'currentMileage')) delete vehiclePatch.mileageUpdatedAt;
    kept.push(...result.kept.filter(entry => entry.field !== 'mileageUpdatedAt'));
  }
  return { kind: 'apply', schedule: nextSchedule, vehiclePatch, kept };
};

/* -------------------------------------------------------------------------- */
/* Snooze                                                                      */
/* -------------------------------------------------------------------------- */

export type SnoozePlan =
  | { kind: 'changed' }
  | { kind: 'refused'; reason: 'not_snoozable' }
  | { kind: 'apply'; schedule: StoredSchedule; before: FieldValues; after: FieldValues; nextDueDate: string };

/**
 * Plans snoozing a schedule's current cycle by a week (`snoozedDueDate`), under
 * the same eligibility as the reminder card (`canSnoozeReminder`: date-driven,
 * not upcoming; a vehicle service due by mileage cannot be snoozed).
 */
export const planSnooze = (input: {
  ownerType: MaintenanceOwnerType;
  owner: Record<string, unknown> & { id: string };
  schedule: StoredSchedule;
  seen: MaintenanceCycle;
  today: string;
  timeZone: string;
}): SnoozePlan => {
  const { ownerType, owner, schedule, seen, today, timeZone } = input;
  if (!sameCycle(cycleOf(schedule), seen)) return { kind: 'changed' };
  // The reminder the card showed, built the same way (status, mileage state).
  const single = ownerType === 'home_asset'
    ? buildMaintenanceReminders([{ ...(owner as unknown as AssetInput), status: 'active', schedules: [schedule as never] }], [], today, timeZone)
    : buildMaintenanceReminders([], [{ ...(owner as unknown as VehicleInput), status: 'active', serviceSchedules: [schedule as never] }], today, timeZone);
  const reminder = single.find(entry => entry.group === 'scheduled' || entry.group === 'vehicle_service');
  if (!reminder || !canSnoozeReminder(reminder)) return { kind: 'refused', reason: 'not_snoozable' };
  const nextDueDate = snoozedDueDate(typeof schedule.nextDueDate === 'string' ? schedule.nextDueDate : undefined, today);
  // `snoozedFrom` (M3): the due date before the snooze, so a completion while it applies steps
  // from the real due date. A snooze still in effect keeps the date it was first snoozed from.
  const current = typeof schedule.nextDueDate === 'string' ? schedule.nextDueDate : null;
  const stillSnoozed = typeof schedule.snoozedFrom === 'string' && schedule.snoozedUntil === schedule.nextDueDate;
  const snoozedFrom = stillSnoozed ? schedule.snoozedFrom : current;
  const nextSchedule = applyPatch(schedule, { nextDueDate, snoozedUntil: nextDueDate, snoozedFrom });
  const diff = changes(schedule, nextSchedule, SNOOZE_FIELDS);
  return { kind: 'apply', schedule: nextSchedule, before: diff.before, after: diff.after, nextDueDate };
};

/** Undo of a snooze: compare-and-revert of nextDueDate, snoozedUntil and snoozedFrom. */
export const planUndoSnooze = (schedule: StoredSchedule, before: FieldValues, after: FieldValues) => {
  const result = compareAndRevert(schedule, pick(before, SNOOZE_FIELDS), pick(after, SNOOZE_FIELDS));
  return { schedule: applyPatch(schedule, result.patch), kept: result.kept };
};

/* -------------------------------------------------------------------------- */
/* Edits (asset, vehicle, log)                                                 */
/* -------------------------------------------------------------------------- */

/** Fields of `values` that differ from `base` (what the form changed). */
export const changedFields = (base: Record<string, unknown>, values: Record<string, unknown>, fields: readonly string[]) =>
  fields.filter(field => !sameValue(base[field], values[field]));

/**
 * Merges a form's schedules onto the stored list by id:
 * - a schedule the form had (in `base`) and still has: only the fields the
 *   form changed are written onto the stored schedule; everything else (a
 *   completion, a snooze, `lastCompletion`) stays as stored;
 * - a schedule the form had and removed: removed (if still there);
 * - a schedule the form did not have (someone added it meanwhile): kept;
 * - a schedule new in the form: appended (a stored schedule removed meanwhile is
 *   never brought back, because it was in `base`).
 */
export const mergeSchedules = (
  stored: StoredSchedule[],
  base: StoredSchedule[],
  values: StoredSchedule[],
  fields: readonly string[],
): StoredSchedule[] => {
  const baseById = new Map(base.map(schedule => [String(schedule.id), schedule]));
  const valuesById = new Map(values.map(schedule => [String(schedule.id), schedule]));
  const merged: StoredSchedule[] = [];
  for (const schedule of stored) {
    const id = String(schedule.id);
    const before = baseById.get(id);
    if (!before) {
      merged.push(schedule);
      continue;
    }
    const after = valuesById.get(id);
    if (!after) continue;
    const changed = changedFields(before, after, fields);
    const patch: FieldValues = Object.fromEntries(changed.map(field => [field, orNull(after[field])]));
    // An explicit new due date or mileage schedules a new occurrence, even when it equals
    // the one last completed: the completion marker no longer describes the current cycle,
    // so it must not make the next completion look "already done" (PR #210 review).
    if (changed.includes('nextDueDate') || changed.includes('nextDueMileage')) patch.lastCompletion = null;
    merged.push(applyPatch(schedule, patch));
  }
  const storedIds = new Set(stored.map(schedule => String(schedule.id)));
  for (const schedule of values) {
    const id = String(schedule.id);
    if (baseById.has(id) || storedIds.has(id)) continue;
    merged.push(Object.fromEntries(Object.entries(schedule).filter(([key, value]) => (key === 'id' || fields.includes(key)) && orNull(value) !== null)) as StoredSchedule);
  }
  return merged;
};

/**
 * Plans an edit of an existing record: top-level fields the form changed are
 * patched (null removes), schedules are merged by id. `changed` is false when the
 * form changed nothing.
 */
export const planRecordEdit = (input: {
  stored: Record<string, unknown>;
  base: Record<string, unknown>;
  values: Record<string, unknown>;
  fields: readonly string[];
  schedules?: { field: string; fields: readonly string[]; stored: StoredSchedule[]; base: StoredSchedule[]; values: StoredSchedule[] };
}) => {
  const patch: FieldValues = Object.fromEntries(
    changedFields(input.base, input.values, input.fields).map(field => [field, orNull(input.values[field])]),
  );
  if (input.schedules) {
    const { field, fields, stored, base, values } = input.schedules;
    const merged = mergeSchedules(stored, base, values, fields);
    if (!sameValue(merged, input.stored[field])) patch[field] = merged;
  }
  return { patch, changed: Object.keys(patch).length > 0 };
};

/** Editable schedule fields. */
export const ASSET_SCHEDULE_FIELDS = [
  'mode', 'scheduleName', 'frequencyType', 'intervalValue', 'lastCompletedDate', 'nextDueDate', 'snoozedUntil', 'snoozedFrom',
] as const;
export const VEHICLE_SCHEDULE_FIELDS = [
  'mode', 'serviceName', 'intervalMiles', 'intervalMonths', 'lastCompletedMileage', 'lastCompletedDate',
  'nextDueMileage', 'nextDueDate', 'snoozedUntil', 'snoozedFrom',
] as const;

/** A short mileage warning for the UI, or null (MA-6d). */
export const mileageWarning = (reading: number | undefined, current: number | undefined): 'lower' | 'jump' | null => {
  if (typeof reading !== 'number' || typeof current !== 'number') return null;
  if (reading < current) return 'lower';
  if (reading - current > MILEAGE_JUMP_WARNING) return 'jump';
  return null;
};
