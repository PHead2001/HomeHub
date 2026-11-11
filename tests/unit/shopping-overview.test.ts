import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  RECENT_GROCERY_KEY,
  SHOPPING_WINDOW_MS,
  chooseOverviewList,
  expiringChips,
  expiryWhen,
  groceryListsOf,
  neededAisleGroups,
  neededEmptyCopy,
  preferencesKnown,
  readRecentGrocery,
  rememberRecentGrocery,
  shoppingActivity,
} from '../../src/lib/shopping/overview';
import { readCategoryConfig } from '../../src/lib/shopping/category-order';
import { DEFAULT_SHOPPING_CATEGORIES } from '../../src/lib/shopping-items';
import { quickAddDecision } from '../../src/lib/shopping/live-state';

const weekly = { id: 'weekly', type: 'Grocery' as const };
const costco = { id: 'costco', type: 'Grocery' as const };
const hardware = { id: 'hardware', type: 'Hardware' as const };

describe('overview: which Grocery list it shows (SH-11a)', () => {
  test('only Grocery lists count', () => {
    assert.deepEqual(groceryListsOf([hardware, weekly, costco]).map((list) => list.id), ['weekly', 'costco']);
  });

  test('no Grocery list: nothing, and nothing to wait for', () => {
    assert.deepEqual(chooseOverviewList({ lists: [hardware], defaultListId: null, defaultKnown: false }), { list: null, groceries: [], waiting: false });
  });

  test('the only Grocery list is shown at once, whatever the default says', () => {
    assert.equal(chooseOverviewList({ lists: [hardware, weekly], defaultListId: 'hardware', defaultKnown: false }).list, weekly);
    assert.equal(chooseOverviewList({ lists: [weekly], defaultListId: 'gone', defaultKnown: true }).list, weekly);
  });

  test('several: the household default while it is still a Grocery list', () => {
    const choice = chooseOverviewList({ lists: [costco, hardware, weekly], defaultListId: 'weekly', defaultKnown: true, recentId: 'costco' });
    assert.equal(choice.list, weekly);
    assert.equal(choice.groceries.length, 2);
  });

  test('a default that is no longer a Grocery list (or gone) falls back to the most recently used, then the first', () => {
    assert.equal(chooseOverviewList({ lists: [costco, hardware, weekly], defaultListId: 'hardware', defaultKnown: true, recentId: 'weekly' }).list, weekly);
    assert.equal(chooseOverviewList({ lists: [costco, weekly], defaultListId: 'gone', defaultKnown: true, recentId: null }).list, costco);
    assert.equal(chooseOverviewList({ lists: [costco, weekly], defaultListId: null, defaultKnown: true, recentId: 'deleted' }).list, costco);
  });

  test('while the default is unknown nothing is chosen, unless the member picked one', () => {
    assert.deepEqual(chooseOverviewList({ lists: [costco, weekly], defaultListId: null, defaultKnown: false, recentId: 'weekly' }).list, null);
    assert.equal(chooseOverviewList({ lists: [costco, weekly], defaultListId: null, defaultKnown: false }).waiting, true);
    assert.equal(chooseOverviewList({ lists: [costco, weekly], defaultListId: 'weekly', defaultKnown: true, pickedId: 'costco' }).list, costco);
    // A pick of a list that is no longer a Grocery list is ignored.
    assert.equal(chooseOverviewList({ lists: [costco, weekly, hardware], defaultListId: 'weekly', defaultKnown: true, pickedId: 'hardware' }).list, weekly);
  });

  test('the default is known from the server, a cached default, offline, or a failed listener', () => {
    assert.equal(preferencesKnown({ status: 'loading', fromCache: false, offline: false, defaultListId: null }), false);
    assert.equal(preferencesKnown({ status: 'ready', fromCache: true, offline: false, defaultListId: null }), false);
    assert.equal(preferencesKnown({ status: 'ready', fromCache: true, offline: false, defaultListId: 'weekly' }), true);
    assert.equal(preferencesKnown({ status: 'ready', fromCache: true, offline: true, defaultListId: null }), true);
    assert.equal(preferencesKnown({ status: 'ready', fromCache: false, offline: false, defaultListId: null }), true);
    assert.equal(preferencesKnown({ status: 'error', fromCache: true, offline: false, defaultListId: null }), true);
  });
});

