import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  MAX_LIST_CATEGORIES,
  MAX_STORE_AISLES,
  categoryKey,
  checkStoreName,
  dedupeCategories,
  effectiveCategoryOrder,
  findListNamed,
  groupingOrder,
  initialAisleOrder,
  listOrderAtStore,
  moveCategory,
  planCategoryAdd,
  planCategoryRemove,
  planListReorder,
  planStoreReorder,
  readCategoryConfig,
  storeForList,
  storeWalkFor,
} from '../../src/lib/shopping/category-order';
import { groupItemsByAisle } from '../../src/lib/shopping/items';
import { DEFAULT_SHOPPING_CATEGORIES, normalizeStoredCategories } from '../../src/lib/shopping-items';
import { listSaveData } from '../../src/lib/shopping/list-save';
import { saveLineText } from '../../src/lib/shopping/save-line';

const defaults = DEFAULT_SHOPPING_CATEGORIES;
const WALK_DEFAULTS = ['Produce', 'Bakery', 'Meat', 'Dairy', 'Frozen', 'Pantry', 'Snacks', 'Drinks', 'Household', 'Other'];

describe('category names (SH-10d)', () => {
  test('case and spacing do not make a second category', () => {
    assert.equal(categoryKey('  Dairy  '), categoryKey('dairy'));
    assert.deepEqual(dedupeCategories(['Dairy', 'dairy', ' Frozen  food ', 'frozen food', '', 3]), ['Dairy', 'Frozen food']);
    assert.deepEqual(normalizeStoredCategories({ list: ['Dairy', 'dairy', 'other'] }), ['Dairy', 'other']);
    // Other readers (quick-add, share target, pantry) see the aisle order first, then older-client names.
    assert.deepEqual(normalizeStoredCategories({ list: ['Bakery', 'Garage'], ordered: ['Party', 'Bakery'] }), ['Party', 'Bakery', 'Garage', 'Other']);
    // Entries the rules could not bound are never used.
    assert.deepEqual(dedupeCategories(['x'.repeat(101), 'Ok']), ['Ok']);
  });

  test('"dairy" and "Dairy" items are one aisle, headed with the list spelling', () => {
    const groups = groupItemsByAisle(
      [{ name: 'Milk', category: 'Dairy' }, { name: 'Cheese', category: 'dairy' }, { name: 'Yogurt', category: ' DAIRY ' }],
      ['Dairy', 'Other'],
    );
    assert.deepEqual(groups.map((group) => group.category), ['Dairy']);
    assert.deepEqual(groups[0].items.map((item) => item.name), ['Cheese', 'Milk', 'Yogurt']);
  });
});

