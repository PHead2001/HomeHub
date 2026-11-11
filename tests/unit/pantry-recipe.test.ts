import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { groupPantryBatches, RECIPE_MAX_ITEMS, usableRecipeItems, type PantryBatch } from '../../src/lib/shopping/pantry-batches';
import {
  cleanRecipeText,
  isMissingAdded,
  normalizeRecipeIngredients,
  planMissingAdds,
  recipeProductKeys,
  summarizeMissingAdds,
  RECIPE_NEEDED_MAX,
} from '../../src/lib/shopping/recipe';

const batch = (id: string, overrides: Partial<PantryBatch> = {}): PantryBatch => ({
  id, name: 'Rice', nameKey: 'rice', location: 'Pantry', unit: 'g', packages: 1, packageSize: 450,
  expiryDate: null, barcode: null, legacy: false, needsRepair: false, repairAmount: null, updatedAtMs: null, ...overrides,
});
const today = '2026-11-10';
const named = (name: string, overrides: Partial<PantryBatch> = {}) =>
  batch(name.toLowerCase(), { name, nameKey: name.toLowerCase(), unit: 'items', packageSize: null, packages: 1, ...overrides });

describe('recipe input: usable stock, soonest expiry first (SH-31a)', () => {
  test('lines are ordered by their soonest expiry, undated last, and carry the date and the days left', () => {
    const products = groupPantryBatches([
      named('Apples', { expiryDate: '2026-11-20' }),
      named('Beans'),
      named('Cream', { expiryDate: '2026-11-11' }),
      named('Dates', { expiryDate: '2026-11-10' }),
    ]);
    assert.deepEqual(usableRecipeItems(products, today).map((item) => [item.name, item.expiresOn, item.expiresInDays]), [
      ['Dates', '2026-11-10', 0],
      ['Cream', '2026-11-11', 1],
      ['Apples', '2026-11-20', 10],
      ['Beans', null, null],
    ]);
  });

  test('a product line carries the soonest expiry of its usable batches; expired ones neither count nor date it', () => {
    const products = groupPantryBatches([
      named('Milk', { id: 'old', expiryDate: '2026-11-09', packages: 2 }),
      named('Milk', { id: 'soon', expiryDate: '2026-11-12', packages: 1 }),
      named('Milk', { id: 'later', expiryDate: '2026-11-30', packages: 3 }),
    ]);
    assert.deepEqual(usableRecipeItems(products, today), [
      { name: 'Milk', quantity: 4, unit: 'items', expiresOn: '2026-11-12', expiresInDays: 2 },
    ]);
  });

  test('used-up, needs-repair and expired batches are left out; a batch expiring today is offered', () => {
    const products = groupPantryBatches([
      named('Empty', { packages: 0 }),
      batch('repair', { name: 'Flour', nameKey: 'flour', packages: 0, packageSize: null, needsRepair: true, repairAmount: 150_000 }),
      named('Expired', { expiryDate: '2026-11-09' }),
      named('Today', { expiryDate: '2026-11-10' }),
      named('Fresh'),
    ]);
    assert.deepEqual(usableRecipeItems(products, today).map((item) => item.name), ['Today', 'Fresh']);
  });

  test('a measured product keeps the soonest expiry when kg is restated in g and joined to a g line', () => {
    const products = groupPantryBatches([
      batch('a', { name: 'Salt', nameKey: 'salt', unit: 'kg', packages: 1, packageSize: 0.25, expiryDate: '2026-12-01' }),
      batch('b', { name: 'Salt', nameKey: 'salt', unit: 'g', packages: 1, packageSize: 100, expiryDate: '2026-11-15' }),
    ]);
    assert.deepEqual(usableRecipeItems(products, today), [
      { name: 'Salt', quantity: 350, unit: 'g', expiresOn: '2026-11-15', expiresInDays: 5 },
    ]);
  });

  test('more than 60 lines: the soonest-expiring 60 are sent and the flow accepts them', async () => {
    const { GenerateRecipeInputSchema } = await import('../../src/ai/tasks/generate-recipe');
    const batches = Array.from({ length: 70 }, (_, index) => named(`Item ${String(index).padStart(2, '0')}`, {
      // Items 60-69 expire soonest; items 0-9 have no date.
      expiryDate: index < 10 ? null : new Date(Date.UTC(2026, 10, 11 + (69 - index))).toISOString().slice(0, 10),
    }));
    const items = usableRecipeItems(groupPantryBatches(batches), today);
    assert.equal(items.length, RECIPE_MAX_ITEMS);
    assert.equal(items[0].name, 'Item 69');
    assert.equal(items.filter((item) => item.expiresOn === null).length, 0);
    assert.equal(GenerateRecipeInputSchema.safeParse({ items }).success, true);
  });

  test('an older page\'s request without expiry fields is still accepted', async () => {
    const { GenerateRecipeInputSchema } = await import('../../src/ai/tasks/generate-recipe');
    assert.equal(GenerateRecipeInputSchema.safeParse({ items: [
      { name: 'Rice', quantity: 1, unit: 'cup' }, { name: 'Beans', quantity: 1, unit: 'can' },
    ] }).success, true);
    assert.equal(GenerateRecipeInputSchema.safeParse({ items: [
      { name: 'Rice', quantity: 1, unit: 'cup', expiresOn: '11/10/2026', expiresInDays: 0 }, { name: 'Beans', quantity: 1, unit: 'can' },
    ] }).success, false, 'only a date-only day is accepted');
  });
});

