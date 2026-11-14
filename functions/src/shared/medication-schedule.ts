// Medication courses (audit PE-24, PE-27, D-P7, D-P8): the one schedule
// model shared by the Pets pages (src/lib/pets) and the hourly reminders, so
// the card, the Medication tab, the Calendar and the pushes compute the same
// next dose.
// Pure: no Firebase imports, no device clock or zone (callers pass `now` and
// the household zone).
//
// A course is a document with a stable id (never its display name), a
// user-confirmed schedule, a start day and an optional end day. Its scheduled
// occurrences come only from that schedule:
// - "days": every N days from the start day, at set times of day (household
//   wall clock), or at no set time (due all day);
// - "hours": every N hours from the first dose time on the start day (absolute
//   hours, so the wall time moves across a daylight-saving change).
// The course remembers its latest dose (`lastDose`: the occurrence it covered
// and that occurrence's instant). The next due occurrence is the first one
// after it: a late dose never becomes a new schedule, an early dose covers the
// occurrence it was given for, and a backdated dose changes nothing about the
// schedule. A schedule edit may also cover the new schedule's occurrence that
// replaces the one last given (`coveredUntil`), so moving 8:00 AM to 9:00 AM
// after the morning dose does not ask for it again.
import {
  addDays, diffDays, isDayString, localDay, localMinutes, safeTimeZone,
} from "./calendar";

export const MAX_DOSE_TIMES = 6;
export const MAX_EVERY_DAYS = 90;
export const MIN_EVERY_HOURS = 2;
export const MAX_EVERY_HOURS = 72;
export const COURSE_NAME_MAX = 80;
export const COURSE_DOSAGE_MAX = 80;
export const MAX_LEGACY_KEYS = 10;

const HOUR_MS = 3600000;
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

export type CourseSchedule =
  {kind: "days"; everyDays: number; times: string[]} |
  {kind: "hours"; everyHours: number; firstTime: string};

export type DosePointer = {
  logId: string;
  /** Occurrence key the dose covered. */
  occurrence: string;
  /** That occurrence's instant (ms). */
  occurrenceAt: number;
  /** Effective given-at time (ms), when readable. */
  givenAt: number | null;
  byUid: string | null;
  byName: string | null;
};

export type CourseView = {
  id: string;
  name: string;
  dosage: string;
  /** Null only on a legacy course finished without a schedule. */
  schedule: CourseSchedule | null;
  startDay: string;
  endDay: string | null;
  status: "active" | "finished";
  lastDose: DosePointer | null;
  prevDose: DosePointer | null;
  /** Set by a schedule edit: occurrences up to this instant count as given. */
  coveredUntil: number | null;
  /**
   * The latest dose recorded offline (`repeat: 'offline'`, not in `lastDose`):
   * readers fill it from the logs they have (`withOfflineDoses`), and it covers
   * its occurrence like `lastDose` does.
   */
  offlineDose?: DosePointer | null;
  /** Legacy (name-keyed) medications this course took over (D-P8). */
  legacyKeys: string[];
};

export type Occurrence = {
  /** `yyyy-MM-dd` (no set time) or `yyyy-MM-ddTHH:mm` (household wall time). */
  key: string;
  /** Household day of the occurrence. */
  day: string;
  /** Wall time `HH:mm`, or null when due all day. */
  time: string | null;
  /** Instant (ms). An all-day occurrence starts at the day's midnight. */
  at: number;
};

export type OccurrenceState = "overdue" | "due" | "soon" | "upcoming";

export type CourseDue = {
  courseId: string;
  name: string;
  dosage: string;
  occurrence: Occurrence;
  /** Household days until the occurrence's day (negative when overdue). */
  days: number;
  /** The occurrence's time has come (or its day, when due all day). */
  reached: boolean;
  state: OccurrenceState;
  label: string;
};

/* ------------------------------------------------------------------------ */
/* Reading stored values                                                    */
/* ------------------------------------------------------------------------ */

export const isDoseTime = (value: unknown): value is string =>
  typeof value === "string" && TIME_PATTERN.test(value);

/**
 * A real `yyyy-MM-dd` calendar day (rejects Feb 30).
 * @param {unknown} value Candidate.
 * @return {boolean} True for a valid day.
 */
