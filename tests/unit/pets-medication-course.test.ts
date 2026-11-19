/**
 * Give dose, Undo and course edits on the client (src/lib/pets/medication-course.ts):
 * which occurrence a dose is for (missed, early, late), one press is one dose,
 * the "already given?" question bound to the dose it named, Undo never
 * overwriting a later dose, the legacy classification (D-P8), the course form,
 * the shared permission table (R5) and the client countdown agreeing with the
 * server reminders (PE-24h).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import {
  courseFormValues,
  doseChoices,
  doseConfirmOf,
  doseLinkDecision,
  doseLogId,
  doseRepeatReason,
  lastDoseLine,
  deriveCourseState,
  legacyCourseId,
  medicationAttention,
  medicationDues,
  newDoseOpId,
  occurrenceLabel,
  pendingLegacyGroups,
  planDose,
  pointerAfter,
  nextDueOccurrence,
  readCourse,
  schedulePreview,
  withOfflineDoses,
  validateCourseForm,
  DOSE_UNDO_COPY,
  type CourseView,
} from '../../src/lib/pets/medication-course';
import { MEDICATION_ACTION_PERMISSIONS, mayMedication } from '../../src/lib/pets/medication-permissions';
import { getRolePresetPermissions } from '../../src/lib/permissions';
import { buildMedicationReminders, pendingCycles } from '../../functions/src/shared/medication-reminders';
import { imageSourceFor } from '../../functions/src/shared/push-media';
import { currentMedications } from '../../src/lib/pets/care';
import { courseDueEvents, medicationDueEvents } from '../../src/lib/chores/calendar';

const CHI = 'America/Chicago';
const at = (value: string) => new Date(value);
const pointer = (occurrence: string, occurrenceAt: string, extra: Record<string, unknown> = {}) => ({
  logId: `log-${occurrence}`, occurrence, occurrenceAt: at(occurrenceAt), givenAt: at(occurrenceAt), byUid: 'sam', byName: 'Sam', ...extra,
});
const course = (data: Record<string, unknown> = {}): CourseView => readCourse('apoquel', {
  name: 'Apoquel', dosage: '1 tablet', schedule: { kind: 'days', everyDays: 1, times: ['08:00', '20:00'] },
  startDay: '2026-11-13', status: 'active', ...data,
})!;

describe('one press is one dose', () => {
  test('the log id is the press id; a malformed id is refused', () => {
    const opId = newDoseOpId();
    assert.equal(doseLogId(opId), opId);
    assert.throws(() => doseLogId('../x'), /invalid-dose-operation/);
  });

  test('a press that already wrote its log is reported as saved, nothing written; another author is a conflict', () => {
    const snapshot = { now: at('2026-11-14T14:05:00Z'), timeZone: CHI, course: course(), lastDoseSurvives: false };
    const intent = { userUid: 'sam', occurrenceKey: '2026-11-14T08:00', givenAt: null };
    assert.deepEqual(planDose({ ...snapshot, existing: { loggedByUid: 'sam', courseId: 'apoquel' } }, intent), { kind: 'already' });
    assert.deepEqual(planDose({ ...snapshot, existing: { loggedByUid: 'kim', courseId: 'apoquel' } }, intent), { kind: 'refused', reason: 'conflict' });
  });
});

describe('which occurrence a dose is for', () => {
  test('a missed dose: the latest passed one is prefilled; earlier missed ones stay missed', () => {
    // Nothing given since Nov 13 8:00 PM; it is Nov 14, 9 PM in Chicago.
    const c = course({ lastDose: pointer('2026-11-13T08:00', '2026-11-13T14:00:00Z') });
    const { prefill, choices } = doseChoices(c, at('2026-11-15T03:00:00Z'), CHI);
    assert.equal(prefill?.key, '2026-11-14T20:00');
    assert.equal(prefill?.covered, false);
    assert.deepEqual(choices.map(o => o.key), ['2026-11-13T20:00', '2026-11-14T08:00', '2026-11-14T20:00', '2026-11-15T08:00']);
  });

  test('just after a dose, the given occurrence is prefilled (so a repeat asks first)', () => {
    const c = course({ lastDose: pointer('2026-11-14T08:00', '2026-11-14T14:00:00Z') });
    const { prefill } = doseChoices(c, at('2026-11-14T14:10:00Z'), CHI);
    assert.equal(prefill?.key, '2026-11-14T08:00');
    assert.equal(prefill?.covered, true);
  });

  test('an early dose: nearer to the next time, that one is prefilled', () => {
    const c = course({ lastDose: pointer('2026-11-14T08:00', '2026-11-14T14:00:00Z') });
    const { prefill } = doseChoices(c, at('2026-11-15T01:00:00Z'), CHI); // 7 PM
    assert.equal(prefill?.key, '2026-11-14T20:00');
    assert.equal(prefill?.covered, false);
  });

  test('a finished course offers nothing', () => {
    assert.deepEqual(doseChoices(course({ status: 'finished' }), at('2026-11-14T14:00:00Z'), CHI), { prefill: null, choices: [] });
  });

  test('labels in the household day', () => {
    const now = at('2026-11-14T18:00:00Z');
    assert.equal(occurrenceLabel({ day: '2026-11-14', time: '20:00' }, now, CHI), 'Today 8:00 PM');
    assert.equal(occurrenceLabel({ day: '2026-11-15', time: '08:00' }, now, CHI), 'Tomorrow 8:00 AM');
    assert.equal(occurrenceLabel({ day: '2026-11-10', time: '08:00' }, now, CHI), 'Nov 10, 8:00 AM');
    assert.equal(occurrenceLabel({ day: '2026-11-13', time: null }, now, CHI), 'Yesterday');
  });
});

describe('planning a dose', () => {
  const now = at('2026-11-14T14:10:00Z');
  const base = { now, timeZone: CHI, existing: null };

  test('a first dose writes and becomes the latest; the next due follows the schedule', () => {
    const plan = planDose({ ...base, course: course(), lastDoseSurvives: false }, { userUid: 'sam', occurrenceKey: '2026-11-14T08:00', givenAt: null });
    assert.equal(plan.kind, 'write');
    if (plan.kind !== 'write') return;
    assert.equal(plan.live, true);
    assert.equal(plan.repeat, 'none');
    assert.equal(plan.becomesLatest, true);
    assert.equal(plan.nextAfter?.key, '2026-11-14T20:00');
  });

  test('the same occurrence again asks first, naming the dose; the answer for that dose writes once (confirmed)', () => {
    const c = course({ lastDose: pointer('2026-11-14T08:00', '2026-11-14T14:00:00Z') });
    const intent = { userUid: 'kim', occurrenceKey: '2026-11-14T08:00', givenAt: null };
    const asked = planDose({ ...base, course: c, lastDoseSurvives: true }, intent);
    assert.equal(asked.kind, 'needsConfirm');
    if (asked.kind !== 'needsConfirm') return;
    assert.equal(asked.staleConfirm, false);
    assert.equal(doseRepeatReason(asked.check, now, CHI, 'kim'), 'Sam recorded the Today 8:00 AM dose 10 min ago.');
    const written = planDose({ ...base, course: c, lastDoseSurvives: true }, { ...intent, confirm: doseConfirmOf(asked.check) });
    assert.equal(written.kind, 'write');
    if (written.kind === 'write') {
      assert.equal(written.repeat, 'confirmed');
      assert.equal(written.confirmOf, 'log-2026-11-14T08:00');
    }
  });

  test('a stale answer (another session gave since) asks again, naming the newer dose', () => {
    const c = course({ lastDose: pointer('2026-11-14T08:00', '2026-11-14T14:00:00Z', { logId: 'newer', byUid: 'kim', byName: 'Kim' }) });
    const plan = planDose({ ...base, course: c, lastDoseSurvives: true }, { userUid: 'sam', occurrenceKey: '2026-11-14T08:00', givenAt: null, confirm: { lastLogId: 'older' } });
    assert.equal(plan.kind, 'needsConfirm');
    if (plan.kind === 'needsConfirm') {
      assert.equal(plan.staleConfirm, true);
      assert.match(doseRepeatReason(plan.check, now, CHI, 'sam'), /^Kim recorded/);
    }
  });

  test('a removed latest dose does not ask (its record is gone)', () => {
    const c = course({ lastDose: pointer('2026-11-14T08:00', '2026-11-14T14:00:00Z') });
    const plan = planDose({ ...base, course: c, lastDoseSurvives: false }, { userUid: 'sam', occurrenceKey: '2026-11-14T08:00', givenAt: null });
    assert.equal(plan.kind, 'write');
  });

  test('backdated: an earlier given-at time is kept (never in the future, at most 7 days back); the schedule does not move', () => {
    const c = course();
    const intent = { userUid: 'sam', occurrenceKey: '2026-11-14T08:00' };
    const plan = planDose({ ...base, course: c, lastDoseSurvives: false }, { ...intent, givenAt: at('2026-11-14T13:00:00Z') });
    assert.equal(plan.kind, 'write');
    if (plan.kind === 'write') {
      assert.equal(plan.live, false);
      assert.equal(plan.givenAt.toISOString(), '2026-11-14T13:00:00.000Z');
      assert.equal(plan.nextAfter?.key, '2026-11-14T20:00');
    }
    assert.deepEqual(planDose({ ...base, course: c, lastDoseSurvives: false }, { ...intent, givenAt: at('2026-11-14T15:00:00Z') }), { kind: 'refused', reason: 'future' });
    assert.deepEqual(planDose({ ...base, course: c, lastDoseSurvives: false }, { ...intent, givenAt: at('2026-11-06T14:00:00Z') }), { kind: 'refused', reason: 'too-old' });
  });

  test('a late dose for an older occurrence (a later one already given) asks, and does not become the latest', () => {
    const c = course({ lastDose: pointer('2026-11-14T08:00', '2026-11-14T14:00:00Z') });
    const intent = { userUid: 'sam', occurrenceKey: '2026-11-13T20:00', givenAt: null };
    const asked = planDose({ ...base, course: c, lastDoseSurvives: true }, intent);
    assert.equal(asked.kind, 'needsConfirm');
    if (asked.kind !== 'needsConfirm') return;
    assert.match(doseRepeatReason(asked.check, now, CHI, 'kim'), /a dose for a later time/);
    const plan = planDose({ ...base, course: c, lastDoseSurvives: true }, { ...intent, confirm: doseConfirmOf(asked.check) });
    assert.equal(plan.kind === 'write' && plan.becomesLatest, false);
  });

  test('refusals: missing or finished course, an occurrence not in the schedule (edited meanwhile)', () => {
    const intent = { userUid: 'sam', occurrenceKey: '2026-11-14T08:00', givenAt: null };
    assert.deepEqual(planDose({ ...base, course: null, lastDoseSurvives: false }, intent), { kind: 'refused', reason: 'missing' });
    assert.deepEqual(planDose({ ...base, course: course({ status: 'finished' }), lastDoseSurvives: false }, intent), { kind: 'refused', reason: 'finished' });
    assert.deepEqual(planDose({ ...base, course: course(), lastDoseSurvives: false }, { ...intent, occurrenceKey: '2026-11-14T09:00' }), { kind: 'refused', reason: 'occurrence' });
  });

  test('a schedule edit that moved the given dose asks before recording the replacement', () => {
    const c = course({
      schedule: { kind: 'days', everyDays: 1, times: ['09:00', '21:00'] },
      lastDose: pointer('2026-11-14T08:00', '2026-11-14T14:00:00Z'),
      coveredUntil: at('2026-11-14T15:00:00Z'),
    });
    const plan = planDose({ ...base, now: at('2026-11-14T15:05:00Z'), course: c, lastDoseSurvives: true }, { userUid: 'sam', occurrenceKey: '2026-11-14T09:00', givenAt: null });
    assert.equal(plan.kind, 'needsConfirm');
    if (plan.kind === 'needsConfirm') assert.equal(plan.check.reason, 'moved');
  });
});

describe('Undo of a dose: the pointer is the derived state of the surviving doses (D)', () => {
  const rec = (logId: string, occurrence: string, occurrenceAt: string, givenAt = occurrenceAt) =>
    ({ logId, occurrence, occurrenceAt: Date.parse(occurrenceAt), givenAt: Date.parse(givenAt), byUid: 'sam', byName: 'Sam' });
  // Chicago CST: 8:00 = 14:00Z, 10:00 = 16:00Z, 12:00 = 18:00Z.
  const eight = rec('eight', '2026-11-14T08:00', '2026-11-14T14:00:00Z');
  const noon = rec('noon', '2026-11-14T12:00', '2026-11-14T18:00:00Z', '2026-11-14T16:30:00Z'); // early
  const ten = rec('ten', '2026-11-14T10:00', '2026-11-14T16:00:00Z', '2026-11-14T16:40:00Z'); // confirmed after noon

  test('record 8:00, then 12:00 early, then a confirmed 10:00, then remove 12:00: 10:00 is the latest, not 8:00', () => {
    // The stored pointer after the three doses (each write stored the derived state).
    const afterThree = pointerAfter({ coveredUntil: null, lastDose: null, prevDose: null }, [eight, noon, ten]);
    assert.deepEqual([afterThree.latest?.logId, afterThree.prev?.logId], ['noon', 'ten']);
    const stored = { coveredUntil: null, lastDose: afterThree.latest, prevDose: afterThree.prev };
    // Remove 12:00: the surviving doses decide (a remembered prevDose alone would also be 10:00 here,
    // and with the confirmed 10:00 recorded before 12:00 it would have been 8:00).
    const removed = pointerAfter(stored, [eight, ten]);
    assert.deepEqual([removed.latest?.logId, removed.prev?.logId, removed.write], ['ten', 'eight', true]);
    const course = readCourse('apoquel', { name: 'Apoquel', dosage: '1', schedule: { kind: 'days', everyDays: 1, times: ['08:00', '10:00', '12:00', '20:00'] }, startDay: '2026-11-13', status: 'active', lastDose: { ...removed.latest!, occurrenceAt: new Date(removed.latest!.occurrenceAt), givenAt: new Date(removed.latest!.givenAt!) } })!;
    assert.equal(nextDueOccurrence(course, CHI)?.key, '2026-11-14T12:00', '10:00 is not due again');
  });

  test('a pointer stored by the old rule (12:00 with prev 8:00, the confirmed 10:00 left out) still resolves to 10:00', () => {
    // Before the fix a dose older than the latest never rewrote the pointer, so prevDose stayed 8:00
    // and Undo of 12:00 restored it: 10:00 was due again. The surviving records decide now.
    const stored = { coveredUntil: null, lastDose: noon, prevDose: eight };
    const removed = pointerAfter(stored, [eight, ten]);
    assert.equal(removed.latest?.logId, 'ten');
  });

  test('removing an older dose keeps a later one by someone else; nothing changes when the pointer already agrees', () => {
    const kims = { ...rec('kims', '2026-11-14T12:00', '2026-11-14T18:00:00Z'), byUid: 'kim', byName: 'Kim' };
    const stored = { coveredUntil: null, lastDose: kims, prevDose: eight };
    const next = pointerAfter(stored, [kims]);
    assert.deepEqual([next.latest?.logId, next.prev, next.write], ['kims', null, true], 'the removed previous dose is forgotten');
    assert.equal(pointerAfter({ coveredUntil: null, lastDose: kims, prevDose: null }, [kims]).write, false);
    assert.deepEqual(pointerAfter(stored, []), { latest: null, prev: null, write: true });
  });

  test('ties: the latest occurrence, then the latest given, then the id', () => {
    const a = rec('a', '2026-11-14T08:00', '2026-11-14T14:00:00Z', '2026-11-14T14:00:00Z');
    const b = rec('b', '2026-11-14T08:00', '2026-11-14T14:00:00Z', '2026-11-14T15:00:00Z');
    assert.equal(deriveCourseState({ coveredUntil: null }, [a, b]).latest?.logId, 'b');
    assert.equal(deriveCourseState({ coveredUntil: null }, [b, a]).latest?.logId, 'b');
  });

  test('the Undo copy never says the dose itself was undone', () => {
    assert.match(DOSE_UNDO_COPY.title, /record/i);
    assert.match(DOSE_UNDO_COPY.description, /still counts/);
    assert.doesNotMatch(`${DOSE_UNDO_COPY.title} ${DOSE_UNDO_COPY.description}`, /dose (was )?undone/i);
  });
});

describe('legacy medication (D-P8)', () => {
  const legacy = (date: string, medication: string, nextDueDate?: string, extra: Record<string, unknown> = {}) => ({ date, medication, dosage: '1 chew', nextDueDate, ...extra });

  test('consistent history gives a suggestion that keeps the same next due day', () => {
    const [group] = pendingLegacyGroups([
      legacy('2026-09-06T15:00:00Z', 'Heartworm', '2026-10-06'),
      legacy('2026-10-06T15:00:00Z', ' heartworm', '2026-11-05'),
    ], new Set(), CHI);
    assert.equal(group.reason, 'consistent');
    assert.deepEqual(group.suggestion, { kind: 'days', everyDays: 30, times: [] });
    assert.equal(group.dueDay, '2026-11-05');
    assert.equal(group.entries, 2);
  });

  test('conflicting intervals or unusable dates are genuinely ambiguous: no suggestion', () => {
    const [conflict] = pendingLegacyGroups([
      legacy('2026-09-06T15:00:00Z', 'Flea', '2026-10-06'),
      legacy('2026-10-06T15:00:00Z', 'Flea', '2026-10-20'),
    ], new Set(), CHI);
    assert.equal(conflict.reason, 'conflicting');
    assert.equal(conflict.suggestion, null);
    const [none] = pendingLegacyGroups([legacy('2026-10-06T15:00:00Z', 'Ear drops', '2026-10-01')], new Set(), CHI);
    assert.equal(none.reason, 'no-interval');
    assert.equal(none.suggestion, null);
  });

  test('ended countdowns, course doses, one-off doses and taken-over names need no confirmation', () => {
    const logs = [
      legacy('2026-10-06T15:00:00Z', 'Ended', '2026-11-05'),
      legacy('2026-10-07T15:00:00Z', 'Ended'),
      legacy('2026-10-06T15:00:00Z', 'Taken', '2026-11-05'),
      legacy('2026-10-06T15:00:00Z', 'Course dose', '2026-11-05', { courseId: 'c1' }),
      legacy('2026-10-06T15:00:00Z', 'One off', '2026-11-05', { oneOff: true }),
    ];
    assert.deepEqual(pendingLegacyGroups(logs, new Set(['taken']), CHI), []);
  });

  test('a stable course id per legacy name (two members confirming write one course)', () => {
    assert.equal(legacyCourseId('flea & tick'), legacyCourseId('flea & tick'));
    assert.notEqual(legacyCourseId('flea & tick'), legacyCourseId('flea tick'));
    assert.match(legacyCourseId('flea & tick'), /^legacy-flea-tick-[a-z0-9]+$/);
  });
});

describe('the course form', () => {
  const today = '2026-11-14';
  const values = (overrides: Partial<ReturnType<typeof courseFormValues>> = {}) => ({ ...courseFormValues({ name: 'Apoquel', dosage: '1 tablet' }, today), ...overrides });

  test('multi-daily times, an hour interval, start and end', () => {
    assert.deepEqual(validateCourseForm(values({ times: ['20:00', '08:00'] })).fields?.schedule, { kind: 'days', everyDays: 1, times: ['08:00', '20:00'] });
    assert.deepEqual(validateCourseForm(values({ kind: 'hours', everyHours: '12', firstTime: '07:00' })).fields?.schedule, { kind: 'hours', everyHours: 12, firstTime: '07:00' });
    assert.equal(validateCourseForm(values({ endDay: '2026-11-20' })).fields?.endDay, '2026-11-20');
  });

  test('inline errors; a second active course with the same name is refused (typo protection)', () => {
    assert.ok(validateCourseForm(values({ name: ' ' })).errors.name);
    assert.ok(validateCourseForm(values({ dosage: '' })).errors.dosage);
    assert.ok(validateCourseForm(values({ everyDays: '0' })).errors.everyDays);
    assert.ok(validateCourseForm(values({ times: ['08:00', '08:00'] })).errors.times);
    assert.ok(validateCourseForm(values({ kind: 'hours', everyHours: '1' })).errors.everyHours);
    assert.ok(validateCourseForm(values({ endDay: '2026-11-01' })).errors.endDay);
    assert.match(validateCourseForm(values({ name: ' APOQUEL ' }), ['apoquel']).errors.name ?? '', /already has an active course/);
  });

  test('the preview lists the next scheduled doses (from the saved plan only)', () => {
    const { fields } = validateCourseForm(values({ times: ['08:00', '20:00'] }));
    assert.deepEqual(schedulePreview(fields!, at('2026-11-14T15:00:00Z'), CHI).map(o => o.key), ['2026-11-14T20:00', '2026-11-15T08:00', '2026-11-15T20:00']);
  });
});

describe('client and server agree (PE-24h)', () => {
  const courseData = { name: 'Apoquel', dosage: '1 tablet', schedule: { kind: 'days', everyDays: 1, times: ['08:00', '20:00'] }, startDay: '2026-11-13', status: 'active', lastDose: pointer('2026-11-14T08:00', '2026-11-14T14:00:00Z') };
  const legacyLogs = [{ id: 'l1', date: '2026-10-06T15:00:00Z', medication: 'Heartworm', dosage: '1 chew', notes: '', nextDueDate: '2026-11-05' }];

  test('the chip and the reminder name the same occurrence, per course and per legacy name', () => {
    const now = at('2026-11-15T02:30:00Z'); // 8:30 PM Nov 14 in Chicago
    const dues = medicationDues([readCourse('apoquel', courseData)!], legacyLogs, now, CHI);
    assert.deepEqual(dues.map(d => [d.medication, d.label, d.occurrenceKey ?? d.dueDay]), [
      ['Heartworm', 'Overdue by 9 days', '2026-11-05'],
      ['Apoquel', 'Due since 8:00 PM', '2026-11-14T20:00'],
    ]);
    const reminders = buildMedicationReminders([{ id: 'rex', name: 'Rex', logs: legacyLogs, courses: [{ id: 'apoquel', data: courseData }] }], '2026-11-14', { now, timeZone: CHI });
    assert.deepEqual(reminders.map(r => [r.sourceId, r.stateKey]), [
      ['rex:course:apoquel', 'due|2026-11-14T20:00'],
      ['rex:heartworm', 'overdue|2026-11-05'],
    ]);
    assert.equal(reminders[0].title, "Rex's Apoquel 8:00 PM dose is due");
    assert.equal(reminders[0].message, 'Planned dose: 1 tablet. Tap to record it once it\'s given.');
    assert.equal(reminders[0].deepLink, '/pets/rex?tab=medication&dose=apoquel');
    // The push still carries the pet's photo for a course reminder.
    assert.deepEqual(imageSourceFor({ category: 'pets', sourceType: reminders[0].sourceType, sourceId: reminders[0].sourceId })?.path, ['pets', 'rex']);
  });

  test('confirming a legacy course moves its countdown to the course; the legacy reminder stops', () => {
    const confirmed = { name: 'Heartworm', dosage: '1 chew', schedule: { kind: 'days', everyDays: 30, times: [] }, startDay: '2026-11-05', status: 'active', legacyKeys: ['heartworm'] };
    const now = at('2026-11-14T18:00:00Z');
    const dues = medicationDues([readCourse(legacyCourseId('heartworm'), confirmed)!], legacyLogs, now, CHI);
    assert.deepEqual(dues.map(d => [d.courseId ? 'course' : 'legacy', d.label]), [['course', 'Overdue by 9 days']], 'same due day, now from the course');
    assert.deepEqual(currentMedications(legacyLogs, now, CHI, new Set(['heartworm'])), []);
    const pets = [{ id: 'rex', name: 'Rex', logs: legacyLogs, courses: [{ id: legacyCourseId('heartworm'), data: confirmed }] }];
    assert.deepEqual(buildMedicationReminders(pets, '2026-11-14', { now, timeZone: CHI }).map(r => r.sourceId), [`rex:course:${legacyCourseId('heartworm')}`]);
    assert.ok(!pendingCycles(pets, CHI).has('rex:heartworm|2026-11-05'), 'the open legacy reminder resolves');
  });

  test('a finished course has no chip, no reminder and no pending cycle', () => {
    const finished = { ...courseData, status: 'finished' };
    const now = at('2026-11-15T02:30:00Z');
    assert.deepEqual(medicationDues([readCourse('apoquel', finished)!], [], now, CHI), []);
    const pets = [{ id: 'rex', name: 'Rex', logs: [], courses: [{ id: 'apoquel', data: finished }] }];
    assert.deepEqual(buildMedicationReminders(pets, '2026-11-14', { now, timeZone: CHI }), []);
    assert.equal(pendingCycles(pets, CHI).size, 0);
  });

  test('a renamed course keeps its identity: one chip, the reminder follows the new name', () => {
    const now = at('2026-11-15T02:30:00Z');
    const renamed = { ...courseData, name: 'Apoquel 16 mg' };
    const before = buildMedicationReminders([{ id: 'rex', name: 'Rex', logs: [], courses: [{ id: 'apoquel', data: courseData }] }], '2026-11-14', { now, timeZone: CHI });
    const after = buildMedicationReminders([{ id: 'rex', name: 'Rex', logs: [], courses: [{ id: 'apoquel', data: renamed }] }], '2026-11-14', { now, timeZone: CHI });
    assert.equal(after.length, 1);
    assert.equal(after[0].sourceId, before[0].sourceId);
    assert.equal(after[0].stateKey, before[0].stateKey, 'the same reminder document');
    assert.match(after[0].title, /Apoquel 16 mg/);
  });
});

describe('permissions come from one table (R5)', () => {
  test('each action maps to real permissions that the rules enforce', () => {
    const rules = readFileSync('firestore.rules', 'utf8');
    for (const [action, permissions] of Object.entries(MEDICATION_ACTION_PERMISSIONS)) {
      assert.ok(permissions.length > 0, action);
      for (const permission of permissions) assert.ok(rules.includes(`'${permission}'`), `${action}: ${permission} in rules`);
    }
    assert.deepEqual(MEDICATION_ACTION_PERMISSIONS['pets.course.finish'], ['pets.addLogs']);
    // Lead decision: creating and editing a course must not regress 2.1, where anyone who logged set a next-due date.
    assert.deepEqual(MEDICATION_ACTION_PERMISSIONS['pets.course.edit'], ['pets.addLogs']);
    assert.deepEqual(MEDICATION_ACTION_PERMISSIONS['pets.medication.confirmLegacy'], ['pets.addLogs']);
  });

  test('the rule functions behind each action check exactly the permission in the table', () => {
    const rules = readFileSync('firestore.rules', 'utf8');
    const body = (name: string) => {
      const start = rules.indexOf(`function ${name}(`);
      assert.ok(start >= 0, name);
      const end = rules.indexOf('\n    function ', start + 1);
      return rules.slice(start, end);
    };
    const uses = (name: string, action: keyof typeof MEDICATION_ACTION_PERMISSIONS) => {
      const text = body(name);
      for (const permission of MEDICATION_ACTION_PERMISSIONS[action]) assert.ok(text.includes(`'${permission}'`), `${name} checks ${permission}`);
      assert.ok(!text.includes("'pets.editProfiles'"), `${name} does not require pets.editProfiles`);
    };
    uses('courseCreated', 'pets.course.edit');
    uses('courseCreated', 'pets.medication.confirmLegacy');
    uses('courseEdited', 'pets.course.edit');
    uses('courseFinished', 'pets.course.finish');
    uses('courseResumed', 'pets.course.finish');
    // A pointer write (Give, Undo, delete) needs pets.addLogs or pets.deleteLogs (the dose's own rule needs pets.addLogs).
    uses('mayRemoveDoses', 'pets.dose.undo');
    assert.match(rules, /match \/medication-logs\/\{logId\} \{[\s\S]*?allow create: if hasHouseholdPermission\(householdId, 'pets\.addLogs'\)/);
  });

  test('role presets: anyone who logs may give, finish, create and edit a course; guests nothing (D-P19)', () => {
    const child = getRolePresetPermissions('child');
    const member = getRolePresetPermissions('member');
    const guest = getRolePresetPermissions('guest');
    for (const action of ['pets.dose.give', 'pets.course.finish', 'pets.course.edit', 'pets.medication.confirmLegacy'] as const) {
      assert.equal(mayMedication(action, child), true, `child: ${action}`);
      assert.equal(mayMedication(action, member), true, `member: ${action}`);
      assert.equal(mayMedication(action, guest), false, `guest: ${action}`);
    }
  });
});

describe('the attention strip follows courses too (PE-26 with P3)', () => {
  const courseData = { name: 'Apoquel', dosage: '1 tablet', schedule: { kind: 'days', everyDays: 1, times: ['08:00', '20:00'] }, startDay: '2026-11-13', status: 'active', lastDose: pointer('2026-11-14T08:00', '2026-11-14T14:00:00Z') };
  const legacyLogs = [{ id: 'l1', date: '2026-10-06T15:00:00Z', medication: 'Heartworm', dosage: '1 chew', notes: '', nextDueDate: '2026-11-05' }];

  test('a course dose past its time today is not overdue; after household midnight it is', () => {
    const course = readCourse('apoquel', courseData)!;
    assert.equal(medicationAttention(medicationDues([course], [], at('2026-11-15T03:00:00Z'), CHI)), null, 'Due since 8:00 PM stays amber');
    assert.equal(medicationAttention(medicationDues([course], [], at('2026-11-15T06:30:00Z'), CHI)), 'Apoquel: overdue by 1 day');
  });

  test('a legacy countdown still counts until a course takes it over; a finished course never does', () => {
    assert.equal(medicationAttention(medicationDues([], legacyLogs, at('2026-11-14T18:00:00Z'), CHI)), 'Heartworm: overdue by 9 days');
    const finished = readCourse('legacy-heartworm', { name: 'Heartworm', schedule: null, startDay: '2026-11-01', status: 'finished', legacyKeys: ['heartworm'] })!;
    assert.equal(medicationAttention(medicationDues([finished], legacyLogs, at('2026-11-14T18:00:00Z'), CHI)), null);
  });
});

describe('doses recorded offline', () => {
  const now = at('2026-11-14T14:10:00Z');
  const offlineLog = (id: string, occurrence: string, occurrenceAt: string) => ({
    id, courseId: 'apoquel', occurrence, occurrenceAt: at(occurrenceAt), date: at(occurrenceAt), repeat: 'offline', clockSource: 'device', loggedByUid: 'kim', loggedByName: 'Kim',
  });

  test('an offline dose covers its occurrence for every reader, without the pointer', () => {
    const c = course({ lastDose: pointer('2026-11-13T20:00', '2026-11-14T02:00:00Z') });
    const combined = withOfflineDoses(c, [offlineLog('off-1', '2026-11-14T08:00', '2026-11-14T14:00:00Z'), { id: 'x', courseId: 'other', occurrence: '2026-11-15T08:00', occurrenceAt: at('2026-11-15T14:00:00Z'), repeat: 'offline' }]);
    assert.equal(combined.offlineDose?.logId, 'off-1');
    assert.equal(nextDueOccurrence(combined, CHI)?.key, '2026-11-14T20:00');
    assert.equal(withOfflineDoses(c, []), c, 'unchanged without offline doses');
    // The server agrees: the reminder for 8:00 AM is no longer pending.
    const pets = [{ id: 'rex', name: 'Rex', logs: [offlineLog('off-1', '2026-11-14T08:00', '2026-11-14T14:00:00Z')], courses: [{ id: 'apoquel', data: { name: 'Apoquel', dosage: '1 tablet', schedule: { kind: 'days', everyDays: 1, times: ['08:00', '20:00'] }, startDay: '2026-11-13', status: 'active', lastDose: pointer('2026-11-13T20:00', '2026-11-14T02:00:00Z') } }] }];
    assert.ok(!pendingCycles(pets, CHI).has('rex:course:apoquel|2026-11-14T08:00'));
    assert.ok(pendingCycles(pets, CHI).has('rex:course:apoquel|2026-11-14T20:00'));
  });

  test('a later online dose for that occurrence asks first, naming the offline dose', () => {
    const c = withOfflineDoses(course({ lastDose: pointer('2026-11-13T20:00', '2026-11-14T02:00:00Z') }), [offlineLog('off-1', '2026-11-14T08:00', '2026-11-14T14:00:00Z')]);
    const intent = { userUid: 'sam', occurrenceKey: '2026-11-14T08:00', givenAt: null };
    const asked = planDose({ now, timeZone: CHI, course: c, lastDoseSurvives: true, existing: null }, intent);
    assert.equal(asked.kind, 'needsConfirm');
    if (asked.kind !== 'needsConfirm') return;
    assert.equal(asked.check.last?.logId, 'off-1');
    assert.match(doseRepeatReason(asked.check, now, CHI, 'sam'), /^Kim recorded the Today 8:00 AM dose/);
    const written = planDose({ now, timeZone: CHI, course: c, lastDoseSurvives: true, existing: null }, { ...intent, confirm: doseConfirmOf(asked.check) });
    assert.equal(written.kind === 'write' && written.confirmOf, 'off-1');
  });

  test('planned offline: the device clock, marked offline, never the pointer', () => {
    const plan = planDose({ now, timeZone: CHI, course: course(), lastDoseSurvives: false, existing: null, offline: true }, { userUid: 'sam', occurrenceKey: '2026-11-14T08:00', givenAt: null });
    assert.equal(plan.kind, 'write');
    if (plan.kind !== 'write') return;
    assert.deepEqual([plan.repeat, plan.live, plan.becomesLatest, plan.confirmOf], ['offline', false, false, null]);
    assert.equal(plan.givenAt.getTime(), now.getTime());
    assert.equal(plan.nextAfter?.key, '2026-11-14T20:00');
  });
});

describe('copy', () => {
  test('last-dose context names who and when', () => {
    const c = course({ lastDose: pointer('2026-11-14T08:00', '2026-11-14T14:00:00Z') });
    assert.equal(lastDoseLine(c, at('2026-11-14T16:00:00Z'), CHI, 'kim'), 'Last given 2 h ago by Sam');
    assert.equal(lastDoseLine(c, at('2026-11-14T16:00:00Z'), CHI, 'sam'), 'Last given 2 h ago by you');
    assert.equal(lastDoseLine(course(), at('2026-11-14T16:00:00Z'), CHI), null);
  });
});

describe('Calendar (PE-27d, PE-24f, PE-24n)', () => {
  const twice = { name: 'Apoquel', dosage: '1 tablet', schedule: { kind: 'days', everyDays: 1, times: ['08:00', '20:00'] }, startDay: '2026-11-13', status: 'active', lastDose: pointer('2026-11-14T08:00', '2026-11-14T14:00:00Z') };
  const entry = (data: Record<string, unknown>, id = 'apoquel') => ({ petId: 'rex', petName: 'Rex', course: readCourse(id, data)! });

  test('each occurrence of a multi-dose course from its next due one, on its household day', () => {
    const events = courseDueEvents([entry(twice)], at('2026-11-14T18:00:00Z'), CHI, '2026-11-15');
    assert.deepEqual(events.map(e => [e.day, e.title, e.medicationDue?.label]), [
      ['2026-11-14', 'Apoquel (1 tablet) · 8:00 PM', 'Due 8:00 PM'],
      ['2026-11-15', 'Apoquel (1 tablet) · 8:00 AM', 'Due tomorrow 8:00 AM'],
      ['2026-11-15', 'Apoquel (1 tablet) · 8:00 PM', 'Due tomorrow 8:00 PM'],
    ]);
    assert.equal(new Set(events.map(e => e.id)).size, events.length, 'no duplicate occurrence');
    assert.equal(events[0].href, '/pets/rex?tab=medication&dose=apoquel');
  });

  test('a finished course shows nothing; a legacy name a course took over no longer counts down', () => {
    assert.deepEqual(courseDueEvents([entry({ ...twice, status: 'finished' })], at('2026-11-14T18:00:00Z'), CHI, '2026-11-20'), []);
    const legacy = [{ id: 'l1', petId: 'rex', petName: 'Rex', medication: 'Heartworm', dosage: '1 chew', date: '2026-10-06T15:00:00.000Z', nextDueDate: '2026-11-05' }];
    assert.equal(medicationDueEvents(legacy, '2026-11-14').length, 1);
    const confirmed = entry({ name: 'Heartworm', dosage: '1 chew', schedule: { kind: 'days', everyDays: 30, times: [] }, startDay: '2026-11-05', status: 'active', legacyKeys: ['heartworm'] }, 'legacy-heartworm');
    assert.equal(medicationDueEvents(legacy, '2026-11-14', [confirmed]).length, 0);
    const [first] = courseDueEvents([confirmed], at('2026-11-14T18:00:00Z'), CHI, '2026-11-20');
    assert.deepEqual([first.day, first.overdue, first.medicationDue?.label], ['2026-11-05', true, 'Overdue by 9 days']);
  });
});

describe('a reminder link is consumed only after a successful read of the courses (E)', () => {
  const active = [{ id: 'apoquel', status: 'active' as const }];

  test('a failed course read keeps the link (dose stays in the URL); the recovered read opens Give dose', () => {
    const failed = doseLinkDecision({ requested: 'apoquel', seen: null, loading: false, error: new Error('unavailable'), courses: [] });
    assert.deepEqual(failed, { kind: 'wait' });
    assert.deepEqual(doseLinkDecision({ requested: 'apoquel', seen: null, loading: true, error: null, courses: [] }), { kind: 'wait' });
    assert.deepEqual(doseLinkDecision({ requested: 'apoquel', seen: null, loading: false, error: null, courses: active }), { kind: 'open', courseId: 'apoquel' });
  });

  test('a finished or missing course says so only after a successful read; handled links reset', () => {
    assert.deepEqual(doseLinkDecision({ requested: 'apoquel', seen: null, loading: false, error: null, courses: [{ id: 'apoquel', status: 'finished' }] }), { kind: 'inactive' });
    assert.deepEqual(doseLinkDecision({ requested: 'apoquel', seen: 'apoquel', loading: false, error: null, courses: active }), { kind: 'idle' });
    assert.deepEqual(doseLinkDecision({ requested: null, seen: 'apoquel', loading: false, error: null, courses: active }), { kind: 'reset' });
    assert.deepEqual(doseLinkDecision({ requested: null, seen: null, loading: false, error: null, courses: active }), { kind: 'idle' });
  });

  test('the Medication tab uses the decision (no consumption on an error)', () => {
    const source = readFileSync('src/components/medication-log.tsx', 'utf8');
    assert.match(source, /doseLinkDecision\(\{ requested: doseCourseId, seen: seenDose, loading: state\.loading, error: state\.error, courses: state\.courses \}\)/);
    assert.doesNotMatch(source, /\(!doseCourseId \|\| !state\.loading\)/);
  });
});

describe('an early dose right after a dose asks first (the duplicate check reads the derived latest dose)', () => {
  test('a dose for the next time moments after the last one asks, naming it; an offline dose counts too', () => {
    // Every 2 hours: 08:00 given at 9:49, then at 9:50 the nearest time is 10:00 (early).
    const every2 = { name: 'Antibiotic', dosage: '1 ml', schedule: { kind: 'hours', everyHours: 2, firstTime: '00:00' }, startDay: '2026-11-14', status: 'active' };
    const eight = { logId: 'eight', occurrence: '2026-11-14T08:00', occurrenceAt: at('2026-11-14T14:00:00Z'), givenAt: at('2026-11-14T15:49:00Z'), byUid: 'sam', byName: 'Sam' };
    const now = at('2026-11-14T15:50:00Z');
    const c = readCourse('c', { ...every2, lastDose: eight })!;
    const { prefill } = doseChoices(c, now, CHI);
    assert.equal(prefill?.key, '2026-11-14T10:00');
    const asked = planDose({ now, timeZone: CHI, course: c, lastDoseSurvives: true, existing: null }, { userUid: 'kim', occurrenceKey: prefill!.key, givenAt: null });
    assert.equal(asked.kind, 'needsConfirm');
    if (asked.kind !== 'needsConfirm') return;
    assert.equal(asked.check.reason, 'recent');
    assert.match(doseRepeatReason(asked.check, now, CHI, 'kim'), /^Sam recorded a dose 1 min ago \(the Today 8:00 AM dose\)\. The Today 10:00 AM dose would be early\.$/);
    const written = planDose({ now, timeZone: CHI, course: c, lastDoseSurvives: true, existing: null }, { userUid: 'kim', occurrenceKey: prefill!.key, givenAt: null, confirm: doseConfirmOf(asked.check) });
    assert.equal(written.kind === 'write' && written.repeat, 'confirmed');
    // The same with the 8:00 dose recorded offline (not in the pointer): the derived latest decides.
    const offline = withOfflineDoses(readCourse('c', every2)!, [{ id: 'eight', courseId: 'c', occurrence: '2026-11-14T08:00', occurrenceAt: eight.occurrenceAt, date: eight.givenAt, repeat: 'offline', loggedByUid: 'sam', loggedByName: 'Sam' }]);
    const offlineAsked = planDose({ now, timeZone: CHI, course: offline, lastDoseSurvives: false, existing: null }, { userUid: 'kim', occurrenceKey: '2026-11-14T10:00', givenAt: null });
    assert.equal(offlineAsked.kind === 'needsConfirm' && offlineAsked.check.reason, 'recent');
    // Once the window has passed (half the interval: 1 h), an early dose no longer asks.
    const later = planDose({ now: at('2026-11-14T16:55:00Z'), timeZone: CHI, course: c, lastDoseSurvives: true, existing: null }, { userUid: 'kim', occurrenceKey: '2026-11-14T10:00', givenAt: null });
    assert.equal(later.kind, 'write');
  });
});
