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

/**
 * Chore notifications due for one person right now. IDs are per person per
 * local day, so repeated runs never duplicate them.
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
  const mine = chores.filter((c) =>
    !c.isCompleted && isAssignedTo(c, person));
  // The occurrence's calendar day is fixed when the chore is created (in
  // the household's timezone). Re-reading its midnight instant in a member's
  // own zone would shift it a day for anyone west of the household; the
  // member's zone only decides when reminders are sent.
  const dueDay = (c: ChoreInput) => isDayString(c.originalDueDate) ?
    c.originalDueDate :
    toDay(c.dueDate, person.householdTimeZone || person.timeZone);
  const overdue = mine.filter((c) => {
    const day = dueDay(c);
    return day !== null && day < today;
  });
  const notes: ChoreNotification[] = [];

  if (overdue.length > 0 && minutes >= OVERDUE_ALERT_AFTER_MINUTES) {
    const sourceId = `overdue-${today}`;
    notes.push({
      id: `${person.uid}-${sourceId}`,
      targetUserUid: person.uid,
      title: "Overdue chores",
      message: overdue.length === 1 ?
        `"${overdue[0].task || "A chore"}" is overdue.` :
        `You have ${plural(overdue.length, "overdue chore")}.`,
      sourceId,
    });
  }

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
