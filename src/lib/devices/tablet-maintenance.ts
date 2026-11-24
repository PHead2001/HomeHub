// Maintenance on a registered wall tablet (M8b; docs/modules/devices/README.md, "Maintenance
// on the tablet"). Pure: the room the view starts in (MA-26) and the intents the tablet sends
// for Done, Snooze, Log service and a schedule edit, built from the stored schedule as the
// personal page builds them (scheduleRef, cycleOf), so the server's checks are the same.

import type { MaintenanceReminder } from '../../../functions/src/shared/maintenance-reminders';
import { cycleOf, scheduleRef, type StoredSchedule } from '../maintenance/operations';
import { serviceCompletionValues, type ScheduleCompletionTarget } from '../maintenance/schedules';

/** "All rooms", chosen while the record named `room`; a new room on the record starts filtered again. */
export type RoomChoice = { room: string; all: boolean } | null;

/**
 * The room the Needs doing list shows: the tablet record's room (WT-4, edited from the Devices
 * list and applied live) unless "All rooms" was chosen for that same room; a tablet with no room
 * shows every room.
 */
export const maintenanceRoomView = (recordRoom: string | null | undefined, choice: RoomChoice): { room: string | null; all: boolean } => {
  const room = recordRoom?.trim() ? recordRoom.trim() : null;
  if (!room) return { room: null, all: true };
  if (choice && choice.all && choice.room === room) return { room: null, all: true };
  return { room, all: false };
};

/** A vehicle service with a mileage interval asks for the odometer first (as the personal page, MA-6a). */
export const needsMileageReading = (target: ScheduleCompletionTarget): boolean =>
  target.targetType === 'vehicle' && Boolean(target.schedule.intervalMiles);

const ownerIdOf = (target: ScheduleCompletionTarget) => (target.targetType === 'home_asset' ? target.asset.id : target.vehicle.id);

const scheduleIdOf = (target: ScheduleCompletionTarget) => scheduleRef(target.schedule as StoredSchedule, target.scheduleIndex, target.targetType);

/** The schedule's display name. */
export const scheduleNameOf = (target: ScheduleCompletionTarget): string => {
  const schedule = target.schedule as StoredSchedule;
  const name = target.targetType === 'home_asset' ? schedule.scheduleName : schedule.serviceName;
  return typeof name === 'string' && name.trim() ? name.trim() : target.targetType === 'home_asset' ? 'Scheduled maintenance' : 'Scheduled service';
};

export type CompleteDetails = { title?: string; notes?: string; cost?: number; serviceProvider?: string };

/**
 * A Done (or a Log service of a reminder: a completion with details) for one schedule cycle, or
 * null when the next due can't be worked out without asking (the server would refuse it).
 * `mileage`: the reading typed for a vehicle (else its recorded mileage).
 */
export const completeIntentOf = (
  target: ScheduleCompletionTarget,
  today: string,
  options: { mileage?: number; completedDate?: string; details?: CompleteDetails } = {},
): Record<string, unknown> | null => {
  const reading = target.targetType === 'vehicle' ? options.mileage ?? target.vehicle.currentMileage : undefined;
  const values = serviceCompletionValues(target, options.completedDate ?? today, reading);
  if (!values) return null;
  const details = options.details ?? {};
  const detailFields = Object.fromEntries(Object.entries({ title: details.title?.trim(), cost: details.cost, serviceProvider: details.serviceProvider?.trim() })
    .filter(([, value]) => value !== undefined && value !== ''));
  return {
    ownerType: target.targetType,
    ownerId: ownerIdOf(target),
    scheduleId: scheduleIdOf(target),
    seen: cycleOf(target.schedule as StoredSchedule),
    completedDate: values.completedDate,
    ...(typeof values.mileage === 'number' ? { mileage: values.mileage } : {}),
    ...(values.nextDueDate ? { nextDueDate: values.nextDueDate } : {}),
    ...(typeof values.nextDueMileage === 'number' ? { nextDueMileage: values.nextDueMileage } : {}),
    ...(details.notes?.trim() ? { notes: details.notes.trim() } : {}),
    ...(Object.keys(detailFields).length > 0 ? { details: { ...detailFields, type: 'routine' } } : {}),
  };
};

/** A Snooze of the cycle the card shows. */
export const snoozeIntentOf = (target: ScheduleCompletionTarget): Record<string, unknown> => ({
  ownerType: target.targetType,
  ownerId: ownerIdOf(target),
  scheduleId: scheduleIdOf(target),
  seen: cycleOf(target.schedule as StoredSchedule),
});

/**
 * A schedule edit (PIN): only that schedule, as it was shown (`base`) and as edited (`values`),
 * named by its id (a legacy schedule by its legacy key, which the server makes its id); the
 * server merges by id, so schedules someone else changed meanwhile keep their values.
 */
export const scheduleEditIntentOf = (target: ScheduleCompletionTarget, changes: Record<string, unknown>): Record<string, unknown> => {
  const id = scheduleIdOf(target);
  const base = { ...(target.schedule as StoredSchedule), id };
  delete (base as Record<string, unknown>).lastCompletion;
  return { ownerType: target.targetType, ownerId: ownerIdOf(target), base: [base], values: [{ ...base, ...changes }] };
};

/** A reminder's subject line ("Replace filter for Furnace"). */
export const reminderSubject = (reminder: Pick<MaintenanceReminder, 'title' | 'relatedName'>): string => `${reminder.title} for ${reminder.relatedName}`;