describe('list category order (SH-34a)', () => {
  test('older documents and the defaults show in store-walk order, Other last', () => {
    assert.deepEqual(effectiveCategoryOrder(defaults, false), WALK_DEFAULTS);
    assert.deepEqual(effectiveCategoryOrder(['Garage', 'Dairy', 'Other', 'Party', 'Produce'], false), ['Produce', 'Dairy', 'Garage', 'Party', 'Other']);
  });

  test('an ordered document keeps the stored order, with Other moved last', () => {
    assert.deepEqual(effectiveCategoryOrder(['Party', 'Other', 'Dairy', 'Produce'], true), ['Party', 'Dairy', 'Produce', 'Other']);
    assert.deepEqual(effectiveCategoryOrder(['Party'], true), ['Party', 'Other']);
  });

  test('reads a missing document as the defaults and `ordered` as the aisle order', () => {
    assert.deepEqual(readCategoryConfig(undefined, false, defaults), { list: WALK_DEFAULTS, rawList: [], rawOrdered: [], ordered: false, exists: false });
    const config = readCategoryConfig({ list: ['Produce', 'Snacks', 'Garage', 7], ordered: ['Snacks', 'Produce', 'snacks'] }, true, defaults);
    // The older list's extra name (an older client's add) follows the ordered ones.
    assert.deepEqual(config, {
      list: ['Snacks', 'Produce', 'Garage', 'Other'],
      rawList: ['Produce', 'Snacks', 'Garage'],
      rawOrdered: ['Snacks', 'Produce', 'snacks'],
      ordered: true,
      exists: true,
    });
    // An older document without `ordered` keeps the walk order.
    assert.equal(readCategoryConfig({ list: ['Garage', 'Dairy'] }, true, defaults).ordered, false);
  });

  test('a reordered list groups items in its order; one never reordered keeps the walk', () => {
    const items = [
      { name: 'Milk', category: 'Dairy' },
      { name: 'Apples', category: 'Produce' },
      { name: 'Cake', category: 'Party' },
      { name: 'Orphan', category: 'Removed' },
      { name: 'Thing', category: 'Other' },
    ];
    const ordered = readCategoryConfig({ list: ['Dairy', 'Other', 'Party', 'Produce'], ordered: ['Party', 'Dairy', 'Produce', 'Other'] }, true, defaults);
    assert.deepEqual(
      groupItemsByAisle(items, ordered.list, { order: groupingOrder(ordered.list, null) }).map((group) => group.category),
      ['Party', 'Dairy', 'Produce', 'Removed', 'Other'],
    );
    assert.deepEqual(groupItemsByAisle(items, ['Party', 'Dairy', 'Produce', 'Other']).map((group) => group.category), ['Produce', 'Dairy', 'Party', 'Removed', 'Other']);
  });

  test('moving up and down stops at the ends and never moves past Other', () => {
    const order = ['A', 'B', 'C', 'Other'];
    assert.deepEqual(moveCategory(order, 'B', -1), ['B', 'A', 'C', 'Other']);
    assert.deepEqual(moveCategory(order, 'b', 1), ['A', 'C', 'B', 'Other']);
    assert.equal(moveCategory(order, 'A', -1), null);
    assert.equal(moveCategory(order, 'C', 1), null);
    assert.equal(moveCategory(order, 'Other', -1), null);
    assert.equal(moveCategory(order, 'Missing', 1), null);
  });

  test('a reorder applies the move to the order the server holds now', () => {
    // Someone added "Party" since this screen drew the list: the move keeps it.
    const server = { data: { list: ['Dairy', 'Other', 'Party', 'Produce'], ordered: ['Produce', 'Dairy', 'Party', 'Other'] }, exists: true };
    assert.deepEqual(planListReorder(server, defaults, 'Dairy', -1), { ordered: ['Dairy', 'Produce', 'Party', 'Other'] });
    // An older, sorted document is moved from the order it is shown in, and gets `ordered`.
    const legacy = { data: { list: ['Dairy', 'Garage', 'Other', 'Produce'] }, exists: true };
    assert.deepEqual(planListReorder(legacy, defaults, 'Garage', -1), { ordered: ['Produce', 'Garage', 'Dairy', 'Other'] });
    // No document yet: the defaults are moved, and `list` is written for older readers.
    const fresh = planListReorder({ data: undefined, exists: false }, defaults, 'Bakery', -1);
    assert.deepEqual(fresh?.ordered.slice(0, 3), ['Bakery', 'Produce', 'Meat']);
    assert.deepEqual(fresh?.list, fresh?.ordered);
    // Removed meanwhile: nothing to write.
    assert.equal(planListReorder(server, defaults, 'Snacks', 1), null);
  });
});