describe('recipe output is normalised against the stock sent (model untrusted)', () => {
  const stock = [{ name: 'Jasmine rice' }, { name: 'Greek yogurt' }, { name: 'Greek yogurt' }];

  test('pantry claims must name supplied stock; others become missing; supplied names under needed move to used', () => {
    const result = normalizeRecipeIngredients({
      used: [
        { pantryItem: '  jasmine   RICE ', line: '2 cups rice' },
        { pantryItem: 'Chicken thighs', line: '500 g chicken' },
      ],
      needed: [
        { name: 'Greek Yogurt', line: '1 cup yogurt' },
        { name: 'Salt', line: '1 tsp salt' },
      ],
    }, stock);
    assert.deepEqual(result, {
      used: [
        { pantryItem: 'Jasmine rice', line: '2 cups rice' },
        { pantryItem: 'Greek yogurt', line: '1 cup yogurt' },
      ],
      needed: [
        { name: 'Chicken thighs', line: '500 g chicken' },
        { name: 'Salt', line: '1 tsp salt' },
      ],
    });
  });

  test('each name appears once (used wins), blank entries are dropped, and the lists stay within bounds', () => {
    const result = normalizeRecipeIngredients({
      used: [{ pantryItem: 'Jasmine rice', line: 'rice' }, { pantryItem: 'jasmine rice', line: 'more rice' }],
      needed: [
        { name: 'Jasmine Rice', line: 'rice again' },
        { name: '   ', line: 'nothing' },
        { name: 'Salt', line: '  ' },
        { name: 'salt', line: 'salt twice' },
        ...Array.from({ length: 40 }, (_, index) => ({ name: `Spice ${index}`, line: `Spice ${index}` })),
      ],
    }, stock);
    assert.deepEqual(result.used, [{ pantryItem: 'Jasmine rice', line: 'rice' }]);
    assert.deepEqual(result.needed[0], { name: 'Salt', line: 'Salt' });
    assert.equal(result.needed.length, RECIPE_NEEDED_MAX);
  });

  test('names are cut to 120 characters without splitting a character', () => {
    const long = `${'é'.repeat(119)}😀😀`;
    assert.equal(Array.from(cleanRecipeText(long, 120)).length, 120);
    assert.ok(cleanRecipeText(long, 120).endsWith('😀'));
  });

  test('the recipe lifts every shelf\'s tile of a used name, and only exact names', () => {
    const products = groupPantryBatches([
      named('Rice', { location: 'Pantry' }),
      named('Rice', { id: 'rice-fridge', location: 'Fridge' }),
      named('Rice noodles'),
    ]);
    assert.deepEqual(recipeProductKeys([{ pantryItem: 'Rice', line: '1 cup rice' }], products).sort(), ['rice|Fridge', 'rice|Pantry']);
  });

  test('the flow normalises the model output before returning it', () => {
    const task = readFileSync(join(__dirname, '..', '..', 'src', 'ai', 'tasks', 'generate-recipe.ts'), 'utf8');
    assert.match(task, /ingredients: normalizeRecipeIngredients\(result\.output\.ingredients, input\.items\)/);
  });
});

