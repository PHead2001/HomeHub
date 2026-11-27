import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { ambientAlerts } from '../../src/lib/devices/ambient-alerts';

const all = { chores: true, shopping: true, pets: true, calendar: true, maintenance: true };
const facts = {
  chores: { overdueTotal: 2 },
  pets: { pets: [], hungry: 1, unknown: 0 },
  maintenance: { overdue: 3 },
} as never;

describe('ambient alerts (HP-16)', () => {
  test('counts only, singular and plural, notices last', () => {
    assert.deepEqual(ambientAlerts(facts, all, 1), ['2 chores overdue', '1 pet needs a meal', '3 maintenance items overdue', '1 household notice']);
  });

  test('nothing to do says nothing; unknown counts are left out, never zero', () => {
    assert.deepEqual(ambientAlerts({ chores: { overdueTotal: 0 }, pets: { pets: [], hungry: 0, unknown: 2 } } as never, all, 0), []);
    assert.deepEqual(ambientAlerts({} as never, all, 0), []);
    assert.deepEqual(ambientAlerts(null, all, 2), ['2 household notices']);
  });

  test('sections switched off on the tablet say nothing', () => {
    assert.deepEqual(ambientAlerts(facts, { ...all, chores: false, maintenance: false }, 0), ['1 pet needs a meal']);
  });
});
