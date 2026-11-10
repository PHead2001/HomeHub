import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import {
  addMonthsToDay,
  batchAmountLabel,
  chooseUsedUpBatch,
  dayFromPicker,
  daysUntilDay,
  expiryFromChip,
  findPantryMergeTarget,
  groupPantryBatches,
  householdToday,
  legacyQuantity,
  msUntilHouseholdMidnight,
  pantryBatchFields,
  pantryMergeKey,
  pickerDateForDay,
  productSummary,
  readPantryBatch,
  shortExpiryLabel,
  shouldDeleteEmptyBatch,
  upgradeLegacyBatch,
  usableRecipeItems,
  usedUpOutcome,
  type PantryBatch,
} from '../../src/lib/shopping/pantry-batches';
import { daysUntilExpiry, expiryState, pantryLocationForCategory, pantryMergeStillValid, planPantryHandoff } from '../../src/lib/shopping/pantry';

const CENTRAL = 'America/Chicago';
/** 23:30 Central on Tue 10 Nov 2026 (05:30 UTC on the 11th). */
const LATE_EVENING = new Date('2026-11-11T05:30:00.000Z');

const batch = (id: string, overrides: Partial<PantryBatch> = {}): PantryBatch => ({
  id, name: 'Rice', nameKey: 'rice', location: 'Pantry', unit: 'g', packages: 1, packageSize: 450,
  expiryDate: null, barcode: null, legacy: false, updatedAtMs: null, ...overrides,
});

describe('legacy documents are read as v2 batches', () => {
  test('a counted unit: packages = quantity, no package size', () => {
    const read = readPantryBatch('eggs', { name: ' Eggs ', quantity: 6, unit: 'items', location: 'Fridge', expiryDate: null }, CENTRAL);
    assert.equal(read.packages, 6);
    assert.equal(read.packageSize, null);
    assert.equal(read.nameKey, 'eggs');
    assert.equal(read.legacy, true);
  });

  test('a measured unit: one package of the stored amount, never 450 packages', () => {
    const read = readPantryBatch('rice', { name: 'Rice', quantity: 450, unit: 'g', location: 'Pantry' }, CENTRAL);
    assert.equal(read.packages, 1);
    assert.equal(read.packageSize, 450);
    const empty = readPantryBatch('rice', { name: 'Rice', quantity: 0, unit: 'kg', location: 'Pantry' }, CENTRAL);
    assert.equal(empty.packages, 0);
    assert.equal(empty.packageSize, null);
  });

  test('a legacy ISO expiry (local midnight) becomes its day in the household zone', () => {
    const read = readPantryBatch('milk', { name: 'Milk', quantity: 1, unit: 'items', location: 'Fridge', expiryDate: '2026-11-14T06:00:00.000Z' }, CENTRAL);
    assert.equal(read.expiryDate, '2026-11-14');
    assert.equal(readPantryBatch('x', { name: 'X', expiryDate: '2026-11-14' }, CENTRAL).expiryDate, '2026-11-14');
    assert.equal(readPantryBatch('x', { name: 'X', expiryDate: 'soon' }, CENTRAL).expiryDate, null);
  });

  test('a v2 document is read as stored; bad values are clamped or dropped', () => {
    const read = readPantryBatch('v2', { name: 'Rice', packages: 3, packageSize: 450, unit: 'g', location: 'Garage', schemaVersion: 2, quantity: 999 }, CENTRAL);
    assert.deepEqual([read.packages, read.packageSize, read.location, read.legacy], [3, 450, 'Pantry', false]);
    assert.equal(readPantryBatch('n', { name: 'N', packages: -2, packageSize: 0, unit: 'zz' }).packages, 0);
    assert.equal(readPantryBatch('n', { name: 'N', packages: 1, packageSize: 0, unit: 'g' }).packageSize, null);
    assert.equal(readPantryBatch('n', { name: 'N', packages: 1, unit: 'zz' }).unit, 'items');
  });

  test('v2 writes dual-write quantity: packages for counted units, the package size for measured ones', () => {
    assert.equal(legacyQuantity({ unit: 'cans', packages: 4, packageSize: null }), 4);
    assert.equal(legacyQuantity({ unit: 'g', packages: 2, packageSize: 450 }), 450);
    assert.equal(legacyQuantity({ unit: 'g', packages: 2, packageSize: null }), 2);
    const fields = pantryBatchFields({ name: '  Basmati   rice ', location: 'Pantry', unit: 'g', packages: 2, packageSize: 450, expiryDate: '2026-12-01' });
    assert.deepEqual(fields, {
      name: 'Basmati rice', nameKey: 'basmati rice', location: 'Pantry', unit: 'g', packages: 2, packageSize: 450,
      expiryDate: '2026-12-01', quantity: 450, schemaVersion: 2,
    });
    // A counted unit never stores a package size; an ISO expiry is never written.
    assert.equal(pantryBatchFields({ name: 'Beans', location: 'Pantry', unit: 'cans', packages: 3, packageSize: 400, expiryDate: null }).packageSize, null);
    assert.equal(pantryBatchFields({ name: 'Beans', location: 'Pantry', unit: 'cans', packages: 3, packageSize: null, expiryDate: '2026-12-01T06:00:00.000Z' }).expiryDate, null);
  });

  test('the first change to a legacy document writes absolute upgraded values', () => {
    const legacy = readPantryBatch('milk', { name: 'Milk', quantity: 2, unit: 'items', location: 'Fridge', expiryDate: '2026-11-14T06:00:00.000Z' }, CENTRAL);
    assert.deepEqual(upgradeLegacyBatch(legacy, -1), {
      name: 'Milk', nameKey: 'milk', location: 'Fridge', unit: 'items', packages: 1, packageSize: null,
      expiryDate: '2026-11-14', quantity: 1, schemaVersion: 2,
    });
    assert.equal(upgradeLegacyBatch(legacy, -5).packages, 0);
  });
});