describe('overview: the most recently used Grocery list on this device', () => {
  const memory = () => {
    const data = new Map<string, string>();
    return { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => void data.set(key, value), data };
  };

  test('remembered per household', () => {
    const storage = memory();
    rememberRecentGrocery(storage, 'house-a', 'weekly');
    rememberRecentGrocery(storage, 'house-b', 'costco');
    assert.equal(readRecentGrocery(storage, 'house-a'), 'weekly');
    assert.equal(readRecentGrocery(storage, 'house-b'), 'costco');
    assert.equal(readRecentGrocery(storage, 'house-c'), null);
  });

  test('blocked or corrupt storage reads as nothing and never throws', () => {
    const throwing = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
    assert.equal(readRecentGrocery(throwing, 'house-a'), null);
    assert.doesNotThrow(() => rememberRecentGrocery(throwing, 'house-a', 'weekly'));
    const storage = memory();
    storage.data.set(RECENT_GROCERY_KEY, '{not json');
    assert.equal(readRecentGrocery(storage, 'house-a'), null);
    rememberRecentGrocery(storage, 'house-a', 'weekly');
    assert.equal(readRecentGrocery(storage, 'house-a'), 'weekly');
    assert.equal(readRecentGrocery(null, 'house-a'), null);
  });
});

describe('overview: needed items by aisle, as the open list groups them', () => {
  const item = (id: string, name: string, category: string, status: 'needed' | 'purchased' = 'needed') => ({ id, name, category, status });
  const items = [
    item('m', 'Milk', 'Dairy'),
    item('b', 'Bread', 'Bakery'),
    item('a', 'Apples', 'Produce'),
    item('x', 'Batteries', 'Other'),
    item('c', 'Cheese', 'dairy'),
    item('t', 'Tea', 'Drinks', 'purchased'),
  ];

  test('purchased items are left out; without an order, the supermarket walk', () => {
    const config = readCategoryConfig(null, false, DEFAULT_SHOPPING_CATEGORIES);
    const groups = neededAisleGroups(items, config, null);
    assert.deepEqual(groups.map((group) => group.category), ['Produce', 'Bakery', 'Dairy', 'Other']);
    assert.deepEqual(groups.find((group) => group.category === 'Dairy')!.items.map((entry) => entry.name), ['Cheese', 'Milk']);
  });

  test("the list's own order once it was edited", () => {
    const config = readCategoryConfig({ list: ['Dairy', 'Produce', 'Bakery', 'Other'], ordered: ['Dairy', 'Bakery', 'Produce', 'Other'] }, true, DEFAULT_SHOPPING_CATEGORIES);
    assert.deepEqual(neededAisleGroups(items, config, null).map((group) => group.category), ['Dairy', 'Bakery', 'Produce', 'Other']);
  });

  test("the store's aisle order when the list is at a store", () => {
    const config = readCategoryConfig({ list: ['Dairy', 'Produce', 'Bakery', 'Other'] }, true, DEFAULT_SHOPPING_CATEGORIES);
    const store = { aisleOrder: ['Bakery', 'Dairy', 'Produce'] };
    assert.deepEqual(neededAisleGroups(items, config, store).map((group) => group.category), ['Bakery', 'Dairy', 'Produce', 'Other']);
  });
});

describe('overview: the empty Needed message (SH-10g)', () => {
  test('one message each, never "empty" and "in the cart" together', () => {
    const viewerEmpty = neededEmptyCopy({ total: 0, canEdit: false });
    assert.equal(viewerEmpty.title, 'This list is empty');
    assert.doesNotMatch(viewerEmpty.description, /cart/);
    const viewerDone = neededEmptyCopy({ total: 3, canEdit: false });
    assert.equal(viewerDone.title, 'Nothing left to buy');
    assert.match(viewerDone.description, /in the cart/);
    assert.equal(neededEmptyCopy({ total: 0, canEdit: true }).title, 'This list is empty');
    assert.doesNotMatch(neededEmptyCopy({ total: 0, canEdit: true }).description, /cart/);
  });
});

