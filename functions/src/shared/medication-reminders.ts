// Pet medication reminders, computed on the server by hourly upkeep. Pure (no
// Firebase imports) so they can be unit-tested.
//
// Two models live side by side (D-P8):
// - Courses (`medication-courses`, ./medication-schedule.ts): one reminder per
//   scheduled occurrence, for the course's next due occurrence once its time
//   (or, with no set time, its day) has come; "due" on that household day,
//   "overdue" after it. A finished or ended course has none. Identity:
//   sourceId `<petId>:course:<courseId>`, stateKey `<state>|<occurrence key>`.
// - Legacy medications (entries without a course, grouped by trimmed,
//   lower-cased name, the rule of `currentMedications` in
//   src/lib/pets/care.ts): the most recent entry of each medication decides
//   its next due date, so a later entry without one cancels the countdown.
//   A legacy name a course has taken over (confirmed, merged or finished) no
//   longer reminds. Entries without a readable date are ignored.
import {DEFAULT_TIME_ZONE, isDayString} from "./calendar";
import {
  courseDue, formatDoseTime, isLegacyLog, legacyMedicationKey,
  nextDueOccurrence, readCourse, takenLegacyKeys, toMillis,
  type CourseView,
} from "./medication-schedule";

export const MEDICATION_SOURCE_TYPE = "pet_medication";

export type MedicationLogInput = {
  date?: unknown;
  medication?: unknown;
  nextDueDate?: unknown;
  courseId?: unknown;
  oneOff?: unknown;
};

export type CourseInput = {id: string; data: Record<string, unknown>};

export type PetInput = {
  id: string;
  name?: unknown;
  logs: MedicationLogInput[];
  /** The pet's medication courses (absent: none). */
  courses?: CourseInput[];
};

export type MedicationDue = {
  /** Trimmed, lower-cased medication name (the grouping key). */
  key: string;
  /** The name as written on the latest entry. */
  medication: string;
  /** Next due day, yyyy-MM-dd. */
  dueDay: string;
};

export type MedicationReminder = {
  sourceType: typeof MEDICATION_SOURCE_TYPE;
  sourceId: string;
  stateKey: string;
  state: "due" | "overdue";
  title: string;
  message: string;
  deepLink: string;
};

/** When course reminders are judged: the instant and the household zone. */
export type ReminderClock = {now: Date; timeZone: string};

/**
 * A real yyyy-MM-dd calendar day (rejects rollovers such as Feb 30, as the
 * Pets page's parseLocalDate does).
 * @param {unknown} value Candidate.
 * @return {boolean} True for a valid day string.
 */
const isDueDay = (value: unknown): value is string =>
  isDayString(value) &&
  new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;

/**
 * The pet's readable courses.
 * @param {PetInput} pet Pet with its courses.
 * @return {CourseView[]} Courses.
 */
export const petCourses = (pet: Pick<PetInput, "courses">): CourseView[] =>
  (pet.courses ?? []).flatMap((course) => {
    const view = readCourse(course.id, course.data);
    return view ? [view] : [];
  });

/**
 * Pending legacy countdowns for one pet: one entry per legacy medication
 * whose latest entry carries a valid next due date. Course entries, one-off
 * doses and names a course has taken over are not legacy countdowns.
 * @param {MedicationLogInput[]} logs Every medication entry of the pet.
 * @param {Set<string>} taken Legacy keys taken over by a course.
 * @return {MedicationDue[]} Pending countdowns.
 */
export const pendingMedications = (
  logs: MedicationLogInput[],
  taken: Set<string> = new Set(),
): MedicationDue[] => {
  const latest = new Map<string, {at: number; log: MedicationLogInput}>();
  for (const log of logs) {
    if (!isLegacyLog(log)) continue;
    const key = legacyMedicationKey(log.medication);
    const at = toMillis(log.date);
    if (!key || at === null || taken.has(key)) continue;
    const current = latest.get(key);
    if (!current || at > current.at) latest.set(key, {at, log});
  }
  const pending: MedicationDue[] = [];
  for (const [key, {log}] of latest) {
    if (!isDueDay(log.nextDueDate)) continue;
    pending.push({
      key,
      medication: String(log.medication).trim(),
      dueDay: log.nextDueDate,
    });
  }
  return pending;
};

const petName = (pet: PetInput): string =>
  typeof pet.name === "string" && pet.name.trim() ?
    pet.name.trim().slice(0, 40) : "Your pet";

/**
 * Source id of a course's reminders.
 * @param {string} petId Pet id.
 * @param {string} courseId Course id.
 * @return {string} `<petId>:course:<courseId>`.
 */
export const courseSourceId = (petId: string, courseId: string): string =>
  `${petId}:course:${courseId}`;

