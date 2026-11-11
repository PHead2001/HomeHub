import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  buildMedicationReminders,
  medicationCycle,
  pendingCycles,
  pendingMedications,
} from '../../functions/src/shared/medication-reminders';
import { imageSourceFor } from '../../functions/src/shared/push-media';
import { nextMedication } from '../../src/lib/pets/care';

const dose = (date: unknown, medication: string, nextDueDate?: string) => ({ date, medication, dosage: '1', nextDueDate });

describe('pending medication countdowns (same rule as the Pets page)', () => {
  test('the latest entry of each medication decides, names grouped case-insensitively', () => {
    const logs = [
      dose('2026-10-01T10:00:00Z', 'Flea prevention', '2026-11-01'),
      dose('2026-10-07T10:00:00Z', ' flea PREVENTION', '2026-11-06'),
      dose('2026-10-02T10:00:00Z', 'Heartworm', '2026-11-02'),
    ];
    assert.deepEqual(pendingMedications(logs).map(d => [d.key, d.medication, d.dueDay]).sort(), [
      ['flea prevention', 'flea PREVENTION', '2026-11-06'],
      ['heartworm', 'Heartworm', '2026-11-02'],
    ]);
  });

  test('a later dose without a next due date cancels the countdown', () => {
    const logs = [dose('2026-10-07T10:00:00Z', 'Flea', '2026-11-06'), dose('2026-10-08T10:00:00Z', 'Flea')];
    assert.deepEqual(pendingMedications(logs), []);
    // The Pets page agrees.
    assert.equal(nextMedication(logs as never, new Date('2026-11-06T12:00:00')), null);
  });

  test('Firestore timestamps and invalid due dates', () => {
    const ts = { toDate: () => new Date('2026-10-09T10:00:00Z') };
    assert.equal(pendingMedications([dose('2026-10-07T10:00:00Z', 'Flea', '2026-11-06'), dose(ts, 'Flea', '2026-11-09')])[0].dueDay, '2026-11-09');
    assert.deepEqual(pendingMedications([dose('2026-10-07T10:00:00Z', 'Flea', '2026-02-30')]), []);
    assert.deepEqual(pendingMedications([dose('not a date', 'Flea', '2026-11-06')]), []);
  });
});

describe('medication reminders', () => {
  const pets = [{ id: 'maple', name: 'Maple', logs: [dose('2026-10-07T10:00:00Z', 'Flea prevention', '2026-11-06')] }];

  test('nothing before the due day', () => {
    assert.deepEqual(buildMedicationReminders(pets, '2026-11-05'), []);
  });

  test('due today, then overdue, with plain copy and the agreed identity', () => {
    const [due] = buildMedicationReminders(pets, '2026-11-06');
    assert.equal(due.title, "Maple's Flea prevention is due today");
    assert.equal(due.sourceType, 'pet_medication');
    assert.equal(due.sourceId, 'maple:flea prevention');
    assert.equal(due.stateKey, 'due|2026-11-06');
    assert.equal(due.deepLink, '/pets/maple?tab=medication');
    const [late] = buildMedicationReminders(pets, '2026-11-07');
    assert.equal(late.title, "Maple's Flea prevention is overdue");
    assert.equal(late.stateKey, 'overdue|2026-11-06');
  });

  test('a reminder belongs to its countdown until a newer dose replaces it', () => {
    const cycle = medicationCycle('maple:flea prevention', 'overdue|2026-11-06');
    assert.ok(pendingCycles(pets).has(cycle));
    const redosed = [{ ...pets[0], logs: [...pets[0].logs, dose('2026-11-06T10:00:00Z', 'Flea prevention', '2026-12-06')] }];
    assert.ok(!pendingCycles(redosed).has(cycle));
  });

  test('the push uses the pet photo for medication reminders', () => {
    assert.deepEqual(imageSourceFor({ category: 'pets', sourceType: 'pet_medication', sourceId: 'maple:flea prevention' })?.path, ['pets', 'maple']);
  });
});

describe('reopening a resolved reminder', () => {
  const at = (seconds: number, nanoseconds = 0) => ({ seconds, nanoseconds });

  test("only when it was resolved at or before the run's source reads (server time against server time)", async () => {
    const { shouldReopen } = await import('../../functions/src/reminders');
    assert.equal(shouldReopen(at(1), at(2)), true, 'resolved earlier: the data read since shows it is actionable again');
    assert.equal(shouldReopen(at(2, 500), at(2, 500)), true, 'committed at the read time: the read already reflects it');
    assert.equal(shouldReopen(at(2, 499_999), at(2, 500_000)), true, 'sub-millisecond order is exact');
    assert.equal(shouldReopen(at(2, 500_001), at(2, 500_000)), false, 'committed after the read, in the same millisecond');
    assert.equal(shouldReopen(at(3), at(2, 999_999_999)), false, 'resolved during the run: the run may not have seen why');
    assert.equal(shouldReopen(undefined, at(2)), false);
    assert.equal(shouldReopen(at(1), undefined), false, 'no read time: never reopen');
  });

  test("the run's read point is the earliest read time of its source snapshots", async () => {
    const { earliestReadTime } = await import('../../functions/src/reminders');
    assert.deepEqual(earliestReadTime([{ readTime: at(5, 2) }, { readTime: at(5, 1) }, { readTime: at(6) }]), at(5, 1));
    assert.deepEqual(earliestReadTime([{ readTime: at(7) }, {}, { readTime: at(4, 9) }]), at(4, 9), 'a snapshot without a read time is ignored');
    assert.equal(earliestReadTime([{}, {}]), undefined);
    assert.equal(earliestReadTime([]), undefined);
  });
});