describe('adding and removing categories never rewrites the list (SH-10c)', () => {
  const existing = readCategoryConfig({ list: ['Dairy', 'dairy', 'Produce', 'Other'], ordered: ['Produce', 'Dairy', 'dairy', 'Other'] }, true, defaults);
  const legacy = readCategoryConfig({ list: ['Dairy', 'Garage', 'Other', 'Produce'] }, true, defaults);
  const missing = readCategoryConfig(undefined, false, defaults);

  test('an add to an ordered document is one arrayUnion value on each field', () => {
    assert.deepEqual(planCategoryAdd('  Party   supplies ', existing), {
      ok: true, name: 'Party supplies', plan: { unionList: ['Party supplies'], unionOrdered: ['Party supplies'] },
    });
  });

  test('an add to an older document starts `ordered` from the order shown', () => {
    const result = planCategoryAdd('Party', legacy);
    assert.ok(result.ok);
    assert.deepEqual(result.plan, { unionList: ['Party'], unionOrdered: ['Produce', 'Dairy', 'Garage', 'Party', 'Other'] });
  });

  test('an add with no document creates it in the order shown, new category before Other', () => {
    const result = planCategoryAdd('Garden', missing);
    assert.ok(result.ok);
    const seeded = [...WALK_DEFAULTS.slice(0, -1), 'Garden', 'Other'];
    assert.deepEqual(result.plan, { unionList: seeded, unionOrdered: seeded });
  });

  test('empty, too long, duplicate (any case) and over the limit are explained', () => {
    assert.deepEqual(planCategoryAdd('   ', existing), { ok: false, error: 'Type a category name.' });
    assert.equal(planCategoryAdd('x'.repeat(61), existing).ok, false);
    assert.deepEqual(planCategoryAdd('DAIRY', existing), { ok: false, error: 'Dairy is already a category.' });
    const full = readCategoryConfig({ list: Array.from({ length: MAX_LIST_CATEGORIES }, (_, index) => `C${index}`) }, true, defaults);
    assert.equal(planCategoryAdd('One more', full).ok, false);
  });

  test('a remove names every stored spelling; Other and unknown names write nothing', () => {
    assert.deepEqual(planCategoryRemove('dairy', existing), { removeList: ['Dairy', 'dairy'], removeOrdered: ['Dairy', 'dairy'] });
    // An older document: removed from `list`, and `ordered` starts without it.
    assert.deepEqual(planCategoryRemove('Garage', legacy), { removeList: ['Garage'], unionOrdered: ['Produce', 'Dairy', 'Other'] });
    assert.equal(planCategoryRemove('Other', existing), null);
    assert.equal(planCategoryRemove('Snacks', existing), null);
  });

  test('a remove with no document creates it without that category', () => {
    const rest = WALK_DEFAULTS.filter((name) => name !== 'Snacks');
    assert.deepEqual(planCategoryRemove('Snacks', missing), { unionList: rest, unionOrdered: rest });
  });
});

