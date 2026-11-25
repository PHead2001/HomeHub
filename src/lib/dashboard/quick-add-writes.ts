/**
 * Documents written by quick add (H13), built exactly like the owning modules'
 * own screens build them, so Firestore rules and those screens treat a quick-add
 * entry like one added there. Pure (no Firebase), so the shapes are unit tested.
 *
 * - Repeating chore: a `chore-templates` document like the Chores "Add Chore"
 *   dialog's Repeats option (`handleCreateChore` in chore-chart-client.tsx): task,
 *   empty notes and sub-tasks, the room, the recurrence (with its assignee) in the
 *   dialog's own `buildRecurrence` shape, and the assignee. Server upkeep then
 *   creates each due instance, as for any template.
 * - Maintenance log: the values the Maintenance "Add log" form sends to the
 *   `saveMaintenanceLog` server operation (`quickMaintenanceValues`): a routine log
 *   on the household's day, for the vehicle or asset (or general), with the odometer
 *   reading on vehicle logs; offline, the same values as a client-written document
 *   (`quickMaintenanceLog`).
 */
import { buildRecurrence, type RecurrenceState } from '@/components/chores/recurrence-fields';
import { stableSlugify } from '@/lib/utils';
import type { MaintenanceLog, Recurrence } from '@/lib/types';
import { MONTHLY_MAX_DAY, type MaintenanceTarget, type QuickAddRepeat } from './quick-add';
import { assigneeFields } from '../../../functions/src/shared/assignee';

/**
 * Id for a document quick add creates: a readable slug plus a Firestore auto-id
 * (`doc(collection).id`, 20 random characters). Quick add never reads the existing
 * ids to pick a free one: offline (or from cache) that list can be incomplete, and
 * a queued `setDoc` onto a taken id would overwrite that document on reconnect. A
 * random part makes every create a new document, online or offline.
 */
export function quickCreateId(label: string, randomPart: string, fallback = 'item'): string {
  const random = randomPart.replace(/[^a-zA-Z0-9]/g, '');
  if (random.length < 16) throw new Error('quickCreateId needs a Firestore auto-id');
  return `${(stableSlugify(label) || fallback).slice(0, 60)}-${random}`;
}

/** The recurrence the Chores dialog stores for this repeat (`buildRecurrence`). */
export function recurrenceFromRepeat(repeat: QuickAddRepeat, firstDay: string): Omit<Recurrence, 'assignedToEmail'> {
  // Intents are normalized before their preview (`normalizeRepeat`); a day the
  // dialog cannot store is refused here rather than silently changed.
  if (repeat.frequency === 'monthly' && (repeat.dayOfMonth < 1 || repeat.dayOfMonth > MONTHLY_MAX_DAY || !Number.isInteger(repeat.dayOfMonth))) {
    throw new Error('invalid-recurrence');
  }
  const state: RecurrenceState = {
    frequency: repeat.frequency,
    excludeWeekends: false,
    daysOfWeek: repeat.frequency === 'weekly' || repeat.frequency === 'biweekly' ? [String(repeat.dayOfWeek)] : [],
    biweeklyStartDate: new Date(`${firstDay}T12:00:00`),
    monthlyMode: 'dayOfMonth',
    dayOfMonth: repeat.frequency === 'monthly' ? repeat.dayOfMonth : 1,
    nthWeek: 1,
    nthWeekday: 1,
  };
  const built = buildRecurrence(state);
  if ('errors' in built) throw new Error('invalid-recurrence');
  return built.recurrence;
}

export type RepeatingChoreTemplate = {
  task: string;
  notes: string;
  roomIds: string[];
  subTasks: string[];
  recurrence: Recurrence;
  assignedToUid: string;
};

export function repeatingChoreTemplate({
  task,
  roomId,
  recurrence,
  assignee,
}: {
  task: string;
  /** null or "general" is "Around the house" (no room), as in the dialog. */
  roomId: string | null;
  recurrence: Omit<Recurrence, 'assignedToEmail'>;
  /** Stored by uid only; an email the caller knows is never written (functions/src/shared/assignee.ts). */
  assignee: { uid: string; email?: string | null };
}): RepeatingChoreTemplate {
  return {
    task,
    notes: '',
    roomIds: roomId && roomId !== 'general' ? [roomId] : [],
    subTasks: [],
    recurrence: { ...recurrence },
    ...assigneeFields(assignee),
  };
}

