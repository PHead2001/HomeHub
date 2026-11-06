// Schedule math for the Maintenance Center: completion advancement, snoozing and
// matching a reminder back to the embedded schedule it came from. Pure, so the
// one-tap reminder actions and the completion dialog share one implementation.
import { add, format, isValid, parseISO } from 'date-fns';
import { addDays, isDayString } from '../../../functions/src/shared/calendar';
import { stableSlugify } from '../../../functions/src/shared/ids';
import {
  mileageStatus,
  type MaintenanceReminder,
} from '../../../functions/src/shared/maintenance-reminders';
import type {
  HomeAsset,
  HomeAssetSchedule,
  MaintenanceScheduleMode,
  Vehicle,
  VehicleServiceSchedule,
} from '../types';

export type ScheduleCompletionTarget =
  | { targetType: 'home_asset'; asset: HomeAsset; scheduleIndex: number; schedule: HomeAssetSchedule }
  | { targetType: 'vehicle'; vehicle: Vehicle; scheduleIndex: number; schedule: VehicleServiceSchedule };

/** Days a reminder is pushed back by "Snooze". */
export const SNOOZE_DAYS = 7;

const parseDay = (date: string) => {
  const parsed = parseISO(date);
  if (isValid(parsed)) return parsed;
  const fallback = new Date(date);
  return isValid(fallback) ? fallback : new Date();
};

export const isActionableAssetSchedule = (schedule: Pick<HomeAssetSchedule, 'frequencyType' | 'intervalValue' | 'nextDueDate'>) =>
  Boolean((schedule.frequencyType && schedule.intervalValue) || schedule.nextDueDate);

export const isActionableVehicleSchedule = (
  schedule: Pick<VehicleServiceSchedule, 'intervalMiles' | 'intervalMonths' | 'nextDueMileage' | 'nextDueDate'>,
) => Boolean(schedule.intervalMiles || schedule.intervalMonths || schedule.nextDueMileage || schedule.nextDueDate);

export const getAssetScheduleMode = (schedule: HomeAssetSchedule): MaintenanceScheduleMode =>
  schedule.mode || (isActionableAssetSchedule(schedule) ? 'scheduled' : 'checklist');

export const getVehicleScheduleMode = (schedule: VehicleServiceSchedule): MaintenanceScheduleMode =>
  schedule.mode || (isActionableVehicleSchedule(schedule) ? 'scheduled' : 'checklist');

export const calculateNextAssetDueDate = (schedule: HomeAssetSchedule, completedDate: string) => {
  if (!schedule.frequencyType || !schedule.intervalValue) return undefined;
  const interval = schedule.intervalValue;
  const nextDue = add(parseDay(completedDate), {
    days: schedule.frequencyType === 'days' ? interval : 0,
    weeks: schedule.frequencyType === 'weeks' ? interval : 0,
    months: schedule.frequencyType === 'months' ? interval : 0,
    years: schedule.frequencyType === 'years' ? interval : 0,
  });
  return format(nextDue, 'yyyy-MM-dd');
};

export const calculateNextVehicleDueDate = (schedule: VehicleServiceSchedule, completedDate: string) => {
  if (!schedule.intervalMonths) return undefined;
  return format(add(parseDay(completedDate), { months: schedule.intervalMonths }), 'yyyy-MM-dd');
};

export const calculateNextVehicleMileage = (schedule: VehicleServiceSchedule, completedMileage?: number) => {
  if (!schedule.intervalMiles || typeof completedMileage !== 'number') return undefined;
  return completedMileage + schedule.intervalMiles;
};

/**
 * The persisted identity of a schedule, exactly as the shared reminder builder
 * computes `sourceId`/`scheduleKey` (legacy schedules without an id get a
 * deterministic compatibility key).
 */
export const scheduleKeyFor = (
  ownerId: string,
  schedule: { id?: string; scheduleName?: string; serviceName?: string },
  index: number,
  kind: 'home_asset' | 'vehicle',
) => {
  if (schedule.id) return `${ownerId}:${schedule.id}`;
  const title = kind === 'home_asset'
    ? schedule.scheduleName || 'Scheduled maintenance'
    : schedule.serviceName || 'Scheduled service';
  return `${ownerId}:legacy-${index}-${stableSlugify(title)}`;
};

