import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import {
  addMonthsToDay,
  clampPantryName,
  PANTRY_NAME_MAX,
  batchAmountLabel,
  chooseUsedUpBatch,
  dayFromPicker,
  daysUntilDay,
  decidePantryMerge,
  expiryFromChip,
  findPantryMergeTarget,
  groceryListChoice,
  groupPantryBatches,
  householdToday,
  isUsedUpPantryDoc,
  legacyQuantity,
  msUntilHouseholdMidnight,
  pantryBatchFields,
  pantryMergeKey,
  pickerDateForDay,
  productSummary,
  readPantryBatch,
  shortExpiryLabel,
  shouldDeleteEmptyBatch,
  chooseAddOneBatch,
  EMPTY_BATCH_GRACE_MS,
  LEGACY_OFFLINE_MESSAGE,
  NEEDS_REPAIR_MESSAGE,
  NOTHING_LEFT_MESSAGE,
  PantryChangeRefused,
  packageChangeRoute,
  planLegacyUpgrade,
  shoppingWriteNotice,
  undoFits,
  usableRecipeItems,
  usedUpOutcome,
  type PantryBatch,
} from '../../src/lib/shopping/pantry-batches';
import { daysUntilExpiry, expiryState, pantryLocationForCategory, pantryMergeStillValid, planPantryHandoff } from '../../src/lib/shopping/pantry';
import { MAX_PACKAGES, REPAIR_PACKAGES_MESSAGE, REPAIR_SIZE_MESSAGE, fillBatch, packageChangeToast, planMergeAdd, repairEditError, repairEditPrefill, roundAmount, splitPackages } from '../../src/lib/shopping/pantry-batches';
import { notifyDataChanged, onDataChanged } from '../../src/lib/data-changed';

const CENTRAL = 'America/Chicago';
/** 23:30 Central on Tue 10 Nov 2026 (05:30 UTC on the 11th). */
const LATE_EVENING = new Date('2026-11-11T05:30:00.000Z');

