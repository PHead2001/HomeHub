// User-facing copy for reminder cards. The status badge says what state the item
// is in; the detail line says when, so nothing is said twice (D16).
import { format } from 'date-fns';
import { diffDays, isDayString } from '../../../functions/src/shared/calendar';
import type {
  MaintenanceReminder,
  ReminderGroup,
  ReminderStatus,
} from '../../../functions/src/shared/maintenance-reminders';

const expires = (group: ReminderGroup) => group === 'warranty' || group === 'vehicle_document';

/** Badge text. Warranties and documents expire; they are never "overdue". */
export const reminderStatusLabel = (group: ReminderGroup, status: ReminderStatus) => {
  if (expires(group)) {
    return { overdue: 'Expired', due_today: 'Expires today', due_soon: 'Expires soon', upcoming: 'Upcoming' }[status];
  }
  return { overdue: 'Overdue', due_today: 'Due today', due_soon: 'Due soon', upcoming: 'Upcoming' }[status];
};

const plural = (count: number, word: string) => `${count.toLocaleString('en-US')} ${word}${count === 1 ? '' : 's'}`;

/** "3 days", "5 weeks", "4 months": coarse enough to read at a glance. */
export const spanLabel = (days: number) => {
  const value = Math.abs(days);
  if (value < 14) return plural(value, 'day');
  if (value < 60) return plural(Math.floor(value / 7), 'week');
  if (value < 730) return plural(Math.floor(value / 30), 'month');
  return plural(Math.floor(value / 365), 'year');
};

const shortDate = (day: string) => format(new Date(`${day}T12:00:00`), 'MMM d, yyyy');

/**
 * One line of "when" for a reminder card, e.g. "Due Aug 1, 2026 · 2 weeks ago",
 * "At 49,000 mi · 250 mi to go", "Expired Jul 30, 2026". It never repeats the
 * status word the badge already shows.
 */
export const reminderDueDetail = (
  reminder: Pick<MaintenanceReminder, 'group' | 'status' | 'dueDate' | 'dueMileage' | 'currentMileage'>,
  today: string,
) => {
  const parts: string[] = [];
  const dueDay = reminder.dueDate && isDayString(reminder.dueDate) ? reminder.dueDate : reminder.dueDate?.slice(0, 10);
  if (dueDay && isDayString(dueDay)) {
    const days = diffDays(dueDay, today);
    const verb = expires(reminder.group) ? (days < 0 ? 'Expired' : 'Expires') : 'Due';
    if (days === 0) parts.push(`${verb} ${shortDate(dueDay)}`);
    else parts.push(`${verb} ${shortDate(dueDay)} · ${days < 0 ? `${spanLabel(days)} ago` : `in ${spanLabel(days)}`}`);
  }
  if (typeof reminder.dueMileage === 'number') {
    const at = `At ${reminder.dueMileage.toLocaleString('en-US')} mi`;
    if (typeof reminder.currentMileage === 'number') {
      const left = reminder.dueMileage - reminder.currentMileage;
      parts.push(`${at} · ${left <= 0 ? `${Math.abs(left).toLocaleString('en-US')} mi over` : `${left.toLocaleString('en-US')} mi to go`}`);
    } else {
      parts.push(at);
    }
  }
  return parts.join(' or ');
};
