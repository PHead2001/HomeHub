// Chore reminder rules shared by the scheduled Cloud Function. Pure: callers
// pass the current instant and each person's timezone and settings.
import {localDay, localMinutes, parseTimeOfDay, toDay} from "./calendar";

export const OVERDUE_ALERT_AFTER_MINUTES = 7 * 60;

export type ChoreInput = {
  id: string;
  task?: string;
  assignedToEmail?: string;
  dueDate?: string;
  isCompleted?: boolean;
};

export type ReminderPerson = {
  uid: string;
  email: string;
  timeZone: string;
  reminderEnabled?: boolean;
  reminderTime?: string;
};

export type ChoreNotification = {
  id: string;
  targetUserUid: string;
  targetUserEmail: string;
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
 * @return {ChoreNotification[]} Notifications to ensure exist.
 */
export const choreNotificationsFor = (
  person: ReminderPerson,
  chores: ChoreInput[],
  now: Date,
): ChoreNotification[] => {
  const today = localDay(now, person.timeZone);
  const minutes = localMinutes(now, person.timeZone);
  const mine = chores.filter((c) =>
    !c.isCompleted && c.assignedToEmail === person.email);
  const dueDay = (c: ChoreInput) => toDay(c.dueDate, person.timeZone);
  const overdue = mine.filter((c) => {
    const day = dueDay(c);
    return day !== null && day < today;
  });
  const dueToday = mine.filter((c) => dueDay(c) === today);
  const notes: ChoreNotification[] = [];

  if (overdue.length > 0 && minutes >= OVERDUE_ALERT_AFTER_MINUTES) {
    const sourceId = `overdue-${today}`;
    notes.push({
      id: `${person.uid}-${sourceId}`,
      targetUserUid: person.uid,
      targetUserEmail: person.email,
      title: "Overdue chores",
      message: overdue.length === 1 ?
        `"${overdue[0].task || "A chore"}" is overdue.` :
        `You have ${plural(overdue.length, "overdue chore")}.`,
      sourceId,
    });
  }

  const reminderAt = parseTimeOfDay(person.reminderTime);
  const pending = overdue.length + dueToday.length;
  if (person.reminderEnabled && reminderAt !== null &&
      minutes >= reminderAt && pending > 0) {
    const sourceId = `reminder-${today}`;
    notes.push({
      id: `${person.uid}-${sourceId}`,
      targetUserUid: person.uid,
      targetUserEmail: person.email,
      title: "Daily chore reminder",
      message: dueToday.length > 0 && overdue.length > 0 ?
        `${plural(dueToday.length, "chore")} due today and ` +
          `${overdue.length} overdue.` :
        dueToday.length > 0 ?
          `${plural(dueToday.length, "chore")} due today.` :
          `${plural(overdue.length, "chore")} still overdue.`,
      sourceId,
    });
  }
  return notes;
};