/**
 * The reminder deep link: the pet's Medication tab with Give dose open for
 * the course (legacy medications: the tab, where the confirmation card is).
 * @param {string} petId Pet id.
 * @param {string} courseId Course id, when there is one.
 * @return {string} Path.
 */
export const medicationDeepLink = (petId: string, courseId?: string):
  string => `/pets/${encodeURIComponent(petId)}?tab=medication` +
    (courseId ? `&dose=${encodeURIComponent(courseId)}` : "");

const legacyReminders = (pet: PetInput, today: string):
  MedicationReminder[] => {
  const taken = takenLegacyKeys(petCourses(pet));
  return pendingMedications(pet.logs, taken)
    .filter((due) => due.dueDay <= today)
    .map((due): MedicationReminder => {
      const state = due.dueDay === today ? "due" : "overdue";
      const name = petName(pet);
      const medication = due.medication.slice(0, 60);
      return {
        sourceType: MEDICATION_SOURCE_TYPE,
        sourceId: `${pet.id}:${due.key}`,
        stateKey: `${state}|${due.dueDay}`,
        state,
        title: state === "due" ?
          `${name}'s ${medication} is due today` :
          `${name}'s ${medication} is overdue`,
        message: `Open ${name}'s Medication tab to record the dose once ` +
          "it's given, or to confirm its schedule.",
        deepLink: medicationDeepLink(pet.id),
      };
    });
};

const courseReminders = (pet: PetInput, clock: ReminderClock):
  MedicationReminder[] => petCourses(pet).flatMap((course) => {
  const due = courseDue(course, clock.now, clock.timeZone);
  if (!due || !due.reached) return [];
  const state = due.days < 0 ? "overdue" : "due";
  const name = petName(pet);
  const medication = course.name.slice(0, 60);
  const time = due.occurrence.time ?
    ` ${formatDoseTime(due.occurrence.time)}` : "";
  const dosage = course.dosage ?
    `Planned dose: ${course.dosage.slice(0, 60)}. ` : "";
  return [{
    sourceType: MEDICATION_SOURCE_TYPE,
    sourceId: courseSourceId(pet.id, course.id),
    stateKey: `${state}|${due.occurrence.key}`,
    state,
    title: state === "due" ?
      `${name}'s ${medication}${time} dose is due` :
      `${name}'s ${medication} dose is overdue`,
    message: `${dosage}Tap to record it once it's given.`,
    deepLink: medicationDeepLink(pet.id, course.id),
  }];
});

/**
 * Reminders for medications due today or overdue (in the household's day):
 * each course's next due occurrence once reached, and each legacy countdown
 * due today or overdue.
 * @param {PetInput[]} pets Pets with their medication entries and courses.
 * @param {string} today Household-local day, yyyy-MM-dd.
 * @param {ReminderClock} clock Instant and zone for course occurrences
 *   (defaults to the start of `today` in UTC and the default zone).
 * @return {MedicationReminder[]} One reminder per actionable countdown.
 */
export const buildMedicationReminders = (
  pets: PetInput[],
  today: string,
  clock?: ReminderClock,
): MedicationReminder[] => {
  const when = clock ?? {
    now: new Date(`${today}T00:00:00Z`), timeZone: DEFAULT_TIME_ZONE,
  };
  return pets.flatMap((pet) => [
    ...courseReminders(pet, when),
    ...legacyReminders(pet, today),
  ]);
};

/**
 * The countdown a reminder belongs to: the medication (or course) and its due
 * day (or occurrence). A reminder stays open while that countdown is still
 * pending (due turning overdue is the same countdown) and resolves once it is
 * not.
 * @param {string} sourceId `<petId>:<medicationKey>` or a course source id.
 * @param {string} stateKey `<due|overdue>|<day or occurrence>`.
 * @return {string} Countdown identity.
 */
export const medicationCycle = (sourceId: string, stateKey: string): string =>
  `${sourceId}|${stateKey.split("|")[1] ?? ""}`;

/**
 * Countdown identities that are still pending (due or not yet due): each
 * active course's next due occurrence and each legacy countdown.
 * @param {PetInput[]} pets Pets with their medication entries and courses.
 * @param {string} timeZone Household zone (course occurrences).
 * @return {Set<string>} Identities, as from medicationCycle.
 */
export const pendingCycles = (
  pets: PetInput[], timeZone: string = DEFAULT_TIME_ZONE,
): Set<string> =>
  new Set(pets.flatMap((pet) => {
    const courses = petCourses(pet);
    const legacy = pendingMedications(pet.logs, takenLegacyKeys(courses))
      .map((due) => `${pet.id}:${due.key}|${due.dueDay}`);
    const scheduled = courses.flatMap((course) => {
      const next = nextDueOccurrence(course, timeZone);
      return next ?
        [`${courseSourceId(pet.id, course.id)}|${next.key}`] : [];
    });
    return [...scheduled, ...legacy];
  }));