export const isCalendarDay = (value: unknown): value is string =>
  isDayString(value) &&
  new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;

const isWhole = (value: unknown, min: number, max: number): boolean =>
  typeof value === "number" && Number.isInteger(value) &&
  value >= min && value <= max;

/**
 * A stored or entered schedule, validated and normalized (times sorted and
 * unique), or null when it is not a valid schedule.
 * @param {unknown} value Candidate.
 * @return {CourseSchedule | null} The schedule.
 */
export const readSchedule = (value: unknown): CourseSchedule | null => {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (raw.kind === "days") {
    if (!isWhole(raw.everyDays, 1, MAX_EVERY_DAYS)) return null;
    if (!Array.isArray(raw.times) || raw.times.length > MAX_DOSE_TIMES ||
        !raw.times.every(isDoseTime)) return null;
    const times = [...new Set(raw.times as string[])].sort();
    return {kind: "days", everyDays: raw.everyDays as number, times};
  }
  if (raw.kind === "hours") {
    if (!isWhole(raw.everyHours, MIN_EVERY_HOURS, MAX_EVERY_HOURS) ||
        !isDoseTime(raw.firstTime)) return null;
    return {
      kind: "hours", everyHours: raw.everyHours as number,
      firstTime: raw.firstTime as string,
    };
  }
  return null;
};

/**
 * Milliseconds of a Firestore Timestamp, Date, ISO string or number.
 * @param {unknown} value Stored value.
 * @return {number | null} Milliseconds, or null when unreadable.
 */
export const toMillis = (value: unknown): number | null => {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.getTime();
  }
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const time = new Date(value).getTime();
    return Number.isNaN(time) ? null : time;
  }
  if (value && typeof value === "object" &&
      typeof (value as {toDate?: unknown}).toDate === "function") {
    return toMillis((value as {toDate: () => Date}).toDate());
  }
  return null;
};

const text = (value: unknown, max: number): string =>
  typeof value === "string" ? value.trim().slice(0, max) : "";

/**
 * A stored dose pointer (`lastDose` / `prevDose`), or null.
 * @param {unknown} value Stored value.
 * @return {DosePointer | null} The pointer.
 */
export const readDosePointer = (value: unknown): DosePointer | null => {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const occurrenceAt = toMillis(raw.occurrenceAt);
  if (typeof raw.logId !== "string" || !raw.logId ||
      typeof raw.occurrence !== "string" || occurrenceAt === null) {
    return null;
  }
  return {
    logId: raw.logId,
    occurrence: raw.occurrence,
    occurrenceAt,
    givenAt: toMillis(raw.givenAt),
    byUid: typeof raw.byUid === "string" ? raw.byUid : null,
    byName: typeof raw.byName === "string" ? raw.byName : null,
  };
};

/**
 * The trimmed, lower-cased name that grouped legacy medication entries (the
 * pre-course identity; D-P8 keeps it for legacy logs only).
 * @param {unknown} name Medication name.
 * @return {string} The key ("" when there is no name).
 */
export const legacyMedicationKey = (name: unknown): string =>
  typeof name === "string" ? name.trim().toLowerCase() : "";

/**
 * A stored course document as a view, or null when it is not a course.
 * @param {string} id Document id.
 * @param {Record<string, unknown>} data Document data.
 * @return {CourseView | null} The course.
 */
export const readCourse = (
  id: string, data: Record<string, unknown> | undefined | null,
): CourseView | null => {
  if (!data || !id) return null;
  const name = text(data.name, COURSE_NAME_MAX);
  const startDay = isCalendarDay(data.startDay) ? data.startDay : null;
  if (!name || !startDay) return null;
  const status = data.status === "finished" ? "finished" : "active";
  const schedule = readSchedule(data.schedule);
  // An active course always has a schedule; anything else is not usable.
  if (status === "active" && !schedule) return null;
  const legacyKeys = Array.isArray(data.legacyKeys) ?
    data.legacyKeys.map(legacyMedicationKey).filter(Boolean) : [];
  return {
    id,
    name,
    dosage: text(data.dosage, COURSE_DOSAGE_MAX),
    schedule,
    startDay,
    endDay: isCalendarDay(data.endDay) && data.endDay >= startDay ?
      data.endDay : null,
    status,
    lastDose: readDosePointer(data.lastDose),
    coveredUntil: toMillis(data.coveredUntil),
    prevDose: readDosePointer(data.prevDose),
    legacyKeys: [...new Set(legacyKeys)],
  };
};

