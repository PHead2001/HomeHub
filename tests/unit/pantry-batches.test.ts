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
  upgradeLegacyBatch,
  usableRecipeItems,
  usedUpOutcome,
  type PantryBatch,
} from '../../src/lib/shopping/pantry-batches';
import { daysUntilExpiry, expiryState, pantryLocationForCategory, pantryMergeStillValid, planPantryHandoff } from '../../src/lib/shopping/pantry';
import { MAX_PACKAGES, fillBatch, packageChangeToast, roundAmount, splitPackages } from '../../src/lib/shopping/pantry-batches';

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
    assert.match(client, /if \(reachedZero && request === promptRequestRef\.current\) setAskAdd\(/);
    const writes = readFileSync(join(__dirname, '..', '..', 'src', 'lib', 'shopping', 'pantry-batch-writes.ts'), 'utf8');
    assert.match(writes, /findMergeTarget\(needed, name\)/);
    assert.match(writes, /mergeIntoNeededItem\(doc\(itemsRef, target\.id\), quantity\)/);
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
    assert.match(handoff, /upgradeLegacyBatch\(batch, toTarget\), \.\.\.stamp\(\)/);
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
    const together = writes.slice(writes.indexOf('export function changePackagesTogether'), writes.indexOf('export type SaveBatchResult'));
    assert.match(together, /const batch = writeBatch\(db\);/);
    assert.match(together, /batch\.commit\(\)/);
    const apply = client.slice(client.indexOf('const applyChanges'), client.indexOf('// SH-22a / SH-29a'));
    assert.match(apply, /await changePackagesTogether\(householdId, changes, uid, onError\);/);
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
    assert.match(client, /outcome = await changePackagesTogether\(householdId, changes, uid, onError\);/);
    assert.match(client, /const shown = packageChangeToast\(outcome, title, description\);\s*if \(shown\.offerUndo\) \{/);
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
