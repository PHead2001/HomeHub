/**
 * Medication courses on the client (P3: PE-24, PE-27, D-P7, D-P8): the pure
 * planning of Give dose, Undo, Finish and course edits, and the copy around
 * them. The schedule math is the shared model in
 * `functions/src/shared/medication-schedule.ts` (the hourly reminders use the
 * same functions). No Firebase, React or browser imports: the client
 * transactions (`medication-transaction.ts`) use it now, and a device-authorized
 * server action can read the same documents with the Admin SDK and call the
 * same planners with its own transaction (F4).
 *
 * The app never suggests a dose or a clinical schedule: Give dose is prefilled
 * only from the saved course (name, dosage, scheduled occurrence), and a legacy
 * schedule suggestion is the member's own recorded interval, shown for
 * confirmation (D-P8).
 */
import {
  COURSE_DOSAGE_MAX,
  courseDue,
  coveredThrough,
  deriveCourseState,
  latestOccurrencesUpTo,
  periodMs,
  takenLegacyKeys,
  COURSE_NAME_MAX,
  MAX_DOSE_TIMES,
  MAX_EVERY_DAYS,
  MAX_EVERY_HOURS,
  MIN_EVERY_HOURS,
  formatDoseTime,
  isCalendarDay,
  isDoseTime,
  legacyMedicationKey,
  occurrenceAtOrBefore,
  occurrenceByKey,
  occurrencesAfter,
  readSchedule,
  type CourseSchedule,
  type CourseView,
  type DosePointer,
  type Occurrence,
} from '../../../functions/src/shared/medication-schedule';
import { localDay } from '../../../functions/src/shared/calendar';
import { householdDayZone } from '../household-day';
import { currentMedications, formatAgo, parseLocalDate, type MedicationDue } from './care';
import type { PetMedicationLog } from './types';

export * from '../../../functions/src/shared/medication-schedule';

/* ------------------------------------------------------------------------- */
/* Idempotency: one operation id per press                                    */
/* ------------------------------------------------------------------------- */

const DOSE_OP_ID = /^[A-Za-z0-9_-]{8,64}$/;

/** A new operation id for one Give dose press (reused by "Record again" and Retry). */
export function newDoseOpId(): string {
  return globalThis.crypto.randomUUID();
}

/**
 * The dose log's document id for an operation: the log is created only under
 * this id, so a double tap, a retry after an uncertain response or a second
 * session running the same press finds the first write instead of adding
 * another (rules refuse a create over an existing id).
 */
export function doseLogId(opId: string): string {
  if (!DOSE_OP_ID.test(opId)) throw new Error('invalid-dose-operation');
  return opId;
}

/** A new course id (stable identity; never derived from the name). */
export function newCourseId(): string {
  return globalThis.crypto.randomUUID();
}

/* ------------------------------------------------------------------------- */
/* Every current medication: courses and legacy countdowns                     */
/* ------------------------------------------------------------------------- */

/**
 * Every current medication countdown, most urgent first: each active course's
 * next dose (from its schedule, PE-24h: the reminders compute the same) and
 * each legacy countdown whose name no course has taken over (D-P8). Ties on a
 * day go by time of day, then name.
 */
export function medicationDues(courses: CourseView[], legacyLogs: PetMedicationLog[], now: Date, timeZone?: string | null): MedicationDue[] {
  const zone = householdDayZone(timeZone);
  const scheduled = courses.flatMap((course): (MedicationDue & { time: string })[] => {
    const due = courseDue(course, now, zone);
    const day = due ? parseLocalDate(due.occurrence.day) : null;
    if (!due || !day) return [];
    return [{
      medication: course.name,
      dosage: course.dosage,
      due: day,
      dueDay: due.occurrence.day,
      days: due.days,
      state: due.state,
      label: due.label,
      courseId: course.id,
      occurrenceKey: due.occurrence.key,
      time: due.occurrence.time ?? '',
    }];
  });
  const legacy = currentMedications(legacyLogs, now, timeZone, takenLegacyKeys(courses)).map((due) => ({ ...due, time: '' }));
  return [...scheduled, ...legacy]
    .sort((a, b) => a.dueDay.localeCompare(b.dueDay) || a.time.localeCompare(b.time) || a.medication.localeCompare(b.medication))
    .map((due) => {
      const entry: MedicationDue & { time?: string } = { ...due };
      delete entry.time;
      return entry;
    });
}

