/**
 * The medication-course invariant, as a model test (hydra rule, Codex round 1
 * C and D; the feeding state's pets-feeding-invariant.test.ts is the model):
 * over random sequences of on-time, early, late and backdated doses, offline
 * doses, confirmed duplicates, Undo online and offline, schedule edits and
 * Finish / resume, with the clock moving on,
 * - after every online write the stored pointer (`lastDose` / `prevDose`)
 *   equals the course state derived from the surviving dose records
 *   (`deriveCourseState`), offline doses included;
 * - after every step a reader (the stored pointer combined with the offline
 *   doses it has, `withOfflineDoses`) sees the derived coverage;
 * - nothing that has a surviving record is ever due again;
 * - every pointer write and every dose is one the rules accept (mirrored here
 *   as `pointerWriteAllowed` / `doseCreateAllowed` of firestore.rules'
 *   coursePointerWritten and courseDoseCreate; the emulator suites check the
 *   real rules on the same cases).
 * The planners are the ones the transactions run (`planDose`, `pointerAfter`,
 * `coverageAfterEdit` over `withRecords`).
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  coverageAfterEdit,
  coveredThrough,
  deriveCourseState,
  doseChoices,
  doseConfirmOf,
  doseRecordsOf,
  nextDueOccurrence,
  occurrencesAfter,
  planDose,
  pointerAfter,
  readCourse,
  withOfflineDoses,
  withRecords,
  zonedInstant,
  type CourseSchedule,
  type CourseView,
  type DosePointer,
} from '../../src/lib/pets/medication-course';

const TZ = 'America/Chicago';
const MIN = 60_000;
const HOUR = 60 * MIN;

type Log = { id: string; courseId: string; occurrence: string; occurrenceAt: number; date: number; repeat: 'none' | 'confirmed' | 'offline'; loggedByUid: string; loggedByName: string };
type Course = { schedule: CourseSchedule; startDay: string; endDay: null; status: 'active' | 'finished'; lastDose: DosePointer | null; prevDose: DosePointer | null; coveredUntil: number | null };

function random(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

const view = (course: Course): CourseView => readCourse('c1', {
  name: 'Apoquel', dosage: '1 tablet', schedule: course.schedule, startDay: course.startDay, status: course.status,
  lastDose: course.lastDose && { ...course.lastDose, occurrenceAt: new Date(course.lastDose.occurrenceAt), givenAt: course.lastDose.givenAt === null ? null : new Date(course.lastDose.givenAt) },
  prevDose: course.prevDose && { ...course.prevDose, occurrenceAt: new Date(course.prevDose.occurrenceAt), givenAt: course.prevDose.givenAt === null ? null : new Date(course.prevDose.givenAt) },
  ...(course.coveredUntil === null ? {} : { coveredUntil: new Date(course.coveredUntil) }),
})!;
const records = (logs: Map<string, Log>) => doseRecordsOf('c1', [...logs.values()]);

/** firestore.rules coursePointerWritten: real doses of the course, never back while the old latest survives. */
function pointerWriteAllowed(before: Course, after: { latest: DosePointer | null; prev: DosePointer | null }, logsAfter: Map<string, Log>): boolean {
  const real = (pointer: DosePointer | null) => pointer === null || (() => {
    const log = logsAfter.get(pointer.logId);
    return Boolean(log) && log!.occurrence === pointer.occurrence && log!.occurrenceAt === pointer.occurrenceAt && log!.date === pointer.givenAt && log!.loggedByUid === pointer.byUid;
  })();
  const lastBefore = before.lastDose;
  const monotonic = lastBefore === null || !logsAfter.has(lastBefore.logId) || (after.latest !== null && after.latest.occurrenceAt >= lastBefore.occurrenceAt);
  return real(after.latest) && real(after.prev) && monotonic;
}

/** firestore.rules courseDoseCreate (online): a covered occurrence is confirmed against the stored latest; the pointer covers a new latest. */
function doseCreateAllowed(before: Course, logsBefore: Map<string, Log>, log: Log, confirmOf: string | null, pointerAfterWrite: DosePointer | null): boolean {
  const last = before.lastDose && logsBefore.has(before.lastDose.logId) ? before.lastDose : null;
  if (last && last.occurrenceAt >= log.occurrenceAt && !(log.repeat === 'confirmed' && confirmOf === last.logId)) return false;
  if (last && log.occurrenceAt < last.occurrenceAt) return true;
  return pointerAfterWrite !== null && pointerAfterWrite.occurrenceAt >= log.occurrenceAt;
}

