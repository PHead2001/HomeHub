// "Coming up" (MA-27a): the next 90 days of schedules, vehicle services,
// warranties, registrations and inspections, in date order, plus services that
// are due by mileage and have no date (listed by miles left). Pure.
//
// Warranties, registrations and inspections are only in the reminders when the
// builder was asked to look ahead: build them with
// `buildMaintenanceReminders(assets, vehicles, today, timeZone, { expiryLookaheadDays: COMING_UP_DAYS })`.
import { format } from 'date-fns';
import { addDays, isDayString } from '../../../functions/src/shared/calendar';
import type { MaintenanceReminder } from '../../../functions/src/shared/maintenance-reminders';

export const COMING_UP_DAYS = 90;

export type ComingUpEntry = {
  reminder: MaintenanceReminder;
  /** The day it is due or expires (or the predicted day for a mileage service). */
  date?: string;
  /** True when `date` is a prediction supplied by the caller (mileage services). */
  predicted?: boolean;
  /** Miles left for a mileage service (byMileage entries, and dated services with a mileage). */
  milesLeft?: number;
};

export type ComingUp = {
  /** Due or expiring between today and today + days, earliest first. */
  dated: ComingUpEntry[];
  /** Mileage services with no date in the window and no prediction, fewest miles first. */
  byMileage: ComingUpEntry[];
};

export type ComingUpMonth = {
  /** "2026-12" */
  month: string;
  /** "December 2026" */
  label: string;
  entries: ComingUpEntry[];
};

const dayOf = (value?: string) => {
  const day = value?.slice(0, 10);
  return day && isDayString(day) ? day : undefined;
};

const milesLeftOf = (reminder: MaintenanceReminder) =>
  typeof reminder.dueMileage === 'number' && typeof reminder.currentMileage === 'number'
    ? reminder.dueMileage - reminder.currentMileage
    : undefined;

/**
 * The next `days` days of due items. Overdue items are not "coming up" (they are
 * in Overdue). Snoozed items keep their (snoozed) date and their `snoozed` flag.
 * `predictedDates` (keyed by the reminder's `scheduleKey`, else its `id`) places a
 * mileage service on a predicted day; without one it is listed by miles left.
 */
export const comingUp = (
  reminders: readonly MaintenanceReminder[],
  today: string,
  days: number = COMING_UP_DAYS,
  options: { predictedDates?: Readonly<Record<string, string>> } = {},
): ComingUp => {
  const end = addDays(today, days);
  const dated: ComingUpEntry[] = [];
  const byMileage: ComingUpEntry[] = [];
  const inWindow = (day?: string): day is string => Boolean(day && day >= today && day <= end);

  reminders.forEach((reminder) => {
    if (reminder.status === 'overdue') return;
    const milesLeft = milesLeftOf(reminder);
    const due = dayOf(reminder.dueDate);
    if (inWindow(due)) {
      dated.push({ reminder, date: due, ...(milesLeft !== undefined ? { milesLeft } : {}) });
      return;
    }
    if (reminder.group !== 'vehicle_service' || milesLeft === undefined || milesLeft <= 0) return;
    const predicted = dayOf(options.predictedDates?.[reminder.scheduleKey ?? reminder.id]);
    if (predicted) {
      if (inWindow(predicted)) dated.push({ reminder, date: predicted, predicted: true, milesLeft });
      return;
    }
    // No date in the window (none, or later): listed by miles left, which may come first.
    byMileage.push({ reminder, milesLeft });
  });

  dated.sort((a, b) => a.date!.localeCompare(b.date!) || a.reminder.title.localeCompare(b.reminder.title));
  byMileage.sort((a, b) => a.milesLeft! - b.milesLeft! || a.reminder.title.localeCompare(b.reminder.title));
  return { dated, byMileage };
};

/** Dated entries grouped by calendar month, in order. */
export const comingUpByMonth = (entries: readonly ComingUpEntry[]): ComingUpMonth[] => {
  const months: ComingUpMonth[] = [];
  entries.forEach((entry) => {
    if (!entry.date) return;
    const month = entry.date.slice(0, 7);
    let bucket = months[months.length - 1];
    if (!bucket || bucket.month !== month) {
      bucket = { month, label: format(new Date(`${month}-01T12:00:00`), 'MMMM yyyy'), entries: [] };
      months.push(bucket);
    }
    bucket.entries.push(entry);
  });
  return months;
};