/**
 * The attention line for a pet's medication (PE-26 strip and card ring): its
 * most urgent overdue dose, course or legacy ("Apoquel: overdue by 1 day").
 * A dose due today, even past its time, is not overdue (it stays amber).
 */
export function medicationAttention(dues: readonly MedicationDue[]): string | null {
  const overdue = dues.find((due) => due.state === 'overdue');
  return overdue ? `${overdue.medication}: ${overdue.label.toLowerCase()}` : null;
}

/* ------------------------------------------------------------------------- */
/* Which occurrence a dose is for                                             */
/* ------------------------------------------------------------------------- */

const courseWindow = (course: CourseView) => ({ schedule: course.schedule!, startDay: course.startDay, endDay: course.endDay });

/** Whether an occurrence is already covered (by the latest dose, that dose or a later one, or by a schedule edit). */
export function isCovered(course: Pick<CourseView, 'lastDose' | 'coveredUntil'>, occurrence: Pick<Occurrence, 'at'>): boolean {
  const through = coveredThrough(course);
  return through !== null && occurrence.at <= through;
}

export type DoseChoice = Occurrence & { covered: boolean };

export type DoseChoices = {
  /** The occurrence Give dose is prefilled with. */
  prefill: DoseChoice | null;
  /** What the member may pick instead (time order). */
  choices: DoseChoice[];
};

/**
 * The occurrences Give dose offers, and the prefilled one:
 * 1. When scheduled occurrences have passed without a dose, the latest of
 *    them (earlier missed ones stay missed: the schedule does not move).
 * 2. Otherwise the scheduled occurrence nearest to now: the latest passed one
 *    (already given, so recording it asks first, PE-24k) or the next one (an
 *    early dose covers it).
 * The choices are up to three missed occurrences, that latest given one and
 * the next upcoming one.
 */
export function doseChoices(course: CourseView, now: Date, timeZone?: string | null): DoseChoices {
  if (course.status !== 'active' || !course.schedule) return { prefill: null, choices: [] };
  const zone = householdDayZone(timeZone);
  const window = courseWindow(course);
  const at = now.getTime();
  const covered = (occurrence: Occurrence): DoseChoice => ({ ...occurrence, covered: isCovered(course, occurrence) });
  // The most recent missed doses, found back from now (never the oldest ones after an old dose).
  const missed = latestOccurrencesUpTo(window, coveredThrough(course), at, zone, 3);
  const latestPassed = occurrenceAtOrBefore(window, at, zone);
  const upcoming = occurrencesAfter(window, Math.max(at, coveredThrough(course) ?? -Infinity), zone, 1)[0] ?? null;
  const byKey = new Map<string, DoseChoice>();
  for (const occurrence of [...missed, latestPassed, upcoming]) {
    if (occurrence) byKey.set(occurrence.key, covered(occurrence));
  }
  let prefill: DoseChoice | null = null;
  if (missed.length > 0) prefill = byKey.get(missed[missed.length - 1].key) ?? null;
  else {
    // The nearest scheduled occurrence, given or not (a repeat then asks first).
    const nearest = [latestPassed, occurrencesAfter(window, at, zone, 1)[0] ?? null]
      .filter((occurrence): occurrence is Occurrence => Boolean(occurrence))
      .sort((a, b) => Math.abs(a.at - at) - Math.abs(b.at - at))[0];
    if (nearest) {
      prefill = covered(nearest);
      byKey.set(prefill.key, prefill);
    }
  }
  return { prefill, choices: [...byKey.values()].sort((a, b) => a.at - b.at) };
}

/**
 * "Today 8:00 AM", "Tomorrow 8:00 PM", "Yesterday", "Nov 14, 8:00 AM" for an
 * occurrence, in the household's day (labels the Give dose choices).
 */