/** Finds the asset/vehicle schedule a schedule or service reminder belongs to. */
export const findReminderSchedule = (
  reminder: Pick<MaintenanceReminder, 'group' | 'targetType' | 'targetId' | 'scheduleKey'>,
  assets: HomeAsset[],
  vehicles: Vehicle[],
): ScheduleCompletionTarget | null => {
  if (!reminder.scheduleKey) return null;
  if (reminder.group === 'scheduled' && reminder.targetType === 'home_asset') {
    const asset = assets.find((item) => item.id === reminder.targetId);
    const scheduleIndex = asset?.schedules?.findIndex((schedule, index) => (
      scheduleKeyFor(asset.id, schedule, index, 'home_asset') === reminder.scheduleKey
    )) ?? -1;
    if (!asset || scheduleIndex < 0) return null;
    return { targetType: 'home_asset', asset, scheduleIndex, schedule: asset.schedules![scheduleIndex] };
  }
  if (reminder.group === 'vehicle_service' && reminder.targetType === 'vehicle') {
    const vehicle = vehicles.find((item) => item.id === reminder.targetId);
    const scheduleIndex = vehicle?.serviceSchedules?.findIndex((schedule, index) => (
      scheduleKeyFor(vehicle.id, schedule, index, 'vehicle') === reminder.scheduleKey
    )) ?? -1;
    if (!vehicle || scheduleIndex < 0) return null;
    return { targetType: 'vehicle', vehicle, scheduleIndex, schedule: vehicle.serviceSchedules![scheduleIndex] };
  }
  return null;
};

export type QuickCompletion = {
  completedDate: string;
  mileage?: number;
  nextDueDate?: string;
  nextDueMileage?: number;
};

/**
 * Values for a one-tap "Mark done": completed today (at the vehicle's current
 * mileage) with the next due date/mileage advanced by the schedule's interval.
 * Returns null when the next due values cannot be worked out without asking
 * (no interval, or a mileage interval with no recorded mileage); the caller
 * then opens the completion dialog instead of guessing.
 */
export const quickCompletionValues = (target: ScheduleCompletionTarget, today: string): QuickCompletion | null => {
  if (target.targetType === 'home_asset') {
    const nextDueDate = calculateNextAssetDueDate(target.schedule, today);
    return nextDueDate ? { completedDate: today, nextDueDate } : null;
  }
  const { schedule, vehicle } = target;
  const mileage = vehicle.currentMileage;
  if (schedule.intervalMiles && typeof mileage !== 'number') return null;
  const nextDueDate = calculateNextVehicleDueDate(schedule, today);
  const nextDueMileage = calculateNextVehicleMileage(schedule, mileage);
  if (!nextDueDate && typeof nextDueMileage !== 'number') return null;
  return { completedDate: today, mileage, nextDueDate, nextDueMileage };
};

/** The schedule after completion (same advancement as the completion dialog). */
export const completedAssetSchedule = (
  schedule: HomeAssetSchedule,
  values: { completedDate: string; nextDueDate?: string },
): HomeAssetSchedule => ({
  ...schedule,
  lastCompletedDate: values.completedDate,
  nextDueDate: values.nextDueDate || calculateNextAssetDueDate(schedule, values.completedDate),
});

export const completedVehicleSchedule = (
  schedule: VehicleServiceSchedule,
  values: { completedDate: string; mileage?: number; nextDueDate?: string; nextDueMileage?: number },
): VehicleServiceSchedule => ({
  ...schedule,
  lastCompletedMileage: values.mileage,
  lastCompletedDate: values.completedDate,
  nextDueMileage: values.nextDueMileage || calculateNextVehicleMileage(schedule, values.mileage),
  nextDueDate: values.nextDueDate || calculateNextVehicleDueDate(schedule, values.completedDate),
});

/**
 * Snooze moves a date-driven due date one week past the later of today and the
 * current due date, so it never pulls a reminder earlier.
 */
export const snoozedDueDate = (currentDue: string | undefined, today: string, days = SNOOZE_DAYS) => {
  const base = currentDue && isDayString(currentDue) && currentDue > today ? currentDue : today;
  return addDays(base, days);
};

/**
 * Snooze only helps when the reminder is driven by its date: warranties and
 * documents cannot be snoozed, and a vehicle service that is due by mileage stays
 * due however far the date moves.
 */
export const canSnoozeReminder = (
  reminder: Pick<MaintenanceReminder, 'group' | 'status' | 'dueDate' | 'dueMileage' | 'currentMileage'>,
) => {
  if (reminder.status === 'upcoming' || !reminder.dueDate) return false;
  if (reminder.group === 'scheduled') return true;
  if (reminder.group !== 'vehicle_service') return false;
  const byMiles = mileageStatus(reminder.dueMileage, reminder.currentMileage);
  return byMiles !== 'overdue' && byMiles !== 'due_soon';
};

/** Schedules and services can be completed; warranties and documents are renewed by editing. */
export const canMarkReminderDone = (reminder: Pick<MaintenanceReminder, 'group'>) =>
  reminder.group === 'scheduled' || reminder.group === 'vehicle_service';
