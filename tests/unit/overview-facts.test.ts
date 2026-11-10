import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { summarizeOverviewPantry } from '../../src/ai/overview-fact-helpers';

const now = new Date('2026-08-01T12:00:00.000Z');

describe('AI overview pantry facts', () => {
  test('used-up v2 batches are not counted; legacy documents still are', () => {
    const facts = summarizeOverviewPantry([
      { name: 'Greek yogurt', expiryDate: '2026-08-04', packages: 1, schemaVersion: 2 },
      { name: 'Cream', expiryDate: '2026-08-02', packages: 0, schemaVersion: 2 },
      { name: 'Old milk', expiryDate: '2026-07-20', packages: 0, schemaVersion: 2 },
      { name: 'Butter', expiryDate: '2026-07-25T05:00:00.000Z', quantity: 0 },
      { name: 'Rice', expiryDate: '2026-08-20' },
    ], now);
    assert.equal(facts.totalItems, 3);
    assert.equal(facts.expired, 1, 'only the legacy Butter');
    assert.equal(facts.expiringWithinSevenDays, 1);
    assert.equal(facts.expiringWithinThirtyDays, 2);
    assert.deepEqual(facts.nearestExpirations.map((entry) => entry.label), ['Butter', 'Greek yogurt', 'Rice']);
  });

  test('labels keep email addresses out', () => {
    const facts = summarizeOverviewPantry([{ name: 'Milk for a@b.test', expiryDate: '2026-08-02' }], now);
    assert.equal(facts.nearestExpirations[0].label, 'Milk for a member');
  });
});
