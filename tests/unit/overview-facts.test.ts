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

describe('AI overview pantry facts in the household zone', () => {
  // 15:30 UTC on Nov 10 is already Nov 11 in Tokyo, and still Nov 10 in Los Angeles.
  const evening = new Date('2026-11-10T15:30:00.000Z');

  test('Asia/Tokyo: a batch dated the UTC day is already expired', () => {
    const facts = summarizeOverviewPantry([
      { name: 'Tofu', expiryDate: '2026-11-10', packages: 1, schemaVersion: 2 },
      { name: 'Natto', expiryDate: '2026-11-11', packages: 1, schemaVersion: 2 },
      // Legacy ISO: local midnight of Nov 10 in Tokyo.
      { name: 'Miso', expiryDate: '2026-11-09T15:00:00.000Z', quantity: 1 },
    ], evening, 'Asia/Tokyo');
    assert.equal(facts.expired, 2, 'Tofu and the legacy Miso');
    assert.equal(facts.expiringWithinSevenDays, 1, 'Natto expires today in Tokyo');
    assert.deepEqual(facts.nearestExpirations.map((entry) => [entry.label, entry.due]), [
      ['Tofu', '2026-11-10'], ['Miso', '2026-11-10'], ['Natto', '2026-11-11'],
    ]);
  });

  test('America/Los_Angeles: the same batch still expires today', () => {
    const facts = summarizeOverviewPantry([
      { name: 'Tofu', expiryDate: '2026-11-10', packages: 1, schemaVersion: 2 },
      { name: 'Bread', expiryDate: '2026-11-09', packages: 1, schemaVersion: 2 },
      // Legacy ISO: local midnight of Nov 10 in Los Angeles.
      { name: 'Milk', expiryDate: '2026-11-10T08:00:00.000Z', quantity: 1 },
    ], evening, 'America/Los_Angeles');
    assert.equal(facts.expired, 1, 'only Bread');
    assert.equal(facts.expiringWithinSevenDays, 2);
  });

  test('an unset or invalid zone falls back to the app default', () => {
    const facts = summarizeOverviewPantry([{ name: 'Tofu', expiryDate: '2026-11-10', packages: 1 }], evening, 'Not/AZone');
    assert.equal(facts.expired, 0, 'still Nov 10 in America/Chicago');
  });
});