describe('merge key (SH-23a): batches that differ on any part stay apart', () => {
  const base = { nameKey: 'rice', location: 'Pantry' as const, packageSize: 450, unit: 'g' as const, expiryDate: '2026-12-01' };

  test('same key merges; name casing and spacing do not matter', () => {
    assert.equal(pantryMergeKey(base), pantryMergeKey({ ...base }));
    const target = findPantryMergeTarget([batch('a', { expiryDate: '2026-12-01' })], base);
    assert.equal(target?.id, 'a');
  });

  test('a different shelf, size, unit or expiry never merges, and units never mix', () => {
    for (const change of [{ location: 'Fridge' as const }, { packageSize: 1000 }, { packageSize: null }, { unit: 'kg' as const }, { unit: 'items' as const }, { expiryDate: '2026-12-02' }, { expiryDate: null }, { nameKey: 'brown rice' }]) {
      assert.notEqual(pantryMergeKey({ ...base, ...change }), pantryMergeKey(base), JSON.stringify(change));
    }
    assert.equal(findPantryMergeTarget([batch('a', { expiryDate: '2026-12-01', unit: 'kg' })], base), undefined);
  });

  test('a merge prefers a batch that still has stock over a hidden empty one', () => {
    const target = findPantryMergeTarget([batch('empty', { packages: 0, expiryDate: '2026-12-01' }), batch('full', { expiryDate: '2026-12-01' })], base);
    assert.equal(target?.id, 'full');
  });

  test('the shopping hand-off merges only into an undated, unsized items batch on the same shelf', () => {
    const existing = [
      { id: 'milk-v2', name: 'Milk', unit: 'items' as const, location: 'Fridge' as const, packages: 1, packageSize: null, expiryDate: null, schemaVersion: 2 },
      { id: 'milk-dated', name: 'Milk', unit: 'items' as const, location: 'Fridge' as const, packages: 1, expiryDate: '2026-11-20', schemaVersion: 2 },
      { id: 'milk-litres', name: 'Milk', unit: 'L' as const, location: 'Fridge' as const, quantity: 2 },
    ];
    const plans = planPantryHandoff([{ item: { name: 'milk', quantity: 2 }, location: 'Fridge' }], existing.slice(1));
    assert.deepEqual(plans, [{ kind: 'create', name: 'milk', quantity: 2, location: 'Fridge' }], 'dated and 2 L batches are other stock');
    assert.equal(planPantryHandoff([{ item: { name: 'milk', quantity: 2 }, location: 'Fridge' }], existing)[0].kind, 'increment');
    assert.equal(pantryMergeStillValid({ name: 'Milk', unit: 'items', location: 'Fridge', packages: 1, expiryDate: '2026-11-20' }, { name: 'Milk' }, 'Fridge'), false);
  });
});

