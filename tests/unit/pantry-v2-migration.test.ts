import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { legacyQuantity, readPantryBatch, splitPackages as appSplitPackages } from '../../src/lib/shopping/pantry-batches';
import { expiryDay, pantryMigrationDecision, pantryV2Values, splitPackages } from '../../scripts/ops/pantry-v2.mjs';

const CENTRAL = 'America/Chicago';

const samples: Array<Record<string, unknown>> = [
  { name: 'Eggs', quantity: 12, unit: 'items', location: 'Fridge', expiryDate: '2026-11-14T06:00:00.000Z' },
  { name: '  Basmati  Rice ', quantity: 450, unit: 'g', location: 'Pantry', expiryDate: null },
  { name: 'Milk', quantity: 0, unit: 'L', location: 'Fridge' },
  { name: 'Peas', quantity: 2, unit: 'bags', location: 'Garage', expiryDate: 'not a date' },
  { name: 'Beans', packages: 3, packageSize: null, unit: 'cans', location: 'Pantry', expiryDate: '2026-12-01', schemaVersion: 2, nameKey: 'beans', quantity: 3 },
  { name: 'Flour', packages: 2, packageSize: 1000, unit: 'g', location: 'Pantry', expiryDate: '2027-01-15T06:00:00.000Z', schemaVersion: 2, quantity: 1000 },
];

describe('migrate-pantry-v2 mapping (scripts/ops/pantry-v2.mjs)', () => {
  test('agrees with the app\'s readPantryBatch and dual-written quantity, case by case', () => {
    for (const data of samples) {
      const app = readPantryBatch('id', data, CENTRAL);
      const ops = pantryV2Values(data, CENTRAL);
      assert.deepEqual(
        [ops.nameKey, ops.location, ops.unit, ops.packages, ops.packageSize, ops.expiryDate, ops.quantity],
        [app.nameKey, app.location, app.unit, app.packages, app.packageSize, app.expiryDate, legacyQuantity(app)],
        JSON.stringify(data),
      );
    }
  });

  test('a legacy document gets every v2 field; its name is kept as stored', () => {
    const decision = pantryMigrationDecision({ name: 'Eggs', quantity: 12, unit: 'items', location: 'Fridge', expiryDate: '2026-11-14T06:00:00.000Z' }, CENTRAL);
    assert.deepEqual(decision, {
      kind: 'legacy',
      update: { nameKey: 'eggs', location: 'Fridge', unit: 'items', packages: 12, packageSize: null, expiryDate: '2026-11-14', quantity: 12, schemaVersion: 2 },
    });
    const measured = pantryMigrationDecision({ name: 'Rice', quantity: 450, unit: 'g', location: 'Pantry' }, CENTRAL);
    assert.equal(measured.kind, 'legacy');
    assert.deepEqual(measured.kind === 'legacy' && [measured.update.packages, measured.update.packageSize, measured.update.quantity], [1, 450, 450]);
  });

  test('v2 documents are left alone unless an older page wrote an ISO expiry', () => {
    assert.deepEqual(pantryMigrationDecision(samples[4], CENTRAL), { kind: 'current' });
    assert.deepEqual(pantryMigrationDecision(samples[5], CENTRAL), {
      kind: 'expiry',
      update: { expiryDate: '2027-01-15', nameKey: 'flour', schemaVersion: 2 },
    });
  });

  test('ISO expiries convert in the household zone, not UTC', () => {
    // 2026-11-14 00:00 in Chicago is 06:00 UTC; in Los Angeles it is the 13th at 22:00.
    assert.equal(expiryDay('2026-11-14T06:00:00.000Z', CENTRAL), '2026-11-14');
    assert.equal(expiryDay('2026-11-14T06:00:00.000Z', 'America/Los_Angeles'), '2026-11-13');
    assert.equal(expiryDay('2026-11-14', CENTRAL), '2026-11-14');
    assert.equal(expiryDay('', CENTRAL), null);
    assert.equal(pantryV2Values({ expiryDate: '2026-11-14T06:00:00.000Z' }, 'Not/AZone').expiryDate, '2026-11-14', 'unknown zone falls back to Chicago');
  });

  test('splitPackages agrees with the app', () => {
    for (const total of [0, 1, 9_999, 10_000, 10_001, 15_000, 25_000, 100_000, 12_345.6, -5]) {
      assert.deepEqual(splitPackages(total), appSplitPackages(total), String(total));
    }
  });

  test('legacy counted stock above 10,000 is split across batches, never truncated', () => {
    const legacy = { name: 'Napkins', quantity: 15_000, unit: 'items', location: 'Pantry', addedAt: '2025-01-01', expiryDate: null };
    const decision = pantryMigrationDecision(legacy, CENTRAL);
    assert.equal(decision.kind, 'split');
    if (decision.kind !== 'split') return;
    assert.deepEqual([decision.update.packages, decision.update.quantity], [10_000, 10_000]);
    assert.equal('name' in decision.update, false, 'the name stays as stored');
    assert.equal(decision.newBatches.length, 1);
    assert.deepEqual(decision.newBatches[0], {
      name: 'Napkins', quantity: 5_000, unit: 'items', location: 'Pantry', addedAt: '2025-01-01', expiryDate: null,
      nameKey: 'napkins', packages: 5_000, packageSize: null, schemaVersion: 2,
    });

    const large = pantryMigrationDecision({ name: 'Rivets', quantity: 25_000, unit: 'pieces' }, CENTRAL);
    assert.equal(large.kind, 'split');
    if (large.kind !== 'split') return;
    const counts = [large.update.packages, ...large.newBatches.map(batch => batch.packages)];
    assert.deepEqual(counts, [10_000, 10_000, 5_000]);
    assert.equal(counts.reduce((sum, count) => sum + (count as number), 0), 25_000, 'the total is kept');
    for (const batch of large.newBatches) assert.equal(batch.quantity, batch.packages);
  });

  test('exactly 10,000 counted is an ordinary conversion', () => {
    const decision = pantryMigrationDecision({ name: 'Pins', quantity: 10_000, unit: 'items' }, CENTRAL);
    assert.equal(decision.kind, 'legacy');
    assert.deepEqual(decision.kind === 'legacy' && [decision.update.packages, decision.update.quantity], [10_000, 10_000]);
  });

  test('legacy measured stock above 100,000 is refused, not zeroed', () => {
    assert.deepEqual(pantryMigrationDecision({ name: 'Water', quantity: 150_000, unit: 'ml' }, CENTRAL), { kind: 'oversized' });
    const atLimit = pantryMigrationDecision({ name: 'Water', quantity: 100_000, unit: 'ml' }, CENTRAL);
    assert.equal(atLimit.kind, 'legacy');
    assert.deepEqual(atLimit.kind === 'legacy' && [atLimit.update.packages, atLimit.update.packageSize], [1, 100_000]);
  });
});