/* ------------------------------------------------------------------------ */
/* Household wall time                                                      */
/* ------------------------------------------------------------------------ */

const toMinutes = (time: string): number =>
  Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));

const pad = (value: number): string => String(value).padStart(2, "0");

const wallTime = (instant: number, timeZone: string): string => {
  const minutes = localMinutes(new Date(instant), timeZone);
  return `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
};

// Offset of the zone at an instant: its wall time read as UTC, minus it.
const offsetAt = (instant: number, timeZone: string): number => {
  const minute = Math.floor(instant / 60000) * 60000;
  const day = localDay(new Date(minute), timeZone);
  const minutes = localMinutes(new Date(minute), timeZone);
  return Date.parse(`${day}T00:00:00Z`) + minutes * 60000 - minute;
};

/**
 * The instant of a household wall time. A time that happens twice (the
 * fall-back hour) is the first one; a time that does not exist (the
 * spring-forward gap) moves forward by the gap, so every day keeps every
 * dose. Client and server use this one function.
 * @param {string} day Household day.
 * @param {number} minutes Minutes after midnight.
 * @param {string} timeZone IANA zone.
 * @return {number} Milliseconds.
 */
export const zonedInstant = (
  day: string, minutes: number, timeZone: string,
): number => {
  const guess = Date.parse(`${day}T00:00:00Z`) + minutes * 60000;
  const candidates = [
    guess - offsetAt(guess - 12 * HOUR_MS, timeZone),
    guess - offsetAt(guess + 12 * HOUR_MS, timeZone),
  ];
  const wanted = `${day} ${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
  const valid = candidates.filter((at) =>
    `${localDay(new Date(at), timeZone)} ${wallTime(at, timeZone)}` ===
      wanted);
  return valid.length > 0 ? Math.min(...valid) : Math.max(...candidates);
};

/* ------------------------------------------------------------------------ */
/* Occurrences                                                              */
/* ------------------------------------------------------------------------ */

export type CourseWindow = {
  schedule: CourseSchedule;
  startDay: string;
  endDay: string | null;
};

/** Safety bound on an enumeration that is not bounded by a time range. */
const MAX_STEPS = 2000;

/**
 * Walks the schedule's occurrences after `after` (from the start when null)
 * in time order, never past the end day, until `more` says stop. Every
 * enumeration goes through here; the callers bound it by a count from a
 * recent point (`occurrencesAfter`) or by an explicit time range
 * (`occurrencesBetween`), never by "the first N after some old point".
 * @param {CourseWindow} course Schedule, start and end day.
 * @param {number | null} after Exclusive lower bound (ms).
 * @param {string} zone Household zone.
 * @param {Function} more Called with each occurrence; false stops.
 * @param {number} maxSteps Bound on the walk.
 */
const walkOccurrences = (
  course: CourseWindow, after: number | null, zone: string,
  more: (occurrence: Occurrence) => boolean, maxSteps: number,
): void => {
  const timeZone = safeTimeZone(zone);
  const {schedule, startDay, endDay} = course;
  if (schedule.kind === "days") {
    const step = schedule.everyDays;
    // Start one step before the day of `after`, aligned to the cycle.
    let day = startDay;
    if (after !== null) {
      const behind = diffDays(
        addDays(localDay(new Date(after), timeZone), -1), startDay);
      if (behind > 0) day = addDays(startDay, Math.floor(behind / step) * step);
    }
    for (let steps = 0; steps < maxSteps; steps++) {
      if (endDay && day > endDay) return;
      const slots = schedule.times.length > 0 ? schedule.times : [null];
      for (const time of slots) {
        const at = zonedInstant(day, time ? toMinutes(time) : 0, timeZone);
        if (after !== null && at <= after) continue;
        if (!more({key: time ? `${day}T${time}` : day, day, time, at})) return;
      }
      day = addDays(day, step);
    }
    return;
  }
  const stepMs = schedule.everyHours * HOUR_MS;
  const anchor = zonedInstant(startDay, toMinutes(schedule.firstTime),
    timeZone);
  let index = after === null || after < anchor ? 0 :
    Math.floor((after - anchor) / stepMs);
  for (let steps = 0; steps < maxSteps; steps++, index++) {
    const at = anchor + index * stepMs;
    if (after !== null && at <= after) continue;
    const day = localDay(new Date(at), timeZone);
    if (endDay && day > endDay) return;
    if (!more({key: `${day}T${wallTime(at, timeZone)}`, day,
      time: wallTime(at, timeZone), at})) return;
  }
};

/**
 * The first `limit` scheduled occurrences after an instant (all from the
 * start when `after` is null), in time order, never past the end day. Use it
 * only from a recent point (the latest dose, now); a range is
 * `occurrencesBetween`.
 * @param {CourseWindow} course Schedule, start and end day.
 * @param {number | null} after Exclusive lower bound (ms).
 * @param {string} zone Household zone.
 * @param {number} limit Maximum count.
 * @return {Occurrence[]} Occurrences.
 */
export const occurrencesAfter = (
  course: CourseWindow, after: number | null, zone: string, limit: number,
): Occurrence[] => {
  const out: Occurrence[] = [];
  if (limit <= 0) return out;
  walkOccurrences(course, after, zone, (occurrence) => {
    out.push(occurrence);
    return out.length < limit;
  }, MAX_STEPS);
  return out;
};

/**
 * Every scheduled occurrence in `(from, to]`, in time order: bounded by the
 * range alone (no count cap), so nothing inside it is ever dropped, however
 * dense the schedule or however old an outstanding dose.
 * @param {CourseWindow} course Schedule, start and end day.
 * @param {number} from Exclusive lower bound (ms).
 * @param {number} to Inclusive upper bound (ms).
 * @param {string} zone Household zone.
 * @return {Occurrence[]} Occurrences.
 */
export const occurrencesBetween = (
  course: CourseWindow, from: number, to: number, zone: string,
): Occurrence[] => {
  const out: Occurrence[] = [];
  if (to <= from) return out;
  // Enough steps for the range: one per day (days kind) or per interval.
  const span = to - from;
  const steps = course.schedule.kind === "days" ?
    Math.ceil(span / (24 * HOUR_MS)) + 3 :
    Math.ceil(span / (course.schedule.everyHours * HOUR_MS)) + 3;
  walkOccurrences(course, from, zone, (occurrence) => {
    if (occurrence.at > to) return false;
    out.push(occurrence);
    return true;
  }, steps);
  return out;
};

/**
 * The scheduled occurrence at or before an instant (the latest one), or null.
 * @param {CourseWindow} course Schedule, start and end day.
 * @param {number} at Instant (ms).
 * @param {string} zone Household zone.
 * @return {Occurrence | null} The occurrence.
 */
export const occurrenceAtOrBefore = (
  course: CourseWindow, at: number, zone: string,
): Occurrence | null => {
  // Never past the end day (a course that ended: its last occurrence), and
  // back far enough to cover one full cycle of either kind.
  const end = course.endDay ?
    zonedInstant(addDays(course.endDay, 1), 0, safeTimeZone(zone)) - 1 : at;
  const upTo = Math.min(at, end);
  const span = course.schedule.kind === "days" ?
    (course.schedule.everyDays + 2) * 24 * HOUR_MS :
    (course.schedule.everyHours + 2) * HOUR_MS;
  const list = occurrencesBetween(course, upTo - span, upTo, zone);
  return list.length > 0 ? list[list.length - 1] : null;
};

/**
 * The most recent occurrences after `after` and at or before `at`, newest
 * last, at most `count`: found by walking back from `at`, so it costs the
 * same whether the last covered dose was yesterday or a year ago.
 * @param {CourseWindow} course Schedule, start and end day.
 * @param {number | null} after Exclusive lower bound (ms), null for none.
 * @param {number} at Inclusive upper bound (ms), usually now.
 * @param {string} zone Household zone.
 * @param {number} count Maximum count.
 * @return {Occurrence[]} Occurrences, oldest first.
 */
export const latestOccurrencesUpTo = (
  course: CourseWindow, after: number | null, at: number, zone: string,
  count: number,
): Occurrence[] => {
  const out: Occurrence[] = [];
  let cursor = at;
  while (out.length < count) {
    const occurrence = occurrenceAtOrBefore(course, cursor, zone);
    if (!occurrence || (after !== null && occurrence.at <= after)) break;
    out.unshift(occurrence);
    cursor = occurrence.at - 1;
  }
  return out;
};

/**
 * The scheduled occurrence with this key, or null when the schedule has none
 * (for example after a schedule edit).
 * @param {CourseWindow} course Schedule, start and end day.
 * @param {string} key Occurrence key.
 * @param {string} zone Household zone.
 * @return {Occurrence | null} The occurrence.
 */
export const occurrenceByKey = (
  course: CourseWindow, key: string, zone: string,
): Occurrence | null => {
  const day = key.slice(0, 10);
  if (!isCalendarDay(day)) return null;
  const timeZone = safeTimeZone(zone);
  // From two days before the key's day (an hours schedule's wall time moves).
  const from = zonedInstant(addDays(day, -2), 0, timeZone);
  return occurrencesAfter(course, from, timeZone, 200)
    .find((occurrence) => occurrence.key === key) ?? null;
};

/**
 * The course's next due occurrence: the first scheduled one after the
 * occurrence its latest dose covered (from the start when it has none), or
 * null when the course is finished or has ended.
 * @param {CourseView} course The course.
 * @param {string} zone Household zone.
 * @return {Occurrence | null} The next due occurrence.
 */
export const nextDueOccurrence = (
  course: CourseView, zone: string,
): Occurrence | null => {
  if (course.status !== "active" || !course.schedule) return null;
  return occurrencesAfter({
    schedule: course.schedule, startDay: course.startDay,
    endDay: course.endDay,
  }, coveredThrough(course), zone, 1)[0] ?? null;
};

/**
 * The instant through which a course's occurrences count as given: its latest
 * dose's occurrence, or a schedule edit's `coveredUntil` when later.
 * @param {CourseView} course The course.
 * @return {number | null} Milliseconds, or null when nothing is covered.
 */
export const coveredThrough = (
  course: Pick<CourseView, "lastDose" | "coveredUntil" | "offlineDose">,
): number | null => {
  const values = [
    course.lastDose?.occurrenceAt, course.coveredUntil,
    course.offlineDose?.occurrenceAt,
  ].filter((value): value is number => typeof value === "number");
  return values.length > 0 ? Math.max(...values) : null;
};

export type DoseLogInput = {
  id?: string;
  courseId?: unknown;
  occurrence?: unknown;
  occurrenceAt?: unknown;
  date?: unknown;
  repeat?: unknown;
  loggedByUid?: unknown;
  loggedByName?: unknown;
};

/**
 * A course's surviving dose records, as pointers (logs of other courses, or
 * without an occurrence, are ignored; `excludeId` is a dose being removed).
 * @param {string} courseId Course id.
 * @param {DoseLogInput[]} logs Medication logs.
 * @param {string} excludeId A log to leave out.
 * @return {DosePointer[]} Dose records.
 */
export const doseRecordsOf = (
  courseId: string, logs: DoseLogInput[], excludeId?: string,
): DosePointer[] => {
  const byId = new Map<string, DosePointer>();
  for (const log of logs) {
    if (log.courseId !== courseId || typeof log.id !== "string" ||
        log.id === excludeId || typeof log.occurrence !== "string") continue;
    const occurrenceAt = toMillis(log.occurrenceAt);
    if (occurrenceAt === null) continue;
    byId.set(log.id, {
      logId: log.id, occurrence: log.occurrence, occurrenceAt,
      givenAt: toMillis(log.date),
      byUid: typeof log.loggedByUid === "string" ? log.loggedByUid : null,
      byName: typeof log.loggedByName === "string" ? log.loggedByName : null,
    });
  }
  return [...byId.values()];
};

export type CourseState = {
  /** The latest surviving dose (latest occurrence, latest given, id). */
  latest: DosePointer | null;
  /** The surviving dose before it, in the same order. */
  prev: DosePointer | null;
  /** Occurrences up to here count as given (`latest`, `coveredUntil`). */
  coveredThrough: number | null;
};

const doseOrder = (a: DosePointer, b: DosePointer): number =>
  b.occurrenceAt - a.occurrenceAt || (b.givenAt ?? 0) - (a.givenAt ?? 0) ||
  a.logId.localeCompare(b.logId);

/**
 * The one course state (mirrors the feeding state's `deriveFeedingState`):
 * the latest dose, the one before it and the coverage, derived from the
 * course's surviving dose records, offline-synced doses included. The stored
 * `lastDose` / `prevDose` are a cache of `latest` / `prev` that every online
 * write (give, Undo, delete) stores from the records it read plus its own
 * change; readers combine the cache with the offline doses they have
 * (`withOfflineDoses`), which is the same derivation. Previews, transactions,
 * Undo and readers all use this function.
 * @param {CourseView} course The course (its `coveredUntil`).
 * @param {DosePointer[]} records Surviving dose records.
 * @return {CourseState} The state.
 */
export const deriveCourseState = (
  course: Pick<CourseView, "coveredUntil">, records: DosePointer[],
): CourseState => {
  const byId = new Map<string, DosePointer>();
  for (const record of records) byId.set(record.logId, record);
  const ordered = [...byId.values()].sort(doseOrder);
  const latest = ordered[0] ?? null;
  const covered = [latest?.occurrenceAt, course.coveredUntil]
    .filter((value): value is number => typeof value === "number");
  return {
    latest,
    prev: ordered[1] ?? null,
    coveredThrough: covered.length > 0 ? Math.max(...covered) : null,
  };
};

/**
 * The course as a reader sees it: its stored latest dose (the cache of every
 * online write) combined with the dose records this reader has (offline
 * doses, or the whole history), through `deriveCourseState`. When a record is
 * later than the cache (a dose queued offline never moves `lastDose`) it is
 * `offlineDose`.
 * @param {CourseView} course The course.
 * @param {DoseLogInput[]} logs Medication logs (other courses are ignored).
 * @return {CourseView} The course, with `offlineDose` when one is newer.
 */
export const withOfflineDoses = (
  course: CourseView, logs: DoseLogInput[],
): CourseView => withRecords(course, doseRecordsOf(course.id, logs));

/**
 * The course with the latest of its stored pointer and these dose records
 * (`deriveCourseState`): a record later than the pointer becomes
 * `offlineDose`, so coverage, the next dose and the repeat check all follow
 * the derived state. Any surviving record counts (an offline one, or the
 * full history a server or calendar reader has).
 * @param {CourseView} course The course.
 * @param {DosePointer[]} records Surviving dose records of the course.
 * @return {CourseView} The course.
 */
export const withRecords = (
  course: CourseView, records: DosePointer[],
): CourseView => {
  const {latest} = deriveCourseState(course, [
    ...(course.lastDose ? [course.lastDose] : []),
    ...(course.offlineDose ? [course.offlineDose] : []),
    ...records,
  ]);
  if (!latest || latest.logId === course.lastDose?.logId) return course;
  return {...course, offlineDose: latest};
};

/**
 * The interval between doses (an average for set times): ms.
 * @param {CourseSchedule} schedule The schedule.
 * @return {number} Milliseconds.
 */
export const periodMs = (schedule: CourseSchedule): number =>
  schedule.kind === "hours" ? schedule.everyHours * HOUR_MS :
    schedule.everyDays * 24 * HOUR_MS / Math.max(1, schedule.times.length);

/**
 * `coveredUntil` for a schedule edit: when the new schedule's first
 * occurrence after what was given is nearer to the given one than the
 * previous new occurrence, and within half a dose interval, it replaces the
 * given one (8:00 AM given, moved to 9:00 AM: 9:00 AM is covered). Otherwise
 * null (the latest dose alone decides). The edit form shows the resulting
 * next dose before it is saved.
 * @param {CourseView} course The course before the edit.
 * @param {CourseWindow} next The new schedule, start and end day.
 * @param {string} zone Household zone.
 * @return {number | null} Milliseconds, or null.
 */
export const coverageAfterEdit = (
  course: Pick<CourseView, "lastDose" | "coveredUntil" | "offlineDose">,
  next: CourseWindow,
  zone: string,
): number | null => {
  const covered = coveredThrough(course);
  if (covered === null) return null;
  const after = occurrencesAfter(next, covered, zone, 1)[0];
  if (!after) return null;
  const before = occurrenceAtOrBefore(next, covered, zone);
  const gap = after.at - covered;
  if (gap > periodMs(next.schedule) / 2) return null;
  if (before && covered - before.at <= gap) return null;
  return after.at;
};

/* ------------------------------------------------------------------------ */
/* State and copy                                                           */
/* ------------------------------------------------------------------------ */

/**
 * "8:00 AM" for `08:00` (fixed English, so client and server agree).
 * @param {string} time `HH:mm`.
 * @return {string} 12-hour time.
 */
export const formatDoseTime = (time: string): string => {
  const minutes = toMinutes(time);
  const hours = Math.floor(minutes / 60);
  const h12 = hours % 12 === 0 ? 12 : hours % 12;
  return `${h12}:${pad(minutes % 60)} ${hours < 12 ? "AM" : "PM"}`;
};

/**
 * The day-count label the legacy countdown has always used.
 * @param {number} days Household days until due.
 * @return {string} Label.
 */
export const dayLabel = (days: number): string => {
  if (days === -1) return "Overdue by 1 day";
  if (days < 0) return `Overdue by ${-days} days`;
  if (days === 0) return "Due today";
  if (days === 1) return "Due tomorrow";
  return `Due in ${days} days`;
};

/**
 * State and label of an occurrence at `now`: overdue once its household day
 * has passed, due on its day ("Due 8:00 PM", "Due since 8:00 AM"), soon
 * within three days, otherwise upcoming.
 * @param {Occurrence} occurrence The occurrence.
 * @param {Date} now Current instant.
 * @param {string} zone Household zone.
 * @return {object} Days, reached, state and label.
 */
export const occurrenceStatus = (
  occurrence: Occurrence, now: Date, zone: string,
): Pick<CourseDue, "days" | "reached" | "state" | "label"> => {
  const today = localDay(now, safeTimeZone(zone));
  const days = diffDays(occurrence.day, today);
  const reached = occurrence.at <= now.getTime();
  const state: OccurrenceState = days < 0 ? "overdue" : days === 0 ? "due" :
    days <= 3 ? "soon" : "upcoming";
  if (!occurrence.time || days < 0 || days > 1) {
    return {days, reached, state, label: dayLabel(days)};
  }
  const time = formatDoseTime(occurrence.time);
  const label = days === 1 ? `Due tomorrow ${time}` :
    reached ? `Due since ${time}` : `Due ${time}`;
  return {days, reached, state, label};
};

/**
 * A course's next dose with its state, or null when nothing is due (finished
 * or ended).
 * @param {CourseView} course The course.
 * @param {Date} now Current instant.
 * @param {string} zone Household zone.
 * @return {CourseDue | null} The due dose.
 */
export const courseDue = (
  course: CourseView, now: Date, zone: string,
): CourseDue | null => {
  const occurrence = nextDueOccurrence(course, zone);
  if (!occurrence) return null;
  return {
    courseId: course.id, name: course.name, dosage: course.dosage,
    occurrence, ...occurrenceStatus(occurrence, now, zone),
  };
};

/**
 * Plain description of a schedule ("Every day at 8:00 AM and 8:00 PM",
 * "Every 12 hours from 8:00 AM", "Every 30 days").
 * @param {CourseSchedule} schedule The schedule.
 * @return {string} Description.
 */
export const scheduleSummary = (schedule: CourseSchedule): string => {
  if (schedule.kind === "hours") {
    return `Every ${schedule.everyHours} hours from ` +
      formatDoseTime(schedule.firstTime);
  }
  const every = schedule.everyDays === 1 ? "Every day" :
    schedule.everyDays === 7 ? "Every week" :
      `Every ${schedule.everyDays} days`;
  if (schedule.times.length === 0) return every;
  const times = schedule.times.map(formatDoseTime);
  const list = times.length === 1 ? times[0] :
    `${times.slice(0, -1).join(", ")} and ${times[times.length - 1]}`;
  return `${every} at ${list}`;
};

/* ------------------------------------------------------------------------ */
/* Legacy medication (D-P8)                                                 */
/* ------------------------------------------------------------------------ */

export type LegacyLogInput = {
  id?: string;
  date?: unknown;
  medication?: unknown;
  dosage?: unknown;
  nextDueDate?: unknown;
  courseId?: unknown;
  oneOff?: unknown;
};

/**
 * A log written under the legacy (name-keyed) model: no course and not a
 * one-off dose.
 * @param {LegacyLogInput} log Log data.
 * @return {boolean} True for a legacy entry.
 */
export const isLegacyLog = (log: LegacyLogInput): boolean =>
  !(typeof log.courseId === "string" && log.courseId) && log.oneOff !== true;

/**
 * Legacy names taken over by a course (confirmed, merged or finished): their
 * logs stay as history and no longer drive a legacy countdown.
 * @param {CourseView[]} courses The pet's courses.
 * @return {Set<string>} Taken keys.
 */
export const takenLegacyKeys = (courses: CourseView[]): Set<string> =>
  new Set(courses.flatMap((course) => course.legacyKeys));

export type LegacyReason = "consistent" | "conflicting" | "no-interval";

export type LegacyGroup = {
  key: string;
  /** Name, dosage and next due day from the latest entry. */
  name: string;
  dosage: string;
  dueDay: string;
  entries: number;
  /** Prefilled suggestion, only when every recorded interval agrees. */
  suggestion: CourseSchedule | null;
  reason: LegacyReason;
};

/**
 * Legacy medications that still drive a countdown (their latest entry has a
 * next due date) and so need a member to confirm a schedule or finish them
 * (D-P8). History is consistent when every entry with a next due date gave
 * the same gap in days from its own household day: then that gap is shown as
 * a suggestion. Conflicting gaps, or none usable, give no suggestion.
 * @param {LegacyLogInput[]} logs Every medication entry of one pet.
 * @param {Set<string>} taken Keys already taken over by a course.
 * @param {string} zone Household zone.
 * @return {LegacyGroup[]} Pending legacy groups, by name.
 */
export const pendingLegacyGroups = (
  logs: LegacyLogInput[], taken: Set<string>, zone: string,
): LegacyGroup[] => {
  const timeZone = safeTimeZone(zone);
  const groups = new Map<string, {at: number; log: LegacyLogInput}[]>();
  for (const log of logs) {
    if (!isLegacyLog(log)) continue;
    const key = legacyMedicationKey(log.medication);
    const at = toMillis(log.date);
    if (!key || at === null || taken.has(key)) continue;
    const list = groups.get(key) ?? [];
    list.push({at, log});
    groups.set(key, list);
  }
  const pending: LegacyGroup[] = [];
  for (const [key, list] of groups) {
    list.sort((a, b) => a.at - b.at);
    const latest = list[list.length - 1].log;
    if (!isCalendarDay(latest.nextDueDate)) continue;
    const gaps = new Set<number>();
    let usable = true;
    for (const {at, log} of list) {
      if (!isCalendarDay(log.nextDueDate)) continue;
      const gap = diffDays(log.nextDueDate, localDay(new Date(at), timeZone));
      if (gap < 1 || gap > MAX_EVERY_DAYS) usable = false;
      else gaps.add(gap);
    }
    const reason: LegacyReason = !usable || gaps.size === 0 ?
      "no-interval" : gaps.size > 1 ? "conflicting" : "consistent";
    pending.push({
      key,
      name: text(latest.medication, COURSE_NAME_MAX),
      dosage: text(latest.dosage, COURSE_DOSAGE_MAX),
      dueDay: latest.nextDueDate,
      entries: list.length,
      suggestion: reason === "consistent" ?
        {kind: "days", everyDays: [...gaps][0], times: []} : null,
      reason,
    });
  }
  return pending.sort((a, b) => a.key.localeCompare(b.key));
};

const fnv = (value: string): string => {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
};

/**
 * The course id a legacy medication is confirmed (or finished) under: one id
 * per legacy key, so two members confirming the same one at once write one
 * course (the second finds it).
 * @param {string} key Legacy key.
 * @return {string} Course id.
 */
export const legacyCourseId = (key: string): string => {
  const slug = key.toLowerCase().replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "").slice(0, 40);
  return `legacy-${slug || "medication"}-${fnv(key)}`;
};