export function occurrenceLabel(occurrence: Pick<Occurrence, 'day' | 'time'>, now: Date, timeZone?: string | null): string {
  const today = localDay(now, householdDayZone(timeZone));
  const time = occurrence.time ? formatDoseTime(occurrence.time) : null;
  const diff = Math.round((Date.parse(`${occurrence.day}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
  const day = diff === 0 ? 'Today' : diff === 1 ? 'Tomorrow' : diff === -1 ? 'Yesterday'
    : new Date(`${occurrence.day}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  if (!time) return day;
  return diff >= -1 && diff <= 1 ? `${day} ${time}` : `${day}, ${time}`;
}

/* ------------------------------------------------------------------------- */
/* Planning one dose                                                          */
/* ------------------------------------------------------------------------- */

/** How far back a given-at time may be chosen. */
export const DOSE_BACKDATE_MAX_MS = 7 * 24 * 3_600_000;
/** A chosen given-at time may be this far ahead of the device clock (a slightly fast clock). */
export const DOSE_FUTURE_SLACK_MS = 60_000;

/** The answer to "already given?": the latest dose it named. */
export type DoseConfirm = { lastLogId: string | null };

/** What the writer read, all from the same attempt. */
export type DoseSnapshot = {
  now: Date;
  timeZone?: string | null;
  /** The course as stored now (null when it does not exist). */
  course: CourseView | null;
  /** Whether the course's latest dose's log still exists. */
  lastDoseSurvives: boolean;
  /** This press's own log (`doseLogId(opId)`), when it already exists. */
  existing: { loggedByUid: string | null; courseId: string | null } | null;
  /** No connection: the dose is queued on this device (`repeat: 'offline'`, device clock, pointer untouched). */
  offline?: boolean;
};

export type DoseIntent = {
  userUid: string;
  /** The scheduled occurrence chosen in Give dose. */
  occurrenceKey: string;
  /** A chosen earlier given-at time; null = now (server time). */
  givenAt: Date | null;
  confirm?: DoseConfirm | null;
};

export type DoseRefusal = 'missing' | 'finished' | 'occurrence' | 'future' | 'too-old' | 'conflict';

export type DoseCheck = {
  /** The latest dose (it covers this occurrence when `reason` is `given`). */
  last: DosePointer | null;
  occurrence: Occurrence;
  /**
   * `given`: this occurrence (or a later one) was given; `moved`: a schedule
   * edit counted it as given; `recent`: a dose was given moments ago (within
   * `doseRepeatWindowMs`), so this one may be an accidental repeat even for a
   * later scheduled time (an early dose).
   */
  reason: 'given' | 'moved' | 'recent';
};

/**
 * How soon after the latest dose another one asks first: half the dose
 * interval, at most 12 hours (twice daily: 6 h; every 2 hours: 1 h; monthly: 12 h).
 */
export function doseRepeatWindowMs(schedule: CourseSchedule): number {
  return Math.min(periodMs(schedule) / 2, 12 * 3_600_000);
}

export type DosePlan =
  | { kind: 'already' }
  | { kind: 'refused'; reason: DoseRefusal }
  | { kind: 'needsConfirm'; check: DoseCheck; staleConfirm: boolean }
  | {
      kind: 'write';
      occurrence: Occurrence;
      live: boolean;
      givenAt: Date;
      /** `offline`: queued on this device without a check against other sessions. */
      repeat: 'none' | 'confirmed' | 'offline';
      confirmOf: string | null;
      /** The new dose becomes the course's latest dose (`prevDose` = the replaced one, when it survives). */
      becomesLatest: boolean;
      /** The occurrence due after this dose. */
      nextAfter: Occurrence | null;
    };

/**
 * Decides one Give dose press from what the writer read: the press was
 * already recorded (idempotent replay), refuse it, ask first because that
 * occurrence (or a later one) was already given (bound to the dose it names,
 * so a stale answer never records over a newer dose), or write the log and
 * the course's dose pointer.
 */
export function planDose(snapshot: DoseSnapshot, intent: DoseIntent): DosePlan {
  const { now, course, existing } = snapshot;
  if (existing) {
    // This press already wrote its log (a retry, a double run or another session).
    return existing.loggedByUid === intent.userUid ? { kind: 'already' } : { kind: 'refused', reason: 'conflict' };
  }
  if (!course) return { kind: 'refused', reason: 'missing' };
  if (course.status !== 'active' || !course.schedule) return { kind: 'refused', reason: 'finished' };
  const zone = householdDayZone(snapshot.timeZone);
  const occurrence = occurrenceByKey(courseWindow(course), intent.occurrenceKey, zone);
  if (!occurrence) return { kind: 'refused', reason: 'occurrence' };
  if (intent.givenAt) {
    if (intent.givenAt.getTime() > now.getTime() + DOSE_FUTURE_SLACK_MS) return { kind: 'refused', reason: 'future' };
    if (intent.givenAt.getTime() < now.getTime() - DOSE_BACKDATE_MAX_MS) return { kind: 'refused', reason: 'too-old' };
  }
  const last = snapshot.lastDoseSurvives ? course.lastDose : null;
  // A dose recorded offline (not in `lastDose`) covers its occurrence too.
  const offlineDose = course.offlineDose ?? null;
  const givenStored = Boolean(last) && occurrence.at <= last!.occurrenceAt;
  const givenOffline = !givenStored && Boolean(offlineDose) && occurrence.at <= offlineDose!.occurrenceAt;
  const named = givenStored ? last : givenOffline ? offlineDose : null;
  const moved = !named && course.coveredUntil !== null && occurrence.at <= course.coveredUntil;
  // The latest surviving dose (the derived state: the cache or a later record).
  const latest = [last, offlineDose].filter((dose): dose is DosePointer => Boolean(dose))
    .sort((a, b) => b.occurrenceAt - a.occurrenceAt || (b.givenAt ?? 0) - (a.givenAt ?? 0))[0] ?? null;
  const recent = !named && !moved && latest !== null && latest.givenAt !== null &&
    now.getTime() - latest.givenAt < doseRepeatWindowMs(course.schedule);
  let repeat: 'none' | 'confirmed' | 'offline' = 'none';
  let confirmOf: string | null = null;
  if (named || moved || recent) {
    const confirm = intent.confirm;
    const shown = named ?? (recent ? latest : last);
    if (!confirm || confirm.lastLogId !== (shown?.logId ?? null)) {
      return { kind: 'needsConfirm', check: { last: shown, occurrence, reason: named ? 'given' : moved ? 'moved' : 'recent' }, staleConfirm: Boolean(confirm) };
    }
    if (named || recent) {
      repeat = 'confirmed';
      confirmOf = shown!.logId;
    }
  }
  const after = Math.max(occurrence.at, coveredThrough({ ...course, lastDose: last }) ?? -Infinity);
  const nextAfter = occurrencesAfter(courseWindow(course), after, zone, 1)[0] ?? null;
  if (snapshot.offline) {
    // Queued on this device: the device clock, marked offline, and the course's
    // pointer is left alone (readers combine it with offline doses).
    return { kind: 'write', occurrence, live: false, givenAt: intent.givenAt ?? now, repeat: 'offline', confirmOf: null, becomesLatest: false, nextAfter };
  }
  const becomesLatest = !last || occurrence.at >= last.occurrenceAt;
  // A chosen time within a minute of now is a live dose (server time).
  const live = !intent.givenAt || Math.abs(intent.givenAt.getTime() - now.getTime()) <= DOSE_FUTURE_SLACK_MS;
  return { kind: 'write', occurrence, live, givenAt: live ? now : intent.givenAt!, repeat, confirmOf, becomesLatest, nextAfter };
}

/** The answer to the "already given?" question it was shown for. */
export function doseConfirmOf(check: DoseCheck): DoseConfirm {
  return { lastLogId: check.last?.logId ?? null };
}

/* ------------------------------------------------------------------------- */
/* Undo / delete of a dose                                                    */
/* ------------------------------------------------------------------------- */


/**
 * The course's pointer (`lastDose` / `prevDose`) after a write, derived from
 * the surviving dose records the writer read plus its own change
 * (`deriveCourseState`): every online write (give, Undo, delete) stores it, so
 * the pointer is a cache that always agrees with the records. `write` is false
 * when the stored pointer already equals it.
 */
export function pointerAfter(course: Pick<CourseView, 'coveredUntil' | 'lastDose' | 'prevDose'>, records: DosePointer[]): { latest: DosePointer | null; prev: DosePointer | null; write: boolean } {
  const { latest, prev } = deriveCourseState(course, records);
  const write = (latest?.logId ?? null) !== (course.lastDose?.logId ?? null) || (prev?.logId ?? null) !== (course.prevDose?.logId ?? null);
  return { latest, prev, write };
}

/* ------------------------------------------------------------------------- */
/* Copy                                                                       */
/* ------------------------------------------------------------------------- */

const byWhom = (pointer: Pick<DosePointer, 'byUid' | 'byName'>, viewerUid?: string | null) =>
  pointer.byUid && pointer.byUid === viewerUid ? 'you' : pointer.byName || 'someone';

/** "Last given 2 h ago by Sam" (the current last-dose context, PE-24k). */
export function lastDoseLine(course: Pick<CourseView, 'lastDose'>, now: Date, timeZone?: string | null, viewerUid?: string | null): string | null {
  const last = course.lastDose;
  if (!last || last.givenAt === null) return null;
  return `Last given ${formatAgo(new Date(last.givenAt), now, timeZone)} by ${byWhom(last, viewerUid)}`;
}

/** "Sam recorded the Today 8:00 AM dose 5 min ago." for the "already given?" question. */
export function doseRepeatReason(check: DoseCheck, now: Date, timeZone?: string | null, viewerUid?: string | null): string {
  if (check.reason === 'moved' || !check.last) {
    return `The schedule was changed after the last dose, so the ${occurrenceLabel(check.occurrence, now, timeZone)} dose counts as given.`;
  }
  const who = byWhom(check.last, viewerUid);
  if (check.reason === 'recent') {
    const whom = who === 'you' ? 'You' : who.charAt(0).toUpperCase() + who.slice(1);
    const when = check.last.givenAt === null ? '' : ` ${formatAgo(new Date(check.last.givenAt), now, timeZone)}`;
    const forTime = occurrenceLabel({ day: check.last.occurrence.slice(0, 10), time: check.last.occurrence.slice(11) || null }, now, timeZone);
    return `${whom} recorded a dose${when} (the ${forTime} dose). The ${occurrenceLabel(check.occurrence, now, timeZone)} dose would be early.`;
  }
  const whom = who === 'you' ? 'You' : who.charAt(0).toUpperCase() + who.slice(1);
  const when = check.last.givenAt === null ? '' : ` ${formatAgo(new Date(check.last.givenAt), now, timeZone)}`;
  const same = check.last.occurrence === check.occurrence.key;
  const what = same
    ? `the ${occurrenceLabel(check.occurrence, now, timeZone)} dose`
    : `a dose for a later time (${occurrenceLabel({ day: check.last.occurrence.slice(0, 10), time: check.last.occurrence.slice(11) || null }, now, timeZone)})`;
  return `${whom} recorded ${what}${when}.`;
}

/** The toast copy after Undo: the record is removed; the dose itself is not undone (16.3, WT-20). */
export const DOSE_UNDO_COPY = {
  title: 'Dose record removed',
  description: 'Only the record is removed. If the dose was given, it still counts.',
} as const;

export type DoseLinkDecision =
  | { kind: 'idle' }
  /** The courses are loading or their read failed (the listener retries): keep the link. */
  | { kind: 'wait' }
  | { kind: 'open'; courseId: string }
  | { kind: 'inactive' }
  /** The link was handled and has left the URL: the same reminder tapped again opens again. */
  | { kind: 'reset' };

/**
 * What a reminder's `?dose=<courseId>` link does on the Medication tab: it is
 * consumed (Give dose opens, or "no longer active") only after a successful
 * read of the pet's courses, never while they load or while their listener is
 * failing, so a link is not dropped before the read recovers.
 */
export function doseLinkDecision(input: { requested: string | null; seen: string | null; loading: boolean; error: unknown; courses: Pick<CourseView, 'id' | 'status'>[] }): DoseLinkDecision {
  if (!input.requested) return input.seen ? { kind: 'reset' } : { kind: 'idle' };
  if (input.requested === input.seen) return { kind: 'idle' };
  if (input.loading || input.error) return { kind: 'wait' };
  const course = input.courses.find((entry) => entry.id === input.requested && entry.status === 'active');
  return course ? { kind: 'open', courseId: course.id } : { kind: 'inactive' };
}

/** The pet's Undo toast group for one course's doses. */
export function petDoseToastGroup(petId: string, courseId: string): string {
  return `pet-dose:${petId}:${courseId}`;
}

/* ------------------------------------------------------------------------- */
/* The course form                                                            */
/* ------------------------------------------------------------------------- */

export type CourseFormValues = {
  name: string;
  dosage: string;
  kind: 'days' | 'hours';
  everyDays: string;
  /** `HH:mm` values; empty strings are ignored. */
  times: string[];
  everyHours: string;
  firstTime: string;
  startDay: string;
  endDay: string;
};

export type CourseFormErrors = Partial<Record<'name' | 'dosage' | 'everyDays' | 'times' | 'everyHours' | 'firstTime' | 'startDay' | 'endDay', string>>;

export type CourseFields = {
  name: string;
  dosage: string;
  schedule: CourseSchedule;
  startDay: string;
  endDay: string | null;
};

/** Form values for a course (edit) or a new one (with optional prefills). */
export function courseFormValues(course: Partial<Pick<CourseView, 'name' | 'dosage' | 'schedule' | 'startDay' | 'endDay'>>, today: string): CourseFormValues {
  const schedule = course.schedule ?? null;
  return {
    name: course.name ?? '',
    dosage: course.dosage ?? '',
    kind: schedule?.kind ?? 'days',
    everyDays: schedule?.kind === 'days' ? String(schedule.everyDays) : '1',
    times: schedule?.kind === 'days' ? (schedule.times.length > 0 ? [...schedule.times] : []) : schedule ? [] : ['08:00'],
    everyHours: schedule?.kind === 'hours' ? String(schedule.everyHours) : '12',
    firstTime: schedule?.kind === 'hours' ? schedule.firstTime : '08:00',
    startDay: course.startDay ?? today,
    endDay: course.endDay ?? '',
  };
}

/**
 * Validates the course form. `activeNames` are the pet's other active courses
 * (lower-cased): a second active course with the same name is refused, so a
 * typo does not start a parallel course by accident (PE-4c).
 */
export function validateCourseForm(values: CourseFormValues, activeNames: string[] = []): { errors: CourseFormErrors; fields: CourseFields | null } {
  const errors: CourseFormErrors = {};
  const name = values.name.trim();
  const dosage = values.dosage.trim();
  if (!name) errors.name = 'Enter the medication name.';
  else if (name.length > COURSE_NAME_MAX) errors.name = `Keep the name under ${COURSE_NAME_MAX} characters.`;
  else if (activeNames.includes(legacyMedicationKey(name))) errors.name = 'This pet already has an active course with this name. Give its dose or edit it instead.';
  if (!dosage) errors.dosage = 'Enter the dosage from the plan.';
  else if (dosage.length > COURSE_DOSAGE_MAX) errors.dosage = `Keep the dosage under ${COURSE_DOSAGE_MAX} characters.`;
  let schedule: CourseSchedule | null = null;
  if (values.kind === 'days') {
    const everyDays = Number(values.everyDays);
    const times = values.times.map((time) => time.trim()).filter(Boolean);
    if (!Number.isInteger(everyDays) || everyDays < 1 || everyDays > MAX_EVERY_DAYS) errors.everyDays = `Enter a whole number of days from 1 to ${MAX_EVERY_DAYS}.`;
    if (times.some((time) => !isDoseTime(time))) errors.times = 'Pick each time of day.';
    else if (times.length > MAX_DOSE_TIMES) errors.times = `Up to ${MAX_DOSE_TIMES} times a day.`;
    else if (new Set(times).size !== times.length) errors.times = 'Each time can be listed once.';
    if (!errors.everyDays && !errors.times) schedule = readSchedule({ kind: 'days', everyDays, times });
  } else {
    const everyHours = Number(values.everyHours);
    if (!Number.isInteger(everyHours) || everyHours < MIN_EVERY_HOURS || everyHours > MAX_EVERY_HOURS) errors.everyHours = `Enter a whole number of hours from ${MIN_EVERY_HOURS} to ${MAX_EVERY_HOURS}.`;
    if (!isDoseTime(values.firstTime)) errors.firstTime = 'Pick the time of the first dose.';
    if (!errors.everyHours && !errors.firstTime) schedule = readSchedule({ kind: 'hours', everyHours, firstTime: values.firstTime });
  }
  if (!isCalendarDay(values.startDay)) errors.startDay = 'Pick the first day.';
  const endDay = values.endDay.trim();
  if (endDay && !isCalendarDay(endDay)) errors.endDay = 'Pick a valid last day.';
  else if (endDay && isCalendarDay(values.startDay) && endDay < values.startDay) errors.endDay = 'The last day can’t be before the first day.';
  if (Object.keys(errors).length > 0 || !schedule) return { errors, fields: null };
  return { errors, fields: { name, dosage, schedule, startDay: values.startDay, endDay: endDay || null } };
}

/** The first few scheduled doses of a draft (the form's preview, never a recommendation). */
export function schedulePreview(fields: Pick<CourseFields, 'schedule' | 'startDay' | 'endDay'>, now: Date, timeZone?: string | null, count = 3): Occurrence[] {
  const zone = householdDayZone(timeZone);
  return occurrencesAfter(fields, now.getTime() - 1, zone, count);
}

/** Whether a stored course and new fields differ in anything that moves its occurrences. */
export function scheduleChanged(course: Pick<CourseView, 'schedule' | 'startDay' | 'endDay'>, fields: Pick<CourseFields, 'schedule' | 'startDay' | 'endDay'>): boolean {
  return JSON.stringify(course.schedule) !== JSON.stringify(fields.schedule) || course.startDay !== fields.startDay || course.endDay !== fields.endDay;
}
