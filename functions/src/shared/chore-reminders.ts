// Chore reminder rules shared by the scheduled Cloud Function. Pure: callers
// pass the current instant and each person's timezone and settings.
import {isAssignedTo} from "./assignee";
import {
  isDayString, localDay, localMinutes, parseTimeOfDay, toDay,
} from "./calendar";

export const OVERDUE_ALERT_AFTER_MINUTES = 7 * 60;
/** householdUpkeep runs every 60 minutes. */
export const UPKEEP_INTERVAL_MS = 60 * 60 * 1000;

export type ChoreInput = {
  id: string;
  task?: string;
  assignedToUid?: string;
  assignedToEmail?: string;
  dueDate?: string;
  /** Occurrence day ("YYYY-MM-DD") in the household's timezone. */
  originalDueDate?: string;
  isCompleted?: boolean;
};

export type ReminderPerson = {
  uid: string;
  email: string;
  timeZone: string;
  /** Zone chore dates were written in (for chores without originalDueDate). */
  householdTimeZone?: string;
  reminderEnabled?: boolean;
  reminderTime?: string;
};

export type ChoreNotification = {
  id: string;
  targetUserUid: string;
  title: string;
  message: string;
  sourceId: string;
};

const plural = (count: number, word: string) =>
  `${count} ${word}${count === 1 ? "" : "s"}`;

/** The person's overdue chores as this run sees them. */
export type OverdueView = {
  /** Local day of the person. */
  today: string;
  /**
   * Incomplete chores assigned to them, due before their local today, newest
   * due day first (then by ID).
   */
  chores: Array<{id: string; task: string; day: string}>;
  /** At or after OVERDUE_ALERT_AFTER_MINUTES local time. */
  alertsAllowed: boolean;
  /** Their daily reminder is enabled and its time is still to come today. */
  dailyReminderPending: boolean;
};

const isMine = (person: ReminderPerson) => (c: ChoreInput) =>
  !c.isCompleted && isAssignedTo(c, person);

// The occurrence's calendar day is fixed when the chore is created (in the
// household's timezone). Re-reading its midnight instant in a member's own
// zone would shift it a day for anyone west of the household; the member's
// zone only decides when reminders are sent.
const dueDayFor = (person: ReminderPerson) => (c: ChoreInput) =>
  isDayString(c.originalDueDate) ?
    c.originalDueDate :
    toDay(c.dueDate, person.householdTimeZone || person.timeZone);

/**
 * One person's overdue chores, for their single overdue notification
 * (decided by `decideOverdue` in ./overdue-notification).
 * @param {ReminderPerson} person Recipient with settings and timezone.
 * @param {ChoreInput[]} chores Household chores.
 * @param {Date} now Current instant.
 * @return {OverdueView} Overdue chores and timing.
 */
export const overdueChoresFor = (
  person: ReminderPerson,
  chores: ChoreInput[],
  now: Date,
): OverdueView => {
  const today = localDay(now, person.timeZone);
  const minutes = localMinutes(now, person.timeZone);
  const dueDay = dueDayFor(person);
  const reminderAt = parseTimeOfDay(person.reminderTime);
  return {
    today,
    chores: chores.filter(isMine(person)).flatMap((c) => {
      const day = dueDay(c);
      return day !== null && day < today ?
        [{id: c.id, task: c.task || "A chore", day}] : [];
    }).sort((a, b) => a.day === b.day ?
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) : a.day < b.day ? 1 : -1),
    alertsAllowed: minutes >= OVERDUE_ALERT_AFTER_MINUTES,
    dailyReminderPending: Boolean(person.reminderEnabled) &&
      reminderAt !== null && minutes < reminderAt,
  };
};

/**
 * The overdue notification's message for these chores.
 * @param {string[]} tasks Names of the listed chores.
 * @param {number} total Overdue chores in all (more than listed past the
 * list cap).
 * @return {string} Message.
 */
export const overdueMessage = (
  tasks: string[],
  total = tasks.length,
): string => total === 1 && tasks.length === 1 ?
  `"${tasks[0]}" is overdue.` :
  `You have ${plural(total, "overdue chore")}.`;

/**
 * Daily chore reminders due for one person right now. IDs are per person per
 * local day, so repeated runs never duplicate them. Overdue chores are counted
 * in the reminder; the separate overdue notification is `overdueChoresFor`.
 * @param {ReminderPerson} person Recipient with settings and timezone.
 * @param {ChoreInput[]} chores Household chores.
 * @param {Date} now Current instant.
 * @param {number} runIntervalMs Time since the previous scheduled run.
 * @return {ChoreNotification[]} Notifications to ensure exist.
 */
export const choreNotificationsFor = (
  person: ReminderPerson,
  chores: ChoreInput[],
  now: Date,
  runIntervalMs = UPKEEP_INTERVAL_MS,
): ChoreNotification[] => {
  const today = localDay(now, person.timeZone);
  const minutes = localMinutes(now, person.timeZone);
  const mine = chores.filter(isMine(person));
  const dueDay = dueDayFor(person);
  const notes: ChoreNotification[] = [];

  const reminderAt = parseTimeOfDay(person.reminderTime);
  const dailyReminder = (day: string): ChoreNotification | null => {
    const late = mine.filter((c) => {
      const due = dueDay(c);
      return due !== null && due < day;
    });
    const onDay = mine.filter((c) => dueDay(c) === day);
    if (late.length + onDay.length === 0) return null;
    const sourceId = `reminder-${day}`;
    const when = day === today ? "today" : "yesterday";
    return {
      id: `${person.uid}-${sourceId}`,
      targetUserUid: person.uid,
      title: "Daily chore reminder",
      message: onDay.length > 0 && late.length > 0 ?
        `${plural(onDay.length, "chore")} due ${when} and ` +
          `${late.length} overdue.` :
        onDay.length > 0 ?
          `${plural(onDay.length, "chore")} due ${when}.` :
          `${plural(late.length, "chore")} still overdue.`,
      sourceId,
    };
  };
  if (person.reminderEnabled && reminderAt !== null) {
    if (minutes >= reminderAt) {
      const note = dailyReminder(today);
      if (note) notes.push(note);
    }
    // A reminder time after the day's last scheduled run (say 23:30 with runs
    // on the hour) is never reached on its own day; the first run of the next
    // day sends it instead.
    const previousRun = new Date(now.getTime() - runIntervalMs);
    const previousDay = localDay(previousRun, person.timeZone);
    if (previousDay !== today &&
        localMinutes(previousRun, person.timeZone) < reminderAt) {
      const note = dailyReminder(previousDay);
      if (note) notes.push(note);
    }
  }
  return notes;
};
