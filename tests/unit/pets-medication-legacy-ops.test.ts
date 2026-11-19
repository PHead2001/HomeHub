/**
 * The dry-run legacy medication report (scripts/ops/report-legacy-medication.mjs,
 * D-P8): its plain-JavaScript classification (scripts/ops/medication-legacy.mjs)
 * agrees with the app's `pendingLegacyGroups` on synthetic histories, and the
 * script refuses to write.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { pendingLegacyGroups, takenLegacyKeys as appTaken, readCourse } from '../../src/lib/pets/medication-course';
import { classifyLegacyMedication, takenLegacyKeys } from '../../scripts/ops/medication-legacy.mjs';

const CHI = 'America/Chicago';
const entry = (date: string, medication: string, nextDueDate?: string, extra: Record<string, unknown> = {}) => ({ date, medication, dosage: '1', ...(nextDueDate ? { nextDueDate } : {}), ...extra });

const histories: Record<string, Record<string, unknown>[]> = {
  monthly: [entry('2026-09-06T15:00:00Z', 'Heartworm', '2026-10-06'), entry('2026-10-06T15:00:00Z', 'heartworm ', '2026-11-05')],
  conflicting: [entry('2026-09-06T15:00:00Z', 'Flea', '2026-10-06'), entry('2026-10-06T15:00:00Z', 'Flea', '2026-10-20')],
  unusable: [entry('2026-10-06T15:00:00Z', 'Drops', '2026-10-01')],
  ended: [entry('2026-10-06T15:00:00Z', 'Old', '2026-11-05'), entry('2026-10-07T15:00:00Z', 'Old')],
  // Late evening in Chicago is the next UTC day: the gap counts household days.
  lateEvening: [entry('2026-10-07T04:30:00Z', 'Evening', '2026-10-13')],
  mixed: [
    entry('2026-10-06T15:00:00Z', 'Course dose', '2026-11-05', { courseId: 'c1' }),
    entry('2026-10-06T15:00:00Z', 'One off', '2026-11-05', { oneOff: true }),
    entry('2026-10-06T15:00:00Z', 'Taken', '2026-11-05'),
    entry('not a date', 'Broken', '2026-11-05'),
  ],
};

describe('the legacy medication report classifies as the app does', () => {
  for (const [name, logs] of Object.entries(histories)) {
    test(name, () => {
      const courses = [{ legacyKeys: ['taken'] }];
      const viewCourses = [readCourse('legacy-taken', { name: 'Taken', schedule: null, startDay: '2026-11-01', status: 'finished', legacyKeys: ['taken'] })!];
      const script = classifyLegacyMedication(logs, takenLegacyKeys(courses), CHI)
        .filter((group: { status: string }) => !['taken', 'ended'].includes(group.status))
        .map((group: { key: string; status: string; everyDays: number | null }) => [group.key, group.status, group.everyDays]);
      const app = pendingLegacyGroups(logs, appTaken(viewCourses), CHI)
        .map((group) => [group.key, group.reason, group.suggestion?.kind === 'days' ? group.suggestion.everyDays : null]);
      assert.deepEqual(script, app);
    });
  }

  test('taken-over and ended names are counted, not pending', () => {
    const groups = classifyLegacyMedication([...histories.ended, ...histories.mixed], new Set(['taken']), CHI);
    assert.deepEqual(groups.map((group: { key: string; status: string }) => [group.key, group.status]), [['old', 'ended'], ['taken', 'taken']]);
  });

  test('the late-evening dose gap is in household days', () => {
    assert.equal(classifyLegacyMedication(histories.lateEvening, new Set(), CHI)[0].everyDays, 7);
  });
});

describe('the report never writes', () => {
  test('refuses --apply and has no write calls', () => {
    const source = readFileSync('scripts/ops/report-legacy-medication.mjs', 'utf8');
    assert.match(source, /if \(options\.apply\)/);
    assert.match(source, /process\.exit\(2\)/);
    assert.doesNotMatch(source, /\.(set|update|create|delete|commit)\(/);
  });
});
