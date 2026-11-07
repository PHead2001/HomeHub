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