describe('per-store aisle order (SH-34b)', () => {
  const listOrder = ['Produce', 'Dairy', 'Party', 'Other'];

  test("a store's walk puts its aisles first, then the list's own categories", () => {
    assert.deepEqual(storeWalkFor(['Dairy', 'Garden', 'Produce', 'Other'], listOrder), ['Dairy', 'Garden', 'Produce', 'Party']);
    assert.deepEqual(listOrderAtStore(['dairy', 'Garden', 'Produce'], listOrder), ['Dairy', 'Produce', 'Party', 'Other']);
    assert.deepEqual(groupingOrder(listOrder, { aisleOrder: ['Dairy', 'Produce'] }), ['Dairy', 'Produce', 'Party', 'Other']);
  });

  test('the open list groups by its store, other stores and no store unaffected', () => {
    const items = [{ name: 'Milk', category: 'Dairy' }, { name: 'Apples', category: 'Produce' }, { name: 'Cake', category: 'Party' }];
    const atStore = groupItemsByAisle(items, listOrder, { order: groupingOrder(listOrder, { aisleOrder: ['Party', 'Dairy', 'Produce'] }) });
    assert.deepEqual(atStore.map((group) => group.category), ['Party', 'Dairy', 'Produce']);
  });

  test("a move skips aisles this list does not use, so they keep their places", () => {
    const store = ['Dairy', 'Garden', 'Produce'];
    // Produce up past Garden (hidden here) to just before Dairy.
    assert.deepEqual(planStoreReorder(store, listOrder, 'Produce', -1), ['Produce', 'Dairy', 'Garden', 'Party']);
    // Dairy down: lands just after Produce; Garden stays first of the rest.
    assert.deepEqual(planStoreReorder(store, listOrder, 'Dairy', 1), ['Garden', 'Produce', 'Dairy', 'Party']);
    // Party (not placed yet) up: the store learns it.
    assert.deepEqual(planStoreReorder(store, listOrder, 'Party', -1), ['Dairy', 'Garden', 'Party', 'Produce']);
    assert.equal(planStoreReorder(store, listOrder, 'Dairy', -1), null);
    assert.equal(planStoreReorder(store, listOrder, 'Garden', 1), null);
    assert.equal(planStoreReorder(store, listOrder, 'Other', -1), null);
  });

  test('a move that would exceed the aisle limit is refused', () => {
    const store = Array.from({ length: MAX_STORE_AISLES }, (_, index) => `Aisle ${index}`);
    assert.equal(planStoreReorder(store, ['Aisle 0', 'New', 'Other'], 'New', -1), 'too-many');
  });

  test('a new store starts from the list order, without Other', () => {
    assert.deepEqual(initialAisleOrder(listOrder), ['Produce', 'Dairy', 'Party']);
  });

  test('store names are required, bounded and unique', () => {
    const stores = [{ name: 'Costco' }];
    assert.deepEqual(checkStoreName('  Trader   Joe ', stores), { ok: true, name: 'Trader Joe' });
    assert.equal(checkStoreName('', stores).ok, false);
    assert.equal(checkStoreName('x'.repeat(61), stores).ok, false);
    assert.deepEqual(checkStoreName('costco', stores), { ok: false, error: 'You already have a store called Costco. Pick it from the list.' });
  });

  test('a list follows its store only while that store exists', () => {
    const stores = [{ id: 's1' }];
    assert.deepEqual(storeForList('s1', stores), { id: 's1' });
    assert.equal(storeForList('gone', stores), null);
    assert.equal(storeForList(null, stores), null);
  });
});

describe('creating a list (SH-5a, SH-20b)', () => {
  test('the same name in any case or spacing is found, except the list being edited', () => {
    const lists = [{ id: 'g', name: 'Groceries' }, { id: 'h', name: 'Hardware' }];
    assert.equal(findListNamed('  groceries ', lists)?.id, 'g');
    assert.equal(findListNamed('Groceries', lists, 'g'), null);
    assert.equal(findListNamed('', lists), null);
  });

  test('a custom list keeps its type and records its creator only on create', () => {
    const values = { name: '  Weekly   shop ', description: ' Saturday run ', icon: 'Home', type: 'Grocery' as const, color: '' };
    assert.deepEqual(listSaveData(values, { isNew: true, uid: 'u1' }), {
      name: 'Weekly shop', description: 'Saturday run', icon: 'Home', type: 'Grocery', color: '', createdByUid: 'u1',
    });
    assert.equal('createdByUid' in listSaveData(values, { isNew: false, uid: 'u1' }), false);
    assert.equal('createdByUid' in listSaveData(values, { isNew: true, uid: null }), false);
  });
});

describe('dialog save line', () => {
  test('says saved only for a confirmed write', () => {
    assert.equal(saveLineText('waiting', 'Dairy moved up'), 'Dairy moved up · Saving…');
    assert.equal(saveLineText('saved', 'Dairy moved up'), 'Dairy moved up · Saved');
    assert.equal(saveLineText('sending', 'Garden added'), 'Garden added · Still sending…');
    assert.equal(saveLineText('uncertain', 'Dairy moved up'), 'Dairy moved up · Checking…');
    assert.equal(saveLineText('stored-locally', 'Garden added'), 'Garden added · Saved, will sync');
  });
});