describe('tiles group a product and "used one" takes from the soonest batch (SH-22a)', () => {
  const today = '2026-11-10';

  test('batches of one name on one shelf are one tile; empty batches are hidden', () => {
    const products = groupPantryBatches([
      batch('late', { expiryDate: '2026-11-20', packages: 1 }),
      batch('soon', { expiryDate: '2026-11-13', packages: 2 }),
      batch('fridge', { location: 'Fridge' }),
      batch('gone', { packages: 0 }),
    ]);
    assert.equal(products.length, 2);
    const pantry = products.find((product) => product.location === 'Pantry')!;
    assert.deepEqual(pantry.batches.map((entry) => entry.id), ['soon', 'late']);
    assert.equal(pantry.totalPackages, 3);
    assert.equal(pantry.nextExpiry, '2026-11-13');
    assert.equal(productSummary(pantry, today), '2 × 450 g · Fri, 1 × 450 g · next Fri');
  });

  test('used one picks the soonest-expiring batch with stock; undated batches last', () => {
    const chosen = chooseUsedUpBatch([batch('undated'), batch('later', { expiryDate: '2026-12-01' }), batch('sooner', { expiryDate: '2026-11-12' }), batch('empty', { expiryDate: '2026-11-11', packages: 0 })]);
    assert.equal(chosen?.id, 'sooner');
    assert.equal(chooseUsedUpBatch([batch('undated')])?.id, 'undated');
    assert.equal(chooseUsedUpBatch([batch('empty', { packages: 0 })]), undefined);
  });

  test('used one removes one package, never 1 g of a measured amount', () => {
    const outcome = usedUpOutcome({ batches: [batch('bag', { packages: 2, packageSize: 450 })] })!;
    assert.equal(outcome.batch.id, 'bag');
    assert.equal(outcome.remaining, 1, 'one package left, not 449 g');
    assert.equal(batchAmountLabel({ ...outcome.batch, packages: 1 }), '1 × 450 g');
    assert.equal(batchAmountLabel({ unit: 'cans', packages: 3, packageSize: null }), '3 cans');
    assert.equal(batchAmountLabel({ unit: 'kg', packages: 1, packageSize: null }), '1 pack (kg)');
  });

  test('reaching zero asks "Add to list?"; anything left does not (D-8)', () => {
    assert.equal(usedUpOutcome({ batches: [batch('a', { packages: 2 })] })!.askAddToList, false);
    assert.equal(usedUpOutcome({ batches: [batch('a', { packages: 1 })] })!.askAddToList, true);
    assert.equal(usedUpOutcome({ batches: [batch('a', { packages: 1 }), batch('b', { packages: 1, expiryDate: '2026-12-01' })] })!.askAddToList, false);
    assert.equal(usedUpOutcome({ batches: [] }), null);
  });

  test('an empty batch is deleted only when untouched for a minute', () => {
    const now = Date.parse('2026-11-10T12:00:00Z');
    assert.equal(shouldDeleteEmptyBatch({ packages: 0, updatedAtMs: now - 61_000 }, now), true);
    assert.equal(shouldDeleteEmptyBatch({ packages: 0, updatedAtMs: now - 30_000 }, now), false);
    assert.equal(shouldDeleteEmptyBatch({ packages: 1, updatedAtMs: now - 600_000 }, now), false);
    assert.equal(shouldDeleteEmptyBatch({ packages: 0, updatedAtMs: null }, now), true);
  });

  test('the client wires D-8: Add merges through the list path, Not now adds nothing', () => {
    const client = readFileSync(join(__dirname, '..', '..', 'src', 'components', 'pantry-inventory-client.tsx'), 'utf8');
    assert.match(client, /<AlertDialogCancel>Not now<\/AlertDialogCancel>/);
    assert.match(client, /if \(reachedZero\) setAskAdd\(/);
    const writes = readFileSync(join(__dirname, '..', '..', 'src', 'lib', 'shopping', 'pantry-batch-writes.ts'), 'utf8');
    assert.match(writes, /findMergeTarget\(needed, name\)/);
    assert.match(writes, /mergeIntoNeededItem\(doc\(itemsRef, target\.id\), 1\)/);
    assert.match(writes, /packages: increment\(delta\)/);
  });

  test('recipes get only usable stock (SH-27e)', () => {
    const products = groupPantryBatches([
      batch('old', { name: 'Yogurt', nameKey: 'yogurt', unit: 'items', packageSize: null, packages: 2, expiryDate: '2026-11-09' }),
      batch('rice', { packages: 2, packageSize: 450 }),
      batch('cans', { name: 'Beans', nameKey: 'beans', unit: 'cans', packageSize: null, packages: 3, expiryDate: '2026-11-10' }),
    ]);
    assert.deepEqual(usableRecipeItems(products, today), [
      { name: 'Beans', quantity: 3, unit: 'cans' },
      { name: 'Rice', quantity: 900, unit: 'g' },
    ]);
  });
});

describe('expiry is a date-only day in the household zone (SH-10a/b)', () => {
  test('at 23:30 Central the household day is still today, not tomorrow (UTC)', () => {
    assert.equal(LATE_EVENING.toISOString().slice(0, 10), '2026-11-11');
    assert.equal(householdToday(LATE_EVENING, CENTRAL), '2026-11-10');
    assert.equal(expiryFromChip('3d', LATE_EVENING, CENTRAL), '2026-11-13');
    assert.equal(expiryFromChip('1w', LATE_EVENING, CENTRAL), '2026-11-17');
    assert.equal(expiryFromChip('1mo', LATE_EVENING, CENTRAL), '2026-12-10');
    assert.equal(expiryFromChip('freezer3mo', LATE_EVENING, CENTRAL), '2027-02-10');
  });

  test('a picked calendar day is saved as that day, never shifted by toISOString', () => {
    // The picker hands back the device's local midnight of the chosen day.
    const picked = new Date(2026, 10, 14);
    assert.equal(dayFromPicker(picked), '2026-11-14');
    assert.equal(dayFromPicker(pickerDateForDay('2026-11-14')!), '2026-11-14');
    assert.equal(pickerDateForDay('2026-11-31'), undefined);
    assert.equal(pickerDateForDay(null), undefined);
  });

  test('"expiring soon" counts from the household today and rolls at household midnight', () => {
    assert.equal(daysUntilDay('2026-11-10', '2026-11-10', CENTRAL), 0);
    assert.equal(daysUntilDay('2026-11-14T06:00:00.000Z', '2026-11-10', CENTRAL), 4);
    assert.equal(daysUntilExpiry('2026-11-10', LATE_EVENING, CENTRAL), 0, 'still today at 23:30 Central');
    assert.equal(daysUntilExpiry('2026-11-10', new Date('2026-11-11T06:00:00.000Z'), CENTRAL), -1, 'expired after midnight');
    assert.equal(expiryState('2026-11-13', LATE_EVENING, CENTRAL), 'soon');
    assert.equal(expiryState('2026-11-14', LATE_EVENING, CENTRAL), 'fresh');
    // The page re-keys "today" just after household midnight.
    assert.equal(msUntilHouseholdMidnight(LATE_EVENING, CENTRAL), 30 * 60_000);
  });

  test('month arithmetic clamps to the end of a shorter month', () => {
    assert.equal(addMonthsToDay('2026-01-31', 1), '2026-02-28');
    assert.equal(addMonthsToDay('2027-11-30', 3), '2028-02-29');
  });

  test('short tile labels', () => {
    assert.equal(shortExpiryLabel('2026-11-09', '2026-11-10'), 'expired');
    assert.equal(shortExpiryLabel('2026-11-10', '2026-11-10'), 'today');
    assert.equal(shortExpiryLabel('2026-11-11', '2026-11-10'), 'tomorrow');
    assert.equal(shortExpiryLabel('2026-11-13', '2026-11-10'), 'Fri');
    assert.equal(shortExpiryLabel('2026-11-20', '2026-11-10'), 'next Fri');
    assert.equal(shortExpiryLabel('2026-12-04', '2026-11-10'), 'Dec 4');
  });
});

describe('shelf guess (SH-23c)', () => {
  test('shelf-stable produce stays in the Pantry; other produce goes to the Fridge', () => {
    for (const name of ['Onions', 'Red potatoes', 'Bananas', 'Garlic', 'Sweet potato']) {
      assert.equal(pantryLocationForCategory('Produce', name), 'Pantry', name);
    }
    assert.equal(pantryLocationForCategory('Produce', 'Spinach'), 'Fridge');
    assert.equal(pantryLocationForCategory('Produce'), 'Fridge');
  });
});
