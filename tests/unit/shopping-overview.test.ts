import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  RECENT_GROCERY_KEY,
  SHOPPING_WINDOW_MS,
  chooseOverviewList,
  LOCAL_TICKS_KEEP_MS,
  LOCAL_TICKS_KEY,
  expiringChips,
  expiryWhen,
  overviewWriteReady,
  writeWait,
  writeWaitText,
  readLocalTicks,
  recordLocalTick,
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
import { errorToState, loadingState, quickAddDecision, snapshotToState } from '../../src/lib/shopping/live-state';

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

describe('overview: expiring pantry chips on Pantry v2 batches (SH-11c)', () => {
  const batch = (id: string, name: string, expiryDate: string | null, packages = 1, location = 'Fridge') =>
    ({ id, name, location, unit: 'items', packages, packageSize: null, expiryDate, schemaVersion: 2 });
  const pantry = [
    batch('yogurt', 'Greek yogurt', '2026-11-13'),
    batch('milk', 'Milk', '2026-11-11'),
    batch('old', 'Old cheese', '2026-11-09'),
    batch('rice', 'Rice', '2027-02-01', 2, 'Pantry'),
    batch('salt', 'Salt', null, 1, 'Pantry'),
    batch('bread', 'Bread', '2026-11-14', 1, 'Pantry'),
    batch('eggs', 'Eggs', '2026-11-15'),
  ];

  test('expired and within three days of the household today, soonest first, with when', () => {
    const { chips, more } = expiringChips(pantry, '2026-11-11', { timeZone: 'America/Chicago' });
    assert.deepEqual(chips.map((chip) => [chip.id, chip.when]), [
      ['old', 'expired'],
      ['milk', 'today'],
      ['yogurt', 'in 2 days'],
      ['bread', 'in 3 days'],
    ]);
    assert.equal(more, 0);
  });

  test('the household day decides', () => {
    assert.deepEqual(expiringChips(pantry, '2026-11-12', { timeZone: 'America/Chicago' }).chips.map((chip) => chip.id), ['old', 'milk', 'yogurt', 'bread', 'eggs']);
  });

  test('one chip per product, for its soonest batch with packages left; that batch is the one opened', () => {
    const items = [
      batch('milk-late', 'Milk', '2026-11-13'),
      batch('milk-soon', 'Milk', '2026-11-12'),
      batch('milk-empty', 'Milk', '2026-11-10', 0),
      batch('milk-freezer', 'Milk', '2026-11-12', 1, 'Freezer'),
    ];
    const { chips } = expiringChips(items, '2026-11-11', { timeZone: 'America/Chicago' });
    // Two products (Fridge and Freezer); the used-up batch is ignored, though it expired.
    assert.deepEqual(chips.map((chip) => [chip.id, chip.when]), [['milk-freezer', 'tomorrow'], ['milk-soon', 'tomorrow']]);
  });

  test('a used-up batch alone makes no chip', () => {
    assert.deepEqual(expiringChips([batch('gone', 'Cream', '2026-11-11', 0)], '2026-11-11', { timeZone: 'America/Chicago' }).chips, []);
  });

  test('legacy documents are read like the pantry reads them (quantity as packages, ISO expiry in the zone)', () => {
    const legacy = [{ id: 'legacy', name: 'Butter', quantity: 2, unit: 'items', location: 'Fridge', expiryDate: '2026-11-12T06:00:00.000Z' }];
    assert.deepEqual(expiringChips(legacy, '2026-11-11', { timeZone: 'America/Chicago' }).chips.map((chip) => [chip.id, chip.when]), [['legacy', 'tomorrow']]);
    const legacyEmpty = [{ id: 'none', name: 'Jam', quantity: 0, unit: 'items', location: 'Pantry', expiryDate: '2026-11-11' }];
    assert.deepEqual(expiringChips(legacyEmpty, '2026-11-11', { timeZone: 'America/Chicago' }).chips, []);
  });

  test('capped, with the rest counted; a missing name and a bad day are safe', () => {
    const { chips, more } = expiringChips(pantry, '2026-11-11', { timeZone: 'America/Chicago', limit: 2 });
    assert.equal(chips.length, 2);
    assert.equal(more, 2);
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

describe('overview: writes wait for the shown list to load (no duplicate instead of a merge)', () => {
  test('ready only when the listener follows the target list and items and categories answered', () => {
    const ready = { targetListId: 'weekly', itemsListId: 'weekly', itemsStatus: 'ready', categoriesStatus: 'ready' } as const;
    assert.equal(overviewWriteReady(ready), true);
    assert.equal(overviewWriteReady({ ...ready, itemsStatus: 'loading' }), false);
    assert.equal(overviewWriteReady({ ...ready, categoriesStatus: 'loading' }), false);
    // Just after a switch: the listener already follows the new list, the old target is refused.
    assert.equal(overviewWriteReady({ ...ready, itemsListId: 'costco' }), false);
    assert.equal(overviewWriteReady({ ...ready, targetListId: null, itemsListId: null }), false);
  });

  test('a listener that failed before its first snapshot blocks writes and says it is retrying', () => {
    const ready = { targetListId: 'weekly', itemsListId: 'weekly', itemsStatus: 'ready', categoriesStatus: 'ready' } as const;
    // errorToState: a failure before any snapshot is `error` with the empty initial items.
    const initialError = errorToState(loadingState('items/h/weekly', [] as string[]), 'items/h/weekly', new Error('unavailable'), []);
    assert.equal(initialError.status, 'error');
    assert.equal(overviewWriteReady({ ...ready, itemsStatus: initialError.status }), false);
    assert.equal(writeWait({ ...ready, itemsStatus: initialError.status }), 'retrying');
    assert.equal(writeWaitText('retrying', 'Groceries'), 'Could not load Groceries yet. Retrying…');
    assert.equal(writeWait({ ...ready, itemsStatus: 'loading' }), 'loading');
    assert.equal(writeWaitText('loading', 'Groceries'), 'Loading Groceries…');
    // A failure after a snapshot keeps `ready` with the last items: writes still go (the rules decide).
    const loaded = snapshotToState('items/h/weekly', ['milk'], { fromCache: false, hasPendingWrites: false });
    const laterError = errorToState(loaded, 'items/h/weekly', new Error('unavailable'), []);
    assert.equal(laterError.status, 'ready');
    assert.deepEqual(laterError.value, ['milk']);
    assert.equal(overviewWriteReady({ ...ready, itemsStatus: laterError.status }), true);
    assert.equal(writeWait({ ...ready, itemsStatus: laterError.status }), null);
    // Categories that failed first leave the defaults: no merge depends on them, so writes go.
    assert.equal(overviewWriteReady({ ...ready, categoriesStatus: 'error' }), true);
  });
});

describe("overview: this device's own ticks survive a reload (SH-28c)", () => {
  const memory = () => {
    const data = new Map<string, string>();
    return { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => void data.set(key, value), data };
  };
  const now = Date.parse('2026-11-11T18:00:00Z');
  const names = new Map([['alex', 'Alex']]);
  const tick = (by: string, minutesAgo: number, opId: string) => ({
    status: 'purchased' as const,
    purchasedByUid: by,
    purchasedAt: { toMillis: () => now - minutesAgo * 60_000 },
    purchaseOpId: opId,
  });

  test('recorded per household and list, restored after a reload, so own ticks are not "another device"', () => {
    const storage = memory();
    assert.equal(recordLocalTick(storage, 'house', 'weekly', 'op-1', now - 120_000), true);
    assert.equal(recordLocalTick(storage, 'house', 'weekly', 'op-2', now - 60_000), true);
    assert.equal(recordLocalTick(storage, 'house', 'costco', 'op-3', now), true);
    // A reload: nothing in memory, everything from storage.
    const restored = readLocalTicks(storage, 'house', 'weekly', now);
    assert.deepEqual([...restored.opIds].sort(), ['op-1', 'op-2']);
    assert.equal(restored.reliable, true);
    assert.deepEqual([...readLocalTicks(storage, 'other-house', 'weekly', now).opIds], []);
    const items = [tick('me', 2, 'op-1'), tick('me', 1, 'op-2'), { status: 'needed' as const }];
    assert.equal(shoppingActivity({ items, now, uid: 'me', localOpIds: restored.opIds, names, selfKnown: restored.reliable }), null);
  });

  test('a real second device (purchase ids this device never made) still shows', () => {
    const storage = memory();
    recordLocalTick(storage, 'house', 'weekly', 'op-1', now);
    const local = readLocalTicks(storage, 'house', 'weekly', now);
    const items = [tick('me', 3, 'phone-1'), tick('me', 2, 'phone-2'), tick('alex', 1, 'a-1'), tick('alex', 2, 'a-2'), { status: 'needed' as const }];
    assert.equal(
      shoppingActivity({ items, now, uid: 'me', localOpIds: local.opIds, names, selfKnown: local.reliable })?.label,
      'Alex and You are shopping · 1 left',
    );
  });

  test('entries older than the keep window are pruned on read and on write', () => {
    const storage = memory();
    recordLocalTick(storage, 'house', 'weekly', 'old', now - LOCAL_TICKS_KEEP_MS - 1);
    recordLocalTick(storage, 'house', 'weekly', 'new', now);
    assert.deepEqual([...readLocalTicks(storage, 'house', 'weekly', now).opIds], ['new']);
    assert.doesNotMatch(storage.data.get(LOCAL_TICKS_KEY) ?? '', /"old"/);
  });

  test('corrupt storage starts over; unavailable storage shows no "You … on another device" (other members still do)', () => {
    const storage = memory();
    storage.data.set(LOCAL_TICKS_KEY, '{not json');
    assert.deepEqual(readLocalTicks(storage, 'house', 'weekly', now), { opIds: new Set(), reliable: true });
    assert.equal(recordLocalTick(storage, 'house', 'weekly', 'op-1', now), true);
    const blocked = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
    assert.equal(recordLocalTick(blocked, 'house', 'weekly', 'op-1', now), false);
    const unavailable = readLocalTicks(blocked, 'house', 'weekly', now);
    assert.equal(unavailable.reliable, false);
    assert.equal(readLocalTicks(null, 'house', 'weekly', now).reliable, false);
    const full = { getItem: () => null, setItem: () => { throw new Error('quota'); } };
    assert.equal(recordLocalTick(full, 'house', 'weekly', 'op-1', now), false);
    const items = [tick('me', 2, 'x-1'), tick('me', 1, 'x-2'), tick('alex', 1, 'a-1'), tick('alex', 2, 'a-2')];
    assert.equal(
      shoppingActivity({ items, now, uid: 'me', localOpIds: unavailable.opIds, names, selfKnown: false })?.label,
      'Alex is shopping · all in the cart',
    );
  });
});