const batch = (id: string, overrides: Partial<PantryBatch> = {}): PantryBatch => ({
  id, name: 'Rice', nameKey: 'rice', location: 'Pantry', unit: 'g', packages: 1, packageSize: 450,
  expiryDate: null, barcode: null, legacy: false, needsRepair: false, repairAmount: null, updatedAtMs: null, ...overrides,
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
    assert.deepEqual(planLegacyUpgrade(legacy, -1).fields, {
      name: 'Milk', nameKey: 'milk', location: 'Fridge', unit: 'items', packages: 1, packageSize: null,
      expiryDate: '2026-11-14', quantity: 1, schemaVersion: 2,
    });
    assert.equal(planLegacyUpgrade(legacy, -2).fields.packages, 0);
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
    assert.match(client, /if \(reachedZero && request === promptRequestRef\.current\) setAskAdd\(/);
    const writes = readFileSync(join(__dirname, '..', '..', 'src', 'lib', 'shopping', 'pantry-batch-writes.ts'), 'utf8');
    // The merge is the Shopping list's own (addItemsToList: findMergeTarget + mergeIntoNeededItem).
    assert.match(writes, /addItemsToList\(\{[\s\S]*knownItems: needed,/);
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

describe('where "Put on a shopping list" goes (SH-6)', () => {
  const list = (id: string, name: string, type = 'Grocery') => ({ id, name, type });

  test('no Grocery list creates one; exactly one is a single tap', () => {
    assert.deepEqual(groceryListChoice([list('hw', 'Hardware', 'Hardware')]), { kind: 'create' });
    assert.deepEqual(groceryListChoice([list('hw', 'Hardware', 'Hardware'), list('weekly', 'Weekly')]), { kind: 'direct', list: list('weekly', 'Weekly') });
  });

  test('several open the picker on the recently used list, else the default', () => {
    const lists = [list('costco', 'Costco'), list('groceries', 'Groceries'), list('aldi', 'Aldi'), list('hw', 'Hardware', 'Hardware')];
    const picked = groceryListChoice(lists);
    assert.equal(picked.kind, 'pick');
    assert.equal(picked.kind === 'pick' && picked.preselectId, 'groceries', 'a list named Groceries is the default');
    assert.deepEqual(picked.kind === 'pick' && picked.lists.map((entry) => entry.id), ['aldi', 'costco', 'groceries'], 'Grocery lists only');
    const recent = groceryListChoice(lists, 'costco');
    assert.equal(recent.kind === 'pick' && recent.preselectId, 'costco');
    const stale = groceryListChoice(lists, 'deleted-list');
    assert.equal(stale.kind === 'pick' && stale.preselectId, 'groceries');
    const noGroceries = groceryListChoice([list('costco', 'Costco'), list('aldi', 'Aldi')]);
    assert.equal(noGroceries.kind === 'pick' && noGroceries.preselectId, 'aldi', 'first by name');
  });
});

describe('every v2 update carries the attribution the rules check', () => {
  test('package, edit, move and hand-off updates stamp updatedByUid and updatedAt', () => {
    const read = (file: string) => readFileSync(join(__dirname, '..', '..', 'src', 'lib', 'shopping', file), 'utf8');
    const writes = read('pantry-batch-writes.ts');
    assert.match(writes, /const touched = \(uid: string\) => \(\{ updatedByUid: uid, updatedAt: serverTimestamp\(\) \}\)/);
    for (const line of writes.split('\n').filter((entry) => /updateDoc\(|batch\.update\(|packages: increment/.test(entry))) {
      assert.match(line, /touched\(uid\)|packageChange\(/, line.trim());
    }
    const handoff = read('pantry-writes.ts');
    assert.match(handoff, /const stamp = \(\) => \(\{ updatedByUid: uid, updatedAt: serverTimestamp\(\) \}\)/);
    assert.match(handoff, /planLegacyUpgrade\(batch, toTarget\)\.fields, \.\.\.stamp\(\)/);
    assert.match(handoff, /quantity: increment\(toTarget\), \.\.\.stamp\(\)/);
  });
});

describe('used-up v2 batches are not stock (PR #129 review)', () => {
  test('a v2 batch with 0 packages is used up; legacy documents and stocked batches are not', () => {
    assert.equal(isUsedUpPantryDoc({ name: 'Rice', packages: 0, schemaVersion: 2, quantity: 450, unit: 'g' }), true);
    assert.equal(isUsedUpPantryDoc({ name: 'Rice', packages: 2, schemaVersion: 2 }), false);
    // Legacy: no packages field, even with quantity 0, counts as before.
    assert.equal(isUsedUpPantryDoc({ name: 'Milk', quantity: 0, unit: 'items' }), false);
    assert.equal(isUsedUpPantryDoc({ name: 'Milk', quantity: 2, unit: 'items' }), false);
    assert.equal(isUsedUpPantryDoc(undefined), false);
  });
});

describe('recipes never turn unknown-size packages into grams (PR #129 review)', () => {
  const today = '2026-11-10';

  test('2 bags of flour with no size are 2 packs, not 2 g, and are not summed into known-size grams', () => {
    const products = groupPantryBatches([
      batch('bags', { name: 'Flour', nameKey: 'flour', packages: 2, packageSize: null }),
      batch('sized', { name: 'Flour', nameKey: 'flour', packages: 1, packageSize: 1000, expiryDate: '2026-12-01' }),
    ]);
    assert.deepEqual(usableRecipeItems(products, today), [
      { name: 'Flour', quantity: 1000, unit: 'g' },
      { name: 'Flour', quantity: 2, unit: 'packs of unknown size (g)' },
    ]);
  });

  test('one unknown-size pack on its own', () => {
    const products = groupPantryBatches([batch('milk', { name: 'Milk', nameKey: 'milk', unit: 'L', packages: 1, packageSize: null })]);
    assert.deepEqual(usableRecipeItems(products, today), [{ name: 'Milk', quantity: 1, unit: 'pack of unknown size (L)' }]);
  });

  test('the recipe flow input schema accepts every stock line, including the longest unknown-size unit and the largest amounts', async () => {
    const { GenerateRecipeInputSchema } = await import('../../src/ai/tasks/generate-recipe');
    const products = groupPantryBatches([
      batch('juice', { name: 'Juice', nameKey: 'juice', unit: 'fl oz', packages: 10000, packageSize: null }),
      batch('rice', { name: 'Rice', nameKey: 'rice', unit: 'kg', packages: 10000, packageSize: 100000 }),
      batch('cans', { name: 'Beans', nameKey: 'beans', unit: 'cans', packages: 10000, packageSize: null }),
    ]);
    const items = usableRecipeItems(products, today);
    assert.deepEqual(items.map((item) => item.unit).sort(), ['cans', 'kg', 'packs of unknown size (fl oz)']);
    assert.equal(GenerateRecipeInputSchema.safeParse({ items }).success, true);
  });
});

describe('adding stock re-checks the merge target (PR #129 review)', () => {
  const incoming = { nameKey: 'rice', location: 'Pantry' as const, packageSize: 450, unit: 'g' as const, expiryDate: '2026-12-01' };
  const stored = { name: 'Rice', location: 'Pantry', unit: 'g', packages: 1, packageSize: 450, expiryDate: '2026-12-01', schemaVersion: 2 };

  test('merges while the stored batch still has the same key', () => {
    const decision = decidePantryMerge({ offline: false, targetId: 'rice-1', stored, incoming, timeZone: CENTRAL });
    assert.equal(decision.kind, 'merge');
    assert.equal(decision.kind === 'merge' && decision.target.id, 'rice-1');
  });

  test('creates a separate batch when another device changed the size, unit, shelf, expiry or name', () => {
    for (const change of [
      { packageSize: 1 }, { packageSize: 1, unit: 'kg' }, { location: 'Fridge' }, { expiryDate: '2026-12-02' }, { expiryDate: null }, { name: 'Brown rice' },
    ]) {
      const decision = decidePantryMerge({ offline: false, targetId: 'rice-1', stored: { ...stored, ...change }, incoming, timeZone: CENTRAL });
      assert.equal(decision.kind, 'create', JSON.stringify(change));
    }
  });

  test('creates a separate batch when the target is gone, or offline where it cannot be verified', () => {
    assert.equal(decidePantryMerge({ offline: false, targetId: 'rice-1', stored: null, incoming, timeZone: CENTRAL }).kind, 'create');
    assert.equal(decidePantryMerge({ offline: true, targetId: 'rice-1', stored, incoming, timeZone: CENTRAL }).kind, 'create');
  });

  test('saveBatch re-reads the target in a transaction and never queues a blind merge increment', () => {
    const writes = readFileSync(join(__dirname, '..', '..', 'src', 'lib', 'shopping', 'pantry-batch-writes.ts'), 'utf8');
    const save = writes.slice(writes.indexOf('export async function saveBatch'), writes.indexOf('/** Moves every batch'));
    assert.match(save, /if \(mergeInto && !isBrowserOffline\(\)\)/);
    assert.match(save, /runTransaction\(db, async \(transaction\) =>/);
    assert.match(save, /decidePantryMerge\(\{/);
    assert.doesNotMatch(save, /changePackages\(/);
  });
});

describe('"Out of this" and its Undo commit together; late prompts stay off other tabs (PR #129 review)', () => {
  const client = readFileSync(join(__dirname, '..', '..', 'src', 'components', 'pantry-inventory-client.tsx'), 'utf8');

  test('the package changes of one tap, and of its Undo, go through one write batch', () => {
    const writes = readFileSync(join(__dirname, '..', '..', 'src', 'lib', 'shopping', 'pantry-batch-writes.ts'), 'utf8');
    const together = writes.slice(writes.indexOf('export async function changePackagesTogether'), writes.indexOf('export type SaveBatchResult'));
    assert.match(together, /const batch = writeBatch\(db\);/);
    assert.match(together, /batch\.commit\(\)/);
    const apply = client.slice(client.indexOf('const applyChanges'), client.indexOf('// SH-22a / SH-29a'));
    assert.match(apply, /await changePackagesTogether\(householdId, changes, uid, onError, timeZone\)/);
    assert.doesNotMatch(apply, /Promise\.all/);
    const undo = client.slice(client.indexOf('const undoChanges'), client.indexOf('const applyChanges'));
    assert.match(undo, /changePackagesTogether\(/);
    assert.doesNotMatch(undo, /Promise\.all/);
  });

  test('hiding the tab drops a pending zero prompt, and the prompt is gated by tabActive', () => {
    assert.match(client, /useOnTabDeactivate\(\(\) => \{[^}]*promptRequestRef\.current \+= 1;/);
    assert.match(client, /const request = promptRequestRef\.current;/);
    assert.match(client, /<AlertDialog open=\{tabActive && !!askAdd\}/);
  });
});

describe('pantry names are at most 120 characters', () => {
  test('clampPantryName collapses whitespace, keeps short names and cuts long ones to 120', () => {
    assert.equal(clampPantryName('  Oat   milk '), 'Oat milk');
    assert.equal(clampPantryName('n'.repeat(120)), 'n'.repeat(120));
    assert.equal(clampPantryName('n'.repeat(500)).length, PANTRY_NAME_MAX);
    assert.equal(PANTRY_NAME_MAX, 120);
  });
  test('a cut never leaves half of a surrogate pair or trailing space', () => {
    const name = 'a'.repeat(119) + '🥛🥛';
    const clamped = clampPantryName(name);
    assert.ok(clamped.length <= 120);
    assert.ok(!/[\uD800-\uDBFF]$/.test(clamped));
    assert.equal(clampPantryName('a'.repeat(119) + ' bcd'), 'a'.repeat(119));
  });
  test('pantryBatchFields stores the clamped name and its key', () => {
    const fields = pantryBatchFields({ name: 'Rice '.repeat(40), location: 'Pantry', unit: 'items', packages: 1, packageSize: null, expiryDate: null });
    assert.ok(fields.name.length <= PANTRY_NAME_MAX);
    assert.equal(fields.name, clampPantryName('Rice '.repeat(40)));
  });
});

describe('Undo is offered only for a change the server acknowledged (SH-29c)', () => {
  test('an acknowledged write offers Undo with the tap wording', () => {
    assert.deepEqual(packageChangeToast('saved', 'Used one Milk', '1 package left.'), {
      title: 'Used one Milk', description: '1 package left.', offerUndo: true,
    });
  });
  test('a write queued offline says "Saved on this device" and offers no Undo', () => {
    const shown = packageChangeToast('queued', 'Used one Milk', 'That was the last one.');
    assert.equal(shown.offerUndo, false);
    assert.equal(shown.title, 'Saved on this device');
    assert.match(shown.description, /^Used one Milk\. That was the last one\./);
    assert.match(shown.description, /Undo is not available/);
  });
  test('the client shows the Undo action only when packageChangeToast allows it', () => {
    const client = readFileSync(join(__dirname, '..', '..', 'src', 'components', 'pantry-inventory-client.tsx'), 'utf8');
    assert.match(client, /\(\{ outcome, undoable \} = await changePackagesTogether\(householdId, changes, uid, onError, timeZone\)\);/);
    assert.match(client, /const shown = packageChangeToast\(outcome, title, description\);\s*if \(shown\.offerUndo && undoable\) \{/);
  });
});

describe('purchases above 10,000 packages are split, never clamped', () => {
  test('splitPackages keeps every package in batches of at most 10,000', () => {
    assert.deepEqual(splitPackages(25_000), [10_000, 10_000, 5_000]);
    assert.deepEqual(splitPackages(10_000), [10_000]);
    assert.deepEqual(splitPackages(3), [3]);
    assert.deepEqual(splitPackages(0), []);
    assert.equal(splitPackages(100_000).reduce((sum, n) => sum + n, 0), 100_000);
    assert.ok(splitPackages(100_000).every((n) => n <= MAX_PACKAGES));
  });
  test('fillBatch tops the merge target up to 10,000 and puts the rest in new batches', () => {
    assert.deepEqual(fillBatch(5, 2), { toTarget: 5, newBatches: [] });
    assert.deepEqual(fillBatch(2_000, 9_000), { toTarget: 1_000, newBatches: [1_000] });
    assert.deepEqual(fillBatch(25_000, 10_000), { toTarget: 0, newBatches: [10_000, 10_000, 5_000] });
  });
  test('combined same-name purchases above 10,000 are planned in full', () => {
    const plans = planPantryHandoff([
      { item: { name: 'Water', quantity: 8_000 }, location: 'Pantry' },
      { item: { name: 'water', quantity: 7_000 }, location: 'Pantry' },
    ], []);
    assert.equal(plans.length, 1);
    assert.equal(plans[0].kind === 'create' && plans[0].quantity, 15_000);
    assert.deepEqual(splitPackages(15_000), [10_000, 5_000]);
  });
  test('the handoff writes split batches and refuses an oversized handoff before clearing', () => {
    const writes = readFileSync(join(__dirname, '..', '..', 'src', 'lib', 'shopping', 'pantry-writes.ts'), 'utf8');
    assert.match(writes, /fillBatch\(plan\.add, batch\.packages\)/);
    assert.match(writes, /for \(const packages of splitPackages\(total\)\)/);
    const refusal = writes.indexOf('> MAX_HANDOFF_WRITES');
    assert.ok(refusal > 0 && refusal < writes.indexOf('transaction.delete(itemRef(id))'), 'the size check comes before any clear');
    assert.ok(refusal < writes.indexOf('for (const write of writes) write();'), 'and before any pantry write is applied');
  });
});

describe('recipe amounts keep tiny package sizes', () => {
  test('roundAmount keeps three significant digits below 1', () => {
    assert.equal(roundAmount(0.004), 0.004);
    assert.equal(roundAmount(0.12345), 0.123);
    assert.equal(roundAmount(2.345), 2.35);
    assert.equal(roundAmount(0), 0);
  });
  test('0.004 kg yeast and 0.002 L vanilla reach the recipe flow as 4 g and 2 ml', () => {
    const products = groupPantryBatches([
      batch('yeast', { name: 'Yeast', nameKey: 'yeast', unit: 'kg', packages: 1, packageSize: 0.004 }),
      batch('vanilla', { name: 'Vanilla', nameKey: 'vanilla', unit: 'L', packages: 1, packageSize: 0.002 }),
      batch('flour', { name: 'Flour', nameKey: 'flour', unit: 'kg', packages: 2, packageSize: 1.5 }),
    ]);
    const items = usableRecipeItems(products, '2026-11-10');
    const byName = Object.fromEntries(items.map((item) => [item.name, item]));
    assert.deepEqual(byName.Yeast, { name: 'Yeast', quantity: 4, unit: 'g' });
    assert.deepEqual(byName.Vanilla, { name: 'Vanilla', quantity: 2, unit: 'ml' });
    assert.deepEqual(byName.Flour, { name: 'Flour', quantity: 3, unit: 'kg' });
    assert.ok(items.every((item) => item.quantity > 0));
  });
  test('a small kg total joins the same product g line', () => {
    const products = groupPantryBatches([
      batch('a', { name: 'Salt', nameKey: 'salt', unit: 'kg', packages: 1, packageSize: 0.25 }),
      batch('b', { name: 'Salt', nameKey: 'salt', unit: 'g', packages: 1, packageSize: 100 }),
    ]);
    assert.deepEqual(usableRecipeItems(products, '2026-11-10'), [{ name: 'Salt', quantity: 350, unit: 'g' }]);
  });
  test('a tile label shows a tiny size instead of 0', () => {
    assert.equal(batchAmountLabel({ unit: 'kg', packages: 1, packageSize: 0.004 }), '1 × 0.004 kg');
  });
});

describe('an online add to a matching batch never passes 10,000 (saveBatch)', () => {
  const input = { name: 'Rice', location: 'Pantry' as const, unit: 'g' as const, packages: 3_000, packageSize: 450, expiryDate: null };

  test('the target is filled up to 10,000 and the rest becomes a new batch of the same product', () => {
    const plan = planMergeAdd(9_000, input);
    assert.equal(plan.toTarget, 1_000);
    assert.equal(plan.newBatches.length, 1);
    assert.deepEqual(plan.newBatches[0], pantryBatchFields({ ...input, packages: 2_000 }));
    assert.equal(plan.toTarget + plan.newBatches.reduce((sum, fields) => sum + fields.packages, 0), 3_000, 'nothing dropped');
  });

  test('a full target takes nothing and the whole add is a new batch; a roomy one takes it all', () => {
    const full = planMergeAdd(MAX_PACKAGES, input);
    assert.equal(full.toTarget, 0);
    assert.deepEqual(full.newBatches.map((fields) => fields.packages), [3_000]);
    assert.deepEqual(planMergeAdd(2, input), { toTarget: 3_000, newBatches: [] });
  });

  test('counted overflow batches dual-write quantity = packages', () => {
    const plan = planMergeAdd(9_999, { name: 'Eggs', location: 'Fridge', unit: 'items', packages: 10_000, packageSize: null, expiryDate: null });
    assert.equal(plan.toTarget, 1);
    assert.deepEqual(plan.newBatches.map((fields) => [fields.packages, fields.quantity]), [[9_999, 9_999]]);
  });

  test('findPantryMergeTarget prefers a batch with room over a full one', () => {
    const base = { nameKey: 'rice', location: 'Pantry' as const, packageSize: 450, unit: 'g' as const, expiryDate: null };
    const full = batch('full', { packages: MAX_PACKAGES });
    assert.equal(findPantryMergeTarget([full, batch('roomy', { packages: 5 })], base)?.id, 'roomy');
    assert.equal(findPantryMergeTarget([full, batch('empty', { packages: 0 })], base)?.id, 'empty');
    assert.equal(findPantryMergeTarget([full], base)?.id, 'full', 'a full one is still the target; the add then overflows');
  });

  test('saveBatch checks the combined count inside the transaction', () => {
    const writes = readFileSync(join(__dirname, '..', '..', 'src', 'lib', 'shopping', 'pantry-batch-writes.ts'), 'utf8');
    const transaction = writes.slice(writes.indexOf('const merged = await runTransaction('), writes.indexOf("return { outcome: 'saved', merged };"));
    assert.match(transaction, /const plan = planMergeAdd\(decision\.target\.packages, input\);/);
    assert.match(transaction, /transaction\.update\(ref, packageChange\(decision\.target, plan\.toTarget, uid\)\);/);
    assert.match(transaction, /planLegacyUpgrade\(decision\.target, plan\.toTarget\)\.fields/);
    assert.match(transaction, /for \(const extra of plan\.newBatches\)/);
    assert.doesNotMatch(transaction, /packageChange\(decision\.target, fields\.packages/);
  });
});

describe('a legacy count above 10,000 is split on its first change, never truncated (PR #129 review)', () => {
  const legacy = readPantryBatch('rice', { name: 'Rice', quantity: 15_000, unit: 'items', location: 'Pantry' }, CENTRAL);

  test('it reads in full', () => {
    assert.equal(legacy.packages, 15_000);
    assert.equal(legacy.needsRepair, false);
  });

  test('Used one keeps all 14,999: the document keeps the remainder and a new batch holds 10,000', () => {
    const plan = planLegacyUpgrade(legacy, -1);
    assert.equal(plan.fields.packages, 4_999);
    assert.equal(plan.fields.quantity, 4_999);
    assert.deepEqual(plan.newBatches.map((fields) => fields.packages), [10_000]);
    assert.ok([plan.fields, ...plan.newBatches].every((fields) => fields.packages <= MAX_PACKAGES && fields.name === 'Rice' && fields.schemaVersion === 2));
    assert.equal(plan.fields.packages + plan.newBatches.reduce((sum, fields) => sum + fields.packages, 0), 14_999);
    assert.ok(undoFits(plan.fields.packages, -1), 'undoing the tap still fits the document');
  });

  test('larger counts split into full batches; small ones are not split', () => {
    const big = planLegacyUpgrade({ ...legacy, packages: 30_001 }, -1);
    assert.deepEqual([big.fields.packages, ...big.newBatches.map((fields) => fields.packages)], [10_000, 10_000, 10_000]);
    const small = readPantryBatch('milk', { name: 'Milk', quantity: 2, unit: 'items', location: 'Fridge', expiryDate: '2026-11-14T06:00:00.000Z' }, CENTRAL);
    assert.deepEqual(planLegacyUpgrade(small, -1), {
      fields: {
        name: 'Milk', nameKey: 'milk', location: 'Fridge', unit: 'items', packages: 1, packageSize: null,
        expiryDate: '2026-11-14', quantity: 1, schemaVersion: 2,
      },
      newBatches: [],
    });
  });

  test('Out of this empties it (no Undo: +15,000 would not fit one batch); going below zero is refused', () => {
    const out = planLegacyUpgrade(legacy, -15_000);
    assert.deepEqual([out.fields.packages, out.newBatches.length], [0, 0]);
    assert.equal(undoFits(out.fields.packages, -15_000), false);
    assert.throws(() => planLegacyUpgrade(legacy, -15_001), (error: unknown) => error instanceof PantryChangeRefused && error.message === NOTHING_LEFT_MESSAGE);
  });

  test('the transaction writes the split-off batches with attribution, from its own read', () => {
    const writes = readFileSync(join(__dirname, '..', '..', 'src', 'lib', 'shopping', 'pantry-batch-writes.ts'), 'utf8');
    const together = writes.slice(writes.indexOf('export async function changePackagesTogether'), writes.indexOf('export type SaveBatchResult'));
    assert.match(together, /const plan = planLegacyUpgrade\(stored, delta\);/);
    assert.match(together, /transaction\.update\(refs\[index\], \{ \.\.\.plan\.fields, \.\.\.touched\(uid\) \}\)/);
    assert.match(together, /for \(const extra of plan\.newBatches\) transaction\.set\(doc\(pantry, slugify\(extra\.name\)\), \{ \.\.\.extra, addedByUid: uid, \.\.\.touched\(uid\) \}\)/);
  });
});

describe('a legacy measured amount above 100,000 needs repair; it is not empty stock (PR #129 review)', () => {
  const oversized = readPantryBatch('flour', { name: 'Flour', quantity: 150_000, unit: 'g', location: 'Pantry' }, CENTRAL);

  test('it is read as needing repair, with its stored amount, and shown honestly', () => {
    assert.deepEqual([oversized.needsRepair, oversized.repairAmount, oversized.packages, oversized.packageSize], [true, 150_000, 0, null]);
    assert.match(batchAmountLabel(oversized), /^150000 g, too large for one package: edit to fix$/);
    const normal = readPantryBatch('rice', { name: 'Rice', quantity: 450, unit: 'g', location: 'Pantry' }, CENTRAL);
    assert.deepEqual([normal.needsRepair, normal.repairAmount], [false, null]);
    const emptyLegacy = readPantryBatch('milk', { name: 'Milk', quantity: 0, unit: 'L', location: 'Fridge' }, CENTRAL);
    assert.equal(emptyLegacy.needsRepair, false);
  });

  test('it stays on its tile, is never deleted by the idle cleanup, and is never used or added to', () => {
    const [product] = groupPantryBatches([oversized]);
    assert.equal(product.batches.length, 1);
    assert.equal(product.totalPackages, 0);
    assert.equal(shouldDeleteEmptyBatch({ ...oversized, updatedAtMs: null }, Date.now()), false);
    assert.equal(shouldDeleteEmptyBatch({ ...oversized, updatedAtMs: 0 }, 10 * EMPTY_BATCH_GRACE_MS), false);
    assert.equal(chooseUsedUpBatch([oversized]), undefined);
    assert.equal(usedUpOutcome(product), null);
    assert.equal(chooseAddOneBatch([oversized]), undefined);
    const rice = batch('r', { name: 'Flour', nameKey: 'flour', packages: 2 });
    assert.equal(usedUpOutcome({ batches: [oversized, rice] })?.batch.id, 'r');
    assert.equal(usedUpOutcome({ batches: [oversized, rice] })?.remaining, 1);
    assert.equal(chooseAddOneBatch([oversized, rice])?.id, 'r');
    assert.throws(() => planLegacyUpgrade(oversized, 1), PantryChangeRefused);
    assert.deepEqual(packageChangeRoute(oversized, false), { kind: 'refuse', message: NEEDS_REPAIR_MESSAGE });
  });

  test('nothing merges into it', () => {
    const incoming = { nameKey: 'flour', location: 'Pantry' as const, packageSize: null, unit: 'g' as const, expiryDate: null };
    assert.equal(findPantryMergeTarget([oversized], incoming), undefined);
    assert.equal(decidePantryMerge({ offline: false, targetId: 'flour', stored: { name: 'Flour', quantity: 150_000, unit: 'g', location: 'Pantry' }, incoming }).kind, 'create');
  });

  test('the page skips it in the cleanup timer', () => {
    const client = readFileSync(join(__dirname, '..', '..', 'src', 'components', 'pantry-inventory-client.tsx'), 'utf8');
    assert.match(client, /\.filter\(\(batch\) => batch\.packages <= 0 && !batch\.needsRepair\)/);
  });
});

describe('a legacy batch is upgraded only online, from a fresh read (PR #129 review)', () => {
  const legacy = readPantryBatch('milk', { name: 'Milk', quantity: 2, unit: 'items', location: 'Fridge' }, CENTRAL);

  test('the route: v2 increments (offline too), legacy online in a transaction, legacy offline refused', () => {
    assert.deepEqual(packageChangeRoute(batch('a'), false), { kind: 'increment' });
    assert.deepEqual(packageChangeRoute(batch('a'), true), { kind: 'increment' });
    assert.deepEqual(packageChangeRoute(legacy, false), { kind: 'transaction' });
    assert.deepEqual(packageChangeRoute(legacy, true), { kind: 'refuse', message: LEGACY_OFFLINE_MESSAGE });
    assert.equal(LEGACY_OFFLINE_MESSAGE, 'Connect to update this older item.');
  });

  test('two taps on quantity 2 deduct two: the second upgrade is computed from the re-read document', () => {
    // First device: the transaction reads the legacy doc (2) and upgrades it to 1.
    const first = planLegacyUpgrade(readPantryBatch('milk', { name: 'Milk', quantity: 2, unit: 'items', location: 'Fridge' }, CENTRAL), -1);
    assert.equal(first.fields.packages, 1);
    // Second device: its retry re-reads the now-v2 doc, so it takes the increment route.
    const reread = readPantryBatch('milk', { ...first.fields, updatedAt: null }, CENTRAL);
    assert.equal(reread.legacy, false);
    assert.deepEqual(packageChangeRoute(reread, false), { kind: 'increment' });
    assert.equal(reread.packages - 1, 0);
  });

  test('changePackagesTogether refuses before writing and re-reads legacy documents inside a transaction', () => {
    const writes = readFileSync(join(__dirname, '..', '..', 'src', 'lib', 'shopping', 'pantry-batch-writes.ts'), 'utf8');
    const together = writes.slice(writes.indexOf('export async function changePackagesTogether'), writes.indexOf('export type SaveBatchResult'));
    const refuse = together.indexOf('throw new PantryChangeRefused(refused.message)');
    assert.ok(refuse > 0 && refuse < together.indexOf('writeBatch(db)') && refuse < together.indexOf('runTransaction('));
    assert.match(together, /routes\.every\(\(route\) => route\.kind === 'increment'\)/);
    assert.match(together, /await Promise\.all\(refs\.map\(\(ref\) => transaction\.get\(ref\)\)\)/);
    assert.match(together, /if \(!stored\.legacy && !stored\.needsRepair\) return \(\) => transaction\.update\(refs\[index\], packageChange\(stored, delta, uid\)\);/);
    assert.doesNotMatch(writes, /upgradeLegacyBatch/);
    const client = readFileSync(join(__dirname, '..', '..', 'src', 'components', 'pantry-inventory-client.tsx'), 'utf8');
    assert.doesNotMatch(client, /changePackages\(/);
    assert.match(client, /error instanceof PantryChangeRefused/);
  });
});

describe('a pantry → shopping write refreshes the Lists tab counts (PR #129 review)', () => {
  test('only a write the server confirmed is announced', () => {
    assert.deepEqual(shoppingWriteNotice('h1', 'list-21', 'saved'), { module: 'shopping', householdId: 'h1', listId: 'list-21' });
    for (const state of ['stored-locally', 'sending', 'uncertain', 'failed'] as const) {
      assert.equal(shoppingWriteNotice('h1', 'list-21', state), null, state);
    }
  });

  test('the notice reaches onDataChanged listeners (the fallback counts subscribe to it)', () => {
    const target = new EventTarget();
    const previous = (globalThis as { window?: unknown }).window;
    (globalThis as { window?: unknown }).window = target;
    try {
      const seen: unknown[] = [];
      const stop = onDataChanged('shopping', 'h1', (detail) => seen.push(detail));
      notifyDataChanged(shoppingWriteNotice('h1', 'list-21', 'saved')!);
      notifyDataChanged({ module: 'shopping', householdId: 'other' });
      stop();
      assert.deepEqual(seen, [{ module: 'shopping', householdId: 'h1', listId: 'list-21' }]);
    } finally {
      (globalThis as { window?: unknown }).window = previous;
    }
  });

  test('addToGroceryList goes through the Shopping list save path and announces once the server confirmed', () => {
    const writes = readFileSync(join(__dirname, '..', '..', 'src', 'lib', 'shopping', 'pantry-batch-writes.ts'), 'utf8');
    const add = writes.slice(writes.indexOf('export async function addToGroceryList'));
    assert.match(add, /await addItemsToList\(\{[\s\S]*knownItems: needed,/);
    assert.doesNotMatch(add, /allowMerge: false/);
    assert.doesNotMatch(add, /setDoc\(|mergeIntoNeededItem\(|resolveShoppingCategory/);
    assert.match(add, /outcome\.settled\.then\(\(final\) => announceShoppingWrite\(householdId, list\.id, final\)\)/);
    assert.match(add, /if \(notice\) notifyDataChanged\(notice\);/);
  });
});

describe('editing a batch that needs repair can never store zero stock (PR #129 review)', () => {
  test('a repair edit starts at 1 package with a clean larger-unit size where one exists', () => {
    const grams = readPantryBatch('flour', { name: 'Flour', quantity: 150_000, unit: 'g', location: 'Pantry' }, CENTRAL);
    assert.deepEqual(repairEditPrefill(grams), { packages: 1, unit: 'kg', packageSize: 150 });
    const millilitres = readPantryBatch('water', { name: 'Water', quantity: 150_000, unit: 'ml', location: 'Pantry' }, CENTRAL);
    assert.deepEqual(repairEditPrefill(millilitres), { packages: 1, unit: 'L', packageSize: 150 });
  });

  test('without a clean conversion it keeps the unit, starts at 1 package and leaves the size empty', () => {
    const ounces = readPantryBatch('oats', { name: 'Oats', quantity: 150_000, unit: 'oz', location: 'Pantry' }, CENTRAL);
    assert.deepEqual(repairEditPrefill(ounces), { packages: 1, unit: 'oz', packageSize: null });
    const kilos = readPantryBatch('sand', { name: 'Sand', quantity: 150_000, unit: 'kg', location: 'Pantry' }, CENTRAL);
    assert.deepEqual(repairEditPrefill(kilos), { packages: 1, unit: 'kg', packageSize: null });
    assert.deepEqual(repairEditPrefill({ unit: 'g', repairAmount: 200_000_000 }), { packages: 1, unit: 'g', packageSize: null });
  });

  test('saving a repair edit is refused at 0 packages or without a valid size', () => {
    assert.deepEqual(repairEditError({ packages: 0, unit: 'kg', packageSize: '150' }), { field: 'packages', message: REPAIR_PACKAGES_MESSAGE });
    assert.deepEqual(repairEditError({ packages: 1, unit: 'oz', packageSize: '' }), { field: 'packageSize', message: REPAIR_SIZE_MESSAGE });
    assert.deepEqual(repairEditError({ packages: 1, unit: 'g', packageSize: '150000' }), { field: 'packageSize', message: REPAIR_SIZE_MESSAGE });
    assert.deepEqual(repairEditError({ packages: 1, unit: 'g', packageSize: '0' }), { field: 'packageSize', message: REPAIR_SIZE_MESSAGE });
    assert.equal(repairEditError({ packages: 1, unit: 'kg', packageSize: '150' }), null);
    assert.equal(repairEditError({ packages: 3, unit: 'items', packageSize: '' }), null);
  });

  test('the edit dialog uses the prefill and refuses an invalid repair save inline', () => {
    const client = readFileSync(join(process.cwd(), 'src/components/pantry-inventory-client.tsx'), 'utf8');
    assert.match(client, /itemToEdit\.needsRepair \? repairEditPrefill\(itemToEdit\) : itemToEdit/);
    assert.match(client, /itemToEdit\?\.needsRepair \? repairEditError\(data\) : null;\s+if \(repairProblem\) \{\s+form\.setError\(repairProblem\.field/);
  });
});