const SCHEDULES: CourseSchedule[] = [
  { kind: 'days', everyDays: 1, times: ['08:00', '20:00'] },
  { kind: 'days', everyDays: 1, times: ['08:00', '12:00', '18:00'] },
  { kind: 'hours', everyHours: 4, firstTime: '06:00' },
  { kind: 'days', everyDays: 2, times: [] },
];

function run(seed: number, steps: number) {
  const rand = random(seed);
  const pick = <T,>(list: T[]) => list[Math.floor(rand() * list.length)];
  const logs = new Map<string, Log>();
  // Offline doses this device still has queued or loaded (a reader's offline listener sees them all).
  let course: Course = { schedule: pick(SCHEDULES), startDay: '2026-10-28', endDay: null, status: 'active', lastDose: null, prevDose: null, coveredUntil: null };
  // Spans the fall-back day (Nov 1) on purpose.
  let now = zonedInstant('2026-10-30', 7 * 60, TZ);
  let next = 0;
  const id = () => `log-${String(next++).padStart(4, '0')}`;
  const users = ['sam', 'kim'];

  const check = (label: string, onlineWrite: boolean) => {
    const derived = deriveCourseState(view(course), records(logs));
    if (onlineWrite) {
      assert.equal(course.lastDose?.logId ?? null, derived.latest?.logId ?? null, `${label}: stored latest = derived`);
      assert.equal(course.prevDose?.logId ?? null, derived.prev?.logId ?? null, `${label}: stored prev = derived`);
    }
    const offline = [...logs.values()].filter((log) => log.repeat === 'offline');
    const reader = withOfflineDoses(view(course), offline);
    assert.equal(coveredThrough(reader), derived.coveredThrough, `${label}: a reader sees the derived coverage`);
    if (course.status === 'active') {
      const due = nextDueOccurrence(reader, TZ);
      const newest = Math.max(-Infinity, ...[...logs.values()].map((log) => log.occurrenceAt));
      if (due) assert.ok(due.at > newest, `${label}: nothing with a surviving record is due again`);
    }
  };

  for (let step = 0; step < steps; step++) {
    now += Math.floor(rand() * 5 * HOUR);
    const roll = rand();
    const user = pick(users);
    const label = `seed ${seed} step ${step}`;
    if (course.status === 'finished') {
      // Resume (Undo of Finish) or stay finished.
      if (rand() < 0.5) course = { ...course, status: 'active' };
      check(`${label} resume`, false);
      continue;
    }
    if (roll < 0.45 || roll >= 0.9) {
      // Give dose: online (prefilled, or another offered time), early, late or backdated; or offline.
      const offlineGive = roll >= 0.9;
      const reader = withOfflineDoses(view(course), [...logs.values()].filter((log) => log.repeat === 'offline'));
      const choices = doseChoices(reader, new Date(now), TZ);
      const chosen = rand() < 0.7 ? choices.prefill : pick(choices.choices);
      if (!chosen) continue;
      const givenAt = rand() < 0.25 ? new Date(now - Math.floor(rand() * 3 * HOUR)) : null;
      const snapshotCourse = offlineGive ? reader : withRecords(view(course), records(logs));
      const lastSurvives = Boolean(course.lastDose && logs.has(course.lastDose.logId));
      let plan = planDose({ now: new Date(now), timeZone: TZ, course: snapshotCourse, lastDoseSurvives: offlineGive ? Boolean(course.lastDose) : lastSurvives, existing: null, offline: offlineGive },
        { userUid: user, occurrenceKey: chosen.key, givenAt });
      if (plan.kind === 'needsConfirm') {
        if (rand() < 0.4) { check(`${label} declined`, false); continue; }
        plan = planDose({ now: new Date(now), timeZone: TZ, course: snapshotCourse, lastDoseSurvives: offlineGive ? Boolean(course.lastDose) : lastSurvives, existing: null, offline: offlineGive },
          { userUid: user, occurrenceKey: chosen.key, givenAt, confirm: doseConfirmOf(plan.check) });
      }
      assert.equal(plan.kind, 'write', `${label}: an answered question writes`);
      if (plan.kind !== 'write') continue;
      const log: Log = { id: id(), courseId: 'c1', occurrence: plan.occurrence.key, occurrenceAt: plan.occurrence.at, date: plan.givenAt.getTime(), repeat: plan.repeat, loggedByUid: user, loggedByName: user };
      const before = course;
      const logsBefore = new Map(logs);
      logs.set(log.id, log);
      if (offlineGive) {
        check(`${label} offline dose`, false);
        continue;
      }
      const pointer = pointerAfter(view(before), records(logs));
      assert.ok(doseCreateAllowed(before, logsBefore, log, plan.confirmOf, pointer.latest), `${label}: the rules accept the dose`);
      if (pointer.write) {
        assert.ok(pointerWriteAllowed(before, pointer, logs), `${label}: the rules accept the pointer`);
        course = { ...course, lastDose: pointer.latest, prevDose: pointer.prev };
      }
      check(`${label} dose (${plan.repeat})`, true);
    } else if (roll < 0.65) {
      // Undo / delete a dose, online (any) or offline (an offline dose the pointer does not name).
      const all = [...logs.values()];
      if (all.length === 0) continue;
      const target = pick(all);
      if (rand() < 0.3 && target.repeat === 'offline' && course.lastDose?.logId !== target.id) {
        logs.delete(target.id);
        check(`${label} offline undo`, false);
        continue;
      }
      const before = course;
      logs.delete(target.id);
      const pointer = pointerAfter(view(before), records(logs));
      if (pointer.write) {
        assert.ok(pointerWriteAllowed(before, pointer, logs), `${label}: the rules accept the pointer after Undo`);
        course = { ...course, lastDose: pointer.latest, prevDose: pointer.prev };
      }
      // The rules refuse removing the dose the pointer still names.
      assert.notEqual(course.lastDose?.logId, target.id);
      check(`${label} undo`, true);
    } else if (roll < 0.8) {
      // A schedule edit: coverage from the derived state (offline-synced doses included).
      const schedule = pick(SCHEDULES);
      const window = { schedule, startDay: course.startDay, endDay: null };
      const derivedView = withRecords(view(course), records(logs));
      course = { ...course, schedule, coveredUntil: coverageAfterEdit(derivedView, window, TZ) };
      check(`${label} edit`, false);
    } else {
      course = { ...course, status: 'finished' };
      check(`${label} finish`, false);
    }
  }
  return logs.size;
}

