import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { formatPackageSize, packageSize, scanToShoppingEntry } from '../../src/lib/shopping/scan';
import { buildShoppingListItem } from '../../src/lib/shopping-items';

describe('barcode scan quantity (BL-1)', () => {
  test('a scan adds one package and keeps the size separately', () => {
    // The e2e fixtures: "128 fl oz" juice and the 450 g yogurt multipack.
    assert.deepEqual(scanToShoppingEntry({ productName: 'E2E Family Juice', quantity: 128, unit: 'fl oz' }),
      { name: 'E2E Family Juice', quantity: 1, size: 128, sizeUnit: 'fl oz' });
    assert.deepEqual(scanToShoppingEntry({ productName: 'E2E Yogurt Multipack', quantity: 450, unit: 'g' }),
      { name: 'E2E Yogurt Multipack', quantity: 1, size: 450, sizeUnit: 'g' });
  });

  test('the household library name wins; no size without both parts', () => {
    assert.deepEqual(scanToShoppingEntry({ productName: 'Generic', libraryItem: { name: 'Our oat milk' }, quantity: 1, unit: 'L' }),
      { name: 'Our oat milk', quantity: 1, size: 1, sizeUnit: 'L' });
    assert.deepEqual(scanToShoppingEntry({ productName: 'Odd', quantity: 3 }), { name: 'Odd', quantity: 1 });
    assert.deepEqual(scanToShoppingEntry({ productName: 'Odd', unit: 'g' }), { name: 'Odd', quantity: 1 });
    assert.equal(scanToShoppingEntry({ productName: '  ' }), null);
    assert.equal(scanToShoppingEntry({}), null);
  });

  test('out-of-bounds sizes are dropped, never stored', () => {
    assert.equal(packageSize(0, 'g'), null);
    assert.equal(packageSize(-1, 'g'), null);
    assert.equal(packageSize(100001, 'g'), null);
    assert.equal(packageSize(Number.NaN, 'g'), null);
    assert.equal(packageSize(5, 'x'.repeat(17)), null);
    assert.deepEqual(packageSize(100000, 'g'), { size: 100000, sizeUnit: 'g' });
  });

  test('the item document carries quantity 1 with size and unit; merging adds 1', () => {
    const entry = scanToShoppingEntry({ productName: 'Yogurt', quantity: 450, unit: 'g' })!;
    const { data } = buildShoppingListItem({ ...entry, category: 'Dairy', categorySource: 'local', addedByUid: 'u1', barcode: '009900045000' });
    assert.equal(data.quantity, 1);
    assert.equal(data.size, 450);
    assert.equal(data.sizeUnit, 'g');
    assert.equal(data.nameKey, 'yogurt');
    assert.equal(data.addedByUid, 'u1');
    assert.equal(data.categorySource, 'local');
    // The merge increment is the entry's quantity: one package.
    assert.equal(entry.quantity, 1);
  });

  test('items without a size or uid omit the fields', () => {
    const { data } = buildShoppingListItem({ name: 'Milk', quantity: 2, category: 'Dairy' });
    assert.equal('size' in data, false);
    assert.equal('sizeUnit' in data, false);
    assert.equal('addedByUid' in data, false);
    assert.equal('categorySource' in data, false);
    assert.equal(data.nameKey, 'milk');
  });

  test('the row note', () => {
    assert.equal(formatPackageSize(450, 'g'), '450 g');
    assert.equal(formatPackageSize(1.5, 'L'), '1.5 L');
    assert.equal(formatPackageSize(undefined, undefined), '');
  });
});
