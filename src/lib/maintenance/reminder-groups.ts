// One urgency-ordered view of the maintenance reminders (MA-13, MA-9): every
// reminder lands in exactly one group, and the counts for the filter chips, the
// summary cards and the dashboard come from the same pass, so nothing is counted
// twice. Pure.
import type { MaintenanceReminder, ReminderGroup } from '../../../functions/src/shared/maintenance-reminders';

export type ReminderGroupKey = 'overdue' | 'due_today' | 'due_soon' | 'snoozed' | 'upcoming';

/** Filter chip kinds: schedules, vehicle services, warranties, registration/inspection. */
export type ReminderKind = 'schedule' | 'vehicle_service' | 'warranty' | 'document';

export const REMINDER_GROUP_ORDER: readonly ReminderGroupKey[] = ['overdue', 'due_today', 'due_soon', 'snoozed', 'upcoming'];

export const REMINDER_GROUP_LABELS: Record<ReminderGroupKey, string> = {
  overdue: 'Overdue or expired',
  due_today: 'Due today',
  due_soon: 'Due soon',
  snoozed: 'Snoozed',
  upcoming: 'Upcoming',
};

export const REMINDER_KIND_ORDER: readonly ReminderKind[] = ['schedule', 'vehicle_service', 'warranty', 'document'];

export const REMINDER_KIND_LABELS: Record<ReminderKind, string> = {
  schedule: 'Home schedules',
  vehicle_service: 'Vehicle service',
  warranty: 'Warranties',
  document: 'Registration and inspection',
};

const KIND_BY_GROUP: Record<ReminderGroup, ReminderKind> = {
  scheduled: 'schedule',
  vehicle_service: 'vehicle_service',
  warranty: 'warranty',
  vehicle_document: 'document',
};

export const reminderKind = (reminder: Pick<MaintenanceReminder, 'group'>): ReminderKind => KIND_BY_GROUP[reminder.group];

/**
 * The one group a reminder belongs to. Overdue and due-today work is never
 * hidden by a snooze; a snooze only moves an upcoming or due-soon date into
 * "Snoozed".
 */
export const reminderGroupKey = (reminder: Pick<MaintenanceReminder, 'status' | 'snoozed'>): ReminderGroupKey => {
  if (reminder.status === 'overdue' || reminder.status === 'due_today') return reminder.status;
  return reminder.snoozed ? 'snoozed' : reminder.status;
};

export type ReminderGroupView = {
  key: ReminderGroupKey;
  label: string;
  reminders: MaintenanceReminder[];
};

export type ReminderCounts = {
  overdue: number;
  dueToday: number;
  dueSoon: number;
  snoozed: number;
  upcoming: number;
  /** Due today + due soon (not snoozed): the "Due Soon" number everywhere. */
  dueNow: number;
};

export type ReminderGroupsResult = {
  /** All five groups in urgency order (empty ones included, so callers decide what to hide). */
  groups: ReminderGroupView[];
  /** Counts per group for the reminders shown (after the kind filter). */
  counts: ReminderCounts;
  /** Reminders per kind before filtering, for the filter chips; `all` is the total. */
  kinds: Record<ReminderKind | 'all', number>;
};

const sortKey = (reminder: MaintenanceReminder) => {
  const date = reminder.dueDate?.slice(0, 10) || '9999-12-31';
  const miles = typeof reminder.dueMileage === 'number' && typeof reminder.currentMileage === 'number'
    ? reminder.dueMileage - reminder.currentMileage
    : Number.MAX_SAFE_INTEGER;
  return { date, miles };
};

/** Counts per group (each reminder once). */
export const reminderCounts = (reminders: readonly MaintenanceReminder[]): ReminderCounts => {
  const counts: ReminderCounts = { overdue: 0, dueToday: 0, dueSoon: 0, snoozed: 0, upcoming: 0, dueNow: 0 };
  reminders.forEach((reminder) => {
    const key = reminderGroupKey(reminder);
    if (key === 'overdue') counts.overdue++;
    else if (key === 'due_today') counts.dueToday++;
    else if (key === 'due_soon') counts.dueSoon++;
    else if (key === 'snoozed') counts.snoozed++;
    else counts.upcoming++;
  });
  counts.dueNow = counts.dueToday + counts.dueSoon;
  return counts;
};

/**
 * Groups reminders by urgency: Overdue or expired, Due today, Due soon, Snoozed,
 * Upcoming. Each reminder appears exactly once; inside a group the earliest date
 * (then the fewest miles left) comes first. `kind` filters the groups; the chip
 * counts in `kinds` are always over every reminder.
 */
export const reminderGroups = (
  reminders: readonly MaintenanceReminder[],
  kind: ReminderKind | 'all' = 'all',
): ReminderGroupsResult => {
  const kinds: Record<ReminderKind | 'all', number> = { all: reminders.length, schedule: 0, vehicle_service: 0, warranty: 0, document: 0 };
  reminders.forEach((reminder) => { kinds[reminderKind(reminder)]++; });
  const shown = kind === 'all' ? [...reminders] : reminders.filter((reminder) => reminderKind(reminder) === kind);
  const buckets = new Map<ReminderGroupKey, MaintenanceReminder[]>(REMINDER_GROUP_ORDER.map((key) => [key, []]));
  shown.forEach((reminder) => buckets.get(reminderGroupKey(reminder))!.push(reminder));
  const groups = REMINDER_GROUP_ORDER.map((key) => ({
    key,
    label: REMINDER_GROUP_LABELS[key],
    reminders: buckets.get(key)!.sort((a, b) => {
      const left = sortKey(a);
      const right = sortKey(b);
      return left.date.localeCompare(right.date) || left.miles - right.miles;
    }),
  }));
  return { groups, counts: reminderCounts(shown), kinds };
};

/** The reminders in urgency order (the groups flattened). */
export const remindersByUrgency = (reminders: readonly MaintenanceReminder[]) =>
  reminderGroups(reminders).groups.flatMap((group) => group.reminders);
