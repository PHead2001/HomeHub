import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { pantryScanPrefill } from '../../src/lib/shopping/pantry-scan';
import { PANTRY_NAME_MAX, pantryBatchFields } from '../../src/lib/shopping/pantry-batches';

describe('a barcode scan fills the pantry form (Pantry v2, BL-1)', () => {
  test('a weight or volume is ONE package of the scanned size, never that many packages', () => {
    assert.deepEqual(pantryScanPrefill({ productName: 'E2E Yogurt Multipack', quantity: 450, unit: 'g' }), {
      name: 'E2E Yogurt Multipack', amount: { unit: 'g', packages: 1, packageSize: '450' },
    });
    assert.deepEqual(pantryScanPrefill({ productName: 'E2E Family Juice', quantity: 128, unit: 'fl oz' })?.amount,
      { unit: 'fl oz', packages: 1, packageSize: '128' });
    assert.equal(pantryScanPrefill({ productName: 'Rice', quantity: 0.12345, unit: 'kg' })?.amount?.packageSize, '0.123');
  });

  test('a counted unit is how many there are (no package size), within the batch limit', () => {
    assert.deepEqual(pantryScanPrefill({ productName: 'Eggs', quantity: 12, unit: 'items' })?.amount,
      { unit: 'items', packages: 12, packageSize: '' });
    assert.equal(pantryScanPrefill({ productName: 'Beans', quantity: 0.4, unit: 'cans' })?.amount?.packages, 1);
    assert.equal(pantryScanPrefill({ productName: 'Tablets', quantity: 50_000, unit: 'items' })?.amount?.packages, 10_000);
  });

  test('no usable amount fills only the name; a size above the stored maximum is left out', () => {
    assert.deepEqual(pantryScanPrefill({ productName: 'E2E Odd Measure' }), { name: 'E2E Odd Measure', amount: null });
    assert.equal(pantryScanPrefill({ productName: 'Odd', quantity: 1, unit: 'bushel' })?.amount, null);
    assert.equal(pantryScanPrefill({ productName: 'Odd', quantity: -1, unit: 'g' })?.amount, null);
    assert.deepEqual(pantryScanPrefill({ productName: 'Bulk', quantity: 200_000, unit: 'g' })?.amount, { unit: 'g', packages: 1, packageSize: '' });
  });

  test('the Barcode Library name wins, and the name fits the pantry limit so Save is never blocked', () => {
    assert.equal(pantryScanPrefill({ productName: 'Open Food Facts name', libraryItem: { name: 'Our oat milk' } })?.name, 'Our oat milk');
    const long = pantryScanPrefill({ productName: `  Very   long ${'x'.repeat(300)}` });
    assert.equal(long?.name.length, PANTRY_NAME_MAX);
    assert.ok(long?.name.startsWith('Very long '));
    // The batch written from it keeps that name (what the rules accept).
    const fields = pantryBatchFields({ name: long!.name, location: 'Pantry', unit: 'items', packages: 1, packageSize: null, expiryDate: null, barcode: '1' });
    assert.equal(fields.name, long!.name);
    assert.equal(pantryScanPrefill({ productName: '   ' }), null);
    assert.equal(pantryScanPrefill({}), null);
  });
});