describe('missing ingredients onto the Grocery list (SH-22c/d, SH-31b)', () => {
  const needed = [
    { name: 'Salt', line: '1 tsp salt' },
    { name: 'Pepper', line: 'pepper' },
    { name: 'Cooking oil', line: '2 tbsp oil' },
    { name: 'Basil', line: 'basil' },
  ];

  test('"Add all missing" writes every name not yet added or being added; a failed one is tried again', () => {
    assert.deepEqual(planMissingAdds(needed, {}), ['Salt', 'Pepper', 'Cooking oil', 'Basil']);
    assert.deepEqual(planMissingAdds(needed, { salt: 'saved', pepper: 'saving', 'cooking oil': 'failed', basil: 'stored-locally' }), ['Cooking oil']);
    assert.deepEqual(planMissingAdds(needed, { salt: 'sending', pepper: 'uncertain', 'cooking oil': 'saved', basil: 'saved' }), []);
    assert.deepEqual(planMissingAdds([{ name: 'Salt', line: 'a' }, { name: 'SALT', line: 'b' }], {}), ['Salt']);
  });

  test('added states', () => {
    assert.equal(isMissingAdded('saved'), true);
    assert.equal(isMissingAdded('stored-locally'), true);
    assert.equal(isMissingAdded('sending'), true);
    assert.equal(isMissingAdded('failed'), false);
    assert.equal(isMissingAdded('idle'), false);
    assert.equal(isMissingAdded(undefined), false);
  });

  test('one summary: added, merged into a needed item, and failures by name', () => {
    assert.deepEqual(summarizeMissingAdds([
      { name: 'Salt', state: 'saved', merged: false },
      { name: 'Pepper', state: 'saved', merged: true },
    ], 'Groceries'), {
      title: 'Missing ingredients added',
      description: '2 ingredients are on Groceries (Pepper already needed, now one more).',
      failed: false,
    });
    const partial = summarizeMissingAdds([
      { name: 'Salt', state: 'saved', merged: false },
      { name: 'Pepper', state: 'failed', merged: false },
      { name: 'Basil', state: 'failed', merged: false },
    ], 'Groceries');
    assert.equal(partial.title, 'Some ingredients were not added');
    assert.equal(partial.description, '1 ingredient is on Groceries. Could not add Pepper and Basil. Try again.');
    assert.equal(partial.failed, true);
    assert.equal(summarizeMissingAdds([{ name: 'Salt', state: 'failed', merged: false }], 'Groceries').title, 'Could not add the missing ingredients');
  });

  test('only what is known: saved on this device, or still sending', () => {
    assert.deepEqual(summarizeMissingAdds([
      { name: 'Salt', state: 'stored-locally', merged: false },
      { name: 'Pepper', state: 'stored-locally', merged: false },
    ], 'Groceries'), {
      title: 'Saved, will sync',
      description: 'Salt and Pepper saved on this device; will sync when the connection is back.',
      failed: false,
    });
    const sending = summarizeMissingAdds([{ name: 'Salt', state: 'sending', merged: false }], 'Groceries');
    assert.equal(sending.title, 'Still sending…');
    assert.match(sending.description, /Salt not confirmed yet/);
  });

  test('"Add all missing" is one action through the Shopping list save path, merged, with one categorization call', () => {
    const writes = readFileSync(join(__dirname, '..', '..', 'src', 'lib', 'shopping', 'pantry-batch-writes.ts'), 'utf8');
    const addAll = writes.slice(writes.indexOf('export async function addAllToGroceryList'));
    assert.match(addAll, /await addItemsToList\(\{[\s\S]*entries,[\s\S]*knownItems: needed,/);
    assert.doesNotMatch(addAll, /allowMerge: false/);
    assert.match(addAll, /announceShoppingWrite\(householdId, list\.id, final\)/);
    // The single "+" uses the same path.
    const addOne = writes.slice(writes.indexOf('export async function addToGroceryList'), writes.indexOf('export type AddAllToListResult'));
    assert.match(addOne, /await addAllToGroceryList\(/);
  });

  test('the recipe card disables adds without shopping.edit and uses 48 px targets on coarse pointers', () => {
    const card = readFileSync(join(__dirname, '..', '..', 'src', 'components', 'shopping', 'recipe-ingredients.tsx'), 'utf8');
    assert.match(card, /\[@media\(pointer:coarse\)\]:h-12 \[@media\(pointer:coarse\)\]:min-w-12/);
    assert.equal((card.match(/disabled=\{!canEdit \|\|/g) ?? []).length, 2);
    assert.match(card, /addAllToGroceryList\(\{/);
    assert.match(card, /addToGroceryList\(\{/);
  });
});