const withoutUndefined = <T extends Record<string, unknown>>(value: T): T =>
  Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;

/**
 * The values of a palette maintenance log, as the Maintenance "Add log" form sends them to
 * the `saveMaintenanceLog` server operation (its `LOG_SPECS` fields only): a routine log
 * on the household's day, for the vehicle or asset (or general). A mileage only goes on a
 * vehicle log (as in the form); without a vehicle it is kept in the notes so the reading
 * is not lost.
 */
export type QuickMaintenanceValues = {
  targetType: 'vehicle' | 'home_asset' | 'general';
  assetId?: string;
  vehicleId?: string;
  title: string;
  date: string;
  type: 'routine';
  mileage?: number;
  notes?: string;
};

export function quickMaintenanceValues({
  title,
  date,
  mileage,
  target,
}: {
  title: string;
  /** yyyy-MM-dd, the household's day (the form's default "today"). */
  date: string;
  mileage: number | null;
  target: MaintenanceTarget | null;
}): QuickMaintenanceValues {
  const vehicle = target?.kind === 'vehicle' ? target.vehicle : null;
  const asset = target?.kind === 'asset' ? target.asset : null;
  return withoutUndefined({
    targetType: vehicle ? 'vehicle' : asset ? 'home_asset' : 'general',
    assetId: asset?.id,
    vehicleId: vehicle?.id,
    title: title.trim(),
    date,
    type: 'routine',
    mileage: vehicle && mileage !== null ? mileage : undefined,
    notes: !vehicle && mileage !== null ? `Odometer: ${mileage.toLocaleString('en-US')} mi` : undefined,
  } satisfies QuickMaintenanceValues);
}

/**
 * The offline palette log: the same values written with the client SDK (queued until the
 * connection is back), plus the fields the rules require of a client-written log. It has
 * no `doneByUid`/`doneByName` (only the server writes them) and does not raise the
 * vehicle's odometer.
 */
export function quickMaintenanceLog({
  householdId,
  title,
  date,
  mileage,
  target,
  nowIso,
}: {
  householdId: string;
  title: string;
  /** yyyy-MM-dd, the household's day. */
  date: string;
  mileage: number | null;
  target: MaintenanceTarget | null;
  nowIso: string;
}): Omit<MaintenanceLog, 'id'> {
  const values = quickMaintenanceValues({ title, date, mileage, target });
  return withoutUndefined({
    householdId,
    ...values,
    item: values.title,
    createdAt: nowIso,
    updatedAt: nowIso,
  } satisfies Omit<MaintenanceLog, 'id'>);
}

/** A palette maintenance log request: one op id per confirmed preview, resent as is after no answer. */
export type QuickMaintenanceRequest = { opId: string; values: QuickMaintenanceValues };

/**
 * What the palette does with the server call's outcome (MA-6c, MA-20). `ok` is saved;
 * `failed` is a definite refusal (the request is forgotten); `no_answer` keeps the request
 * so Confirm resends it with the same op id, never a second log. `offline` (nothing was
 * sent) queues the client write, unless a request is held from an earlier unanswered try:
 * that one may have been saved, so a queued copy could be a duplicate, and the palette asks
 * for a connection instead.
 */
export function quickMaintenanceNext(
  outcome: 'ok' | 'failed' | 'offline' | 'no_answer',
  held: boolean,
): 'saved' | 'failed' | 'hold' | 'queue' | 'needs_connection' {
  if (outcome === 'ok') return 'saved';
  if (outcome === 'failed') return 'failed';
  if (outcome === 'no_answer') return 'hold';
  return held ? 'needs_connection' : 'queue';
}

/** A note for the preview when the reading is below the vehicle's recorded odometer. */
export function mileageNote(mileage: number | null, target: MaintenanceTarget | null): string | null {
  if (mileage === null || target?.kind !== 'vehicle') return null;
  const recorded = target.vehicle.currentMileage;
  if (typeof recorded !== 'number' || mileage >= recorded) return null;
  return `That is below the ${recorded.toLocaleString('en-US')} mi last recorded for ${target.vehicle.name}. Check the reading before saving.`;
}
