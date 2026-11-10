import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  initialCategory,
  localCategoryFor,
  matchListCategory,
  rememberedCategories,
  shouldApplyLateCategory,
} from '../../src/lib/shopping/local-categories';
import { DEFAULT_SHOPPING_CATEGORIES } from '../../src/lib/shopping-items';

const defaults = DEFAULT_SHOPPING_CATEGORIES;

describe('local category map (QA-6 / SH-16a)', () => {
  test('common names map to the default departments, plural or singular', () => {
    const cases: Array<[string, string]> = [
      ['Milk', 'Dairy'], ['eggs', 'Dairy'], ['Greek yogurt', 'Dairy'],
      ['Bananas', 'Produce'], ['tomatoes', 'Produce'], ['Strawberries', 'Produce'],
      ['Chicken thighs', 'Meat'], ['Sourdough bread', 'Bakery'], ['ice cream', 'Frozen'],
      ['Rice', 'Pantry'], ['coconut milk', 'Pantry'], ['Peanut butter', 'Pantry'],
      ['Chocolate cookies', 'Snacks'], ['Orange juice', 'Drinks'], ['Toilet paper', 'Household'],
      ['Dish soap', 'Household'],
    ];
    for (const [name, category] of cases) assert.equal(localCategoryFor(name, defaults), category, name);
  });

  test('unknown names and categories the list does not have give nothing', () => {
    assert.equal(localCategoryFor('Zorblax', defaults), undefined);
    assert.equal(localCategoryFor('Milk', ['Produce', 'Other']), undefined);
    // Word matches only: "rice" is not inside "price tag".
    assert.equal(localCategoryFor('Price tag', defaults), undefined);
    // The list's own spelling is used.
    assert.equal(localCategoryFor('milk', ['dairy', 'Other']), 'dairy');
    assert.equal(matchListCategory(' DAIRY ', ['Dairy']), 'Dairy');
  });

  test('remembered categories come from chosen categories only', () => {
    const remembered = rememberedCategories([
      { name: 'Oat milk', category: 'Drinks', categorySource: 'manual' },
      { name: 'Tofu', category: 'Produce' },
      { name: 'Mystery', category: 'Other' },
      { name: 'Guess', category: 'Pantry', categorySource: 'local' },
      { name: 'Pending', category: 'Other', categorySource: 'pending' },
      { name: 'Kimchi', category: 'Produce', categorySource: 'ai', nameKey: 'kimchi' },
    ]);
    assert.equal(remembered.get('oat milk'), 'Drinks');
    assert.equal(remembered.get('tofu'), 'Produce');
    assert.equal(remembered.get('kimchi'), 'Produce');
    assert.equal(remembered.has('mystery'), false);
    assert.equal(remembered.has('guess'), false);
    assert.equal(remembered.has('pending'), false);
  });

  test('initial category: manual, then remembered, then local, then pending or fallback', () => {
    const remembered = new Map([['oat milk', 'Drinks']]);
    assert.deepEqual(initialCategory({ name: 'Milk', categories: defaults, selectedCategory: 'Snacks', remembered, aiAvailable: true }),
      { category: 'Snacks', categorySource: 'manual' });
    assert.deepEqual(initialCategory({ name: 'Oat Milk', categories: defaults, remembered, aiAvailable: true }),
      { category: 'Drinks', categorySource: 'remembered' });
    assert.deepEqual(initialCategory({ name: 'Milk', categories: defaults, remembered, aiAvailable: true }),
      { category: 'Dairy', categorySource: 'local' });
    assert.deepEqual(initialCategory({ name: 'Zorblax', categories: defaults, aiAvailable: true }),
      { category: 'Other', categorySource: 'pending' });
    assert.deepEqual(initialCategory({ name: 'Zorblax', categories: defaults, aiAvailable: false }),
      { category: 'Other', categorySource: 'fallback' });
    // A remembered category the list no longer has is skipped.
    assert.deepEqual(initialCategory({ name: 'Oat milk', categories: ['Dairy', 'Other'], remembered, aiAvailable: true }),
      { category: 'Dairy', categorySource: 'local' });
  });
});

describe('late AI guard (SH-16c)', () => {
  const target = { householdId: 'h1', listId: 'groceries' };
  const base = {
    item: { name: 'Zorblax', nameKey: 'zorblax', category: 'Other', categorySource: 'pending' },
    listExists: true,
    expectedNameKey: 'zorblax',
    aiCategory: 'Pantry',
    categories: defaults,
    target,
    active: { householdId: 'h1', listId: 'groceries' },
  };

  test('applies to an unchanged pending (or local) item on the active list', () => {
    assert.equal(shouldApplyLateCategory(base), true);
    assert.equal(shouldApplyLateCategory({ ...base, item: { ...base.item, categorySource: 'local' } }), true);
  });

  test('never overwrites a choice, a rename, another list or household, or a deleted list or item', () => {
    for (const source of ['manual', 'remembered', 'ai', 'fallback']) {
      assert.equal(shouldApplyLateCategory({ ...base, item: { ...base.item, categorySource: source } }), false, source);
    }
    assert.equal(shouldApplyLateCategory({ ...base, item: { ...base.item, categorySource: null } }), false, 'legacy item');
    assert.equal(shouldApplyLateCategory({ ...base, item: { ...base.item, name: 'Zorblax bars', nameKey: 'zorblax bars' } }), false, 'renamed');
    assert.equal(shouldApplyLateCategory({ ...base, active: { householdId: 'h1', listId: 'hardware' } }), false, 'another list is open');
    assert.equal(shouldApplyLateCategory({ ...base, active: { householdId: 'h2', listId: 'groceries' } }), false, 'household switched');
    assert.equal(shouldApplyLateCategory({ ...base, active: null }), false, 'signed out');
    assert.equal(shouldApplyLateCategory({ ...base, listExists: false }), false, 'list deleted');
    assert.equal(shouldApplyLateCategory({ ...base, item: undefined }), false, 'item deleted');
    assert.equal(shouldApplyLateCategory({ ...base, aiCategory: 'Not a category' }), false, 'answer outside the list');
  });

  test('an item without nameKey (older client) is compared by its name', () => {
    assert.equal(shouldApplyLateCategory({ ...base, item: { name: ' zorblax ', category: 'Other', categorySource: 'pending' } }), true);
  });
});