describe('the course pointer always agrees with the surviving dose records', () => {
  it('60 random sequences of 40 steps', () => {
    let written = 0;
    for (let seed = 1; seed <= 60; seed++) written += run(seed, 40);
    assert.ok(written > 250, 'the runs record plenty of doses');
  });

  it('a schedule edit counts an offline-synced dose (C): the saved coverage matches the preview', () => {
    const logs = new Map<string, Log>();
    const eight = zonedInstant('2026-11-14', 8 * 60, TZ);
    // The morning dose was recorded offline (it is not in the pointer).
    logs.set('off', { id: 'off', courseId: 'c1', occurrence: '2026-11-14T08:00', occurrenceAt: eight, date: eight, repeat: 'offline', loggedByUid: 'sam', loggedByName: 'Sam' });
    const course: Course = { schedule: { kind: 'days', everyDays: 1, times: ['08:00', '20:00'] }, startDay: '2026-11-13', endDay: null, status: 'active', lastDose: null, prevDose: null, coveredUntil: null };
    const moved = { schedule: { kind: 'days' as const, everyDays: 1, times: ['09:00', '21:00'] }, startDay: '2026-11-13', endDay: null };
    // The preview (a reader: the pointer with the offline doses) and the transaction (the records) agree.
    const preview = coverageAfterEdit(withOfflineDoses(view(course), [...logs.values()]), moved, TZ);
    const saved = coverageAfterEdit(withRecords(view(course), records(logs)), moved, TZ);
    assert.equal(saved, preview);
    assert.equal(saved, zonedInstant('2026-11-14', 9 * 60, TZ), '9:00 replaces the given 8:00');
    // Using the pointer alone (the old transaction) would have saved nothing: 9:00 due again.
    assert.equal(coverageAfterEdit(view(course), moved, TZ), null);
    const after = withOfflineDoses(view({ ...course, schedule: moved.schedule, coveredUntil: saved }), [...logs.values()]);
    assert.equal(nextDueOccurrence(after, TZ)?.key, '2026-11-14T21:00');
  });
});

// Keep the enumerator honest for the model's schedules (a sanity check of the model itself).
describe('model sanity', () => {
  it('each schedule has occurrences over the model window', () => {
    for (const schedule of SCHEDULES) {
      assert.ok(occurrencesAfter({ schedule, startDay: '2026-10-28', endDay: null }, null, TZ, 5).length === 5);
    }
  });
});