describe('overview: "Alex is shopping · 7 left" (SH-28c)', () => {
  const now = Date.parse('2026-11-11T18:00:00Z');
  const names = new Map([['alex', 'Alex'], ['sam', 'Sam']]);
  const tick = (by: string, minutesAgo: number, opId = `${by}-${minutesAgo}`) => ({
    status: 'purchased' as const,
    purchasedByUid: by,
    purchasedAt: { toMillis: () => now - minutesAgo * 60_000 },
    purchaseOpId: opId,
  });
  const needed = (count: number) => Array.from({ length: count }, () => ({ status: 'needed' as const }));
  const base = { now, uid: 'me', localOpIds: new Set<string>(), names };

  test('two recent ticks by another member: they are shopping, with what is left', () => {
    const activity = shoppingActivity({ ...base, items: [tick('alex', 1), tick('alex', 4), ...needed(7)] });
    assert.deepEqual(activity, { shopperUids: ['alex'], left: 7, label: 'Alex is shopping · 7 left' });
  });

  test('one tick is not a trip; ticks older than the window do not count', () => {
    assert.equal(shoppingActivity({ ...base, items: [tick('alex', 1), ...needed(2)] }), null);
    assert.equal(shoppingActivity({ ...base, items: [tick('alex', 11), tick('alex', 30), ...needed(2)] }), null);
    assert.equal(SHOPPING_WINDOW_MS, 10 * 60_000);
  });

  test('ticks made on this device never count; the same member on another device is "You"', () => {
    const local = new Set(['me-1', 'me-2']);
    assert.equal(shoppingActivity({ ...base, localOpIds: local, items: [tick('me', 1), tick('me', 2), ...needed(1)] }), null);
    assert.equal(
      shoppingActivity({ ...base, items: [tick('me', 1), tick('me', 2), ...needed(1)] })?.label,
      'You are shopping on another device · 1 left',
    );
  });

  test('ticks not yet acknowledged (no purchasedAt) and un-ticked items do not count', () => {
    const pending = { status: 'purchased' as const, purchasedByUid: 'alex', purchasedAt: null, purchaseOpId: 'p' };
    assert.equal(shoppingActivity({ ...base, items: [pending, tick('alex', 1), ...needed(1)] }), null);
    const unticked = { status: 'needed' as const, purchasedByUid: null, purchasedAt: null };
    assert.equal(shoppingActivity({ ...base, items: [unticked, tick('alex', 1)] }), null);
  });

  test('a clock slightly behind the server still counts; far off does not', () => {
    assert.ok(shoppingActivity({ ...base, items: [tick('alex', -2), tick('alex', -1)] }));
    assert.equal(shoppingActivity({ ...base, items: [tick('alex', -20), tick('alex', -30)] }), null);
  });

  test('two shoppers, most recent first; an unknown member is "Someone"; all bought', () => {
    const activity = shoppingActivity({ ...base, items: [tick('sam', 8), tick('sam', 7), tick('alex', 1), tick('alex', 2), tick('zed', 3), tick('zed', 4)] });
    assert.deepEqual(activity?.shopperUids, ['alex', 'zed', 'sam']);
    assert.equal(activity?.label, 'Alex, Someone and Sam are shopping · all in the cart');
  });
});

describe('overview: expiring pantry chips (SH-11c)', () => {
  const pantry = [
    { id: 'yogurt', name: 'Greek yogurt', expiryDate: '2026-11-13' },
    { id: 'milk', name: 'Milk', expiryDate: '2026-11-11' },
    { id: 'old', name: 'Old cheese', expiryDate: '2026-11-09' },
    { id: 'rice', name: 'Rice', expiryDate: '2027-02-01' },
    { id: 'none', name: 'Salt', expiryDate: null },
    { id: 'bread', name: 'Bread', expiryDate: '2026-11-14' },
    { id: 'eggs', name: 'Eggs', expiryDate: '2026-11-15' },
  ];

  test('expired and within three days of the household today, soonest first, with when', () => {
    const { chips, more } = expiringChips(pantry, '2026-11-11');
    assert.deepEqual(chips.map((chip) => [chip.id, chip.when]), [
      ['old', 'expired'],
      ['milk', 'today'],
      ['yogurt', 'in 2 days'],
      ['bread', 'in 3 days'],
    ]);
    assert.equal(more, 0);
  });

  test('the household day decides, not the device day', () => {
    assert.deepEqual(expiringChips(pantry, '2026-11-12').chips.map((chip) => chip.id), ['old', 'milk', 'yogurt', 'bread', 'eggs']);
  });

  test('capped, with the rest counted; a missing name and a bad day are safe', () => {
    const { chips, more } = expiringChips(pantry, '2026-11-11', { limit: 2 });
    assert.equal(chips.length, 2);
    assert.equal(more, 2);
    assert.equal(expiringChips([{ id: 'x', expiryDate: '2026-11-11' }], '2026-11-11').chips[0].name, 'Pantry item');
    assert.deepEqual(expiringChips(pantry, 'not a day'), { chips: [], more: 0 });
  });

  test('when labels', () => {
    assert.equal(expiryWhen(-3), 'expired');
    assert.equal(expiryWhen(0), 'today');
    assert.equal(expiryWhen(1), 'tomorrow');
    assert.equal(expiryWhen(5), 'in 5 days');
  });
});

describe('quick-add shortcut is never a silent no-op (SH-10h)', () => {
  test('no lists: empty (the screen offers a Groceries list); a viewer: read-only', () => {
    assert.deepEqual(quickAddDecision({ requested: true, confirmed: true, canEdit: true, lists: [] }), { kind: 'empty' });
    assert.deepEqual(quickAddDecision({ requested: true, confirmed: true, canEdit: false, lists: [] }), { kind: 'read-only' });
  });
});
