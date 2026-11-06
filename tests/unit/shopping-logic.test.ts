import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import {
  findMergeTarget,
  groupItemsByAisle,
  itemNameKey,
  MAX_QUICK_ADD_ITEMS,
  normalizeItemName,
  parseQuickAdd,
  pluralize,
  withoutIds,
  canMergeInto,
  isStillPurchased,
  isTripComplete,
} from '../../src/lib/shopping/items';
import {
  daysUntilExpiry,
  expiryLabel,
  expiryState,
  matchRecipeIngredients,
  pantryEmoji,
  pantryLocationForCategory,
  planPantryHandoff,
  productPhotoForName,
  pantryMergeStillValid,
} from '../../src/lib/shopping/pantry';
import { isListTint, listTint, listTintIndex, resolveListIconName } from '../../src/lib/shopping/list-style';
import { parseShoppingUrlState, shoppingHref } from '../../src/lib/shopping/url-state';
import { quantityIncrement } from '../../src/lib/shopping/item-writes';
import { increment } from 'firebase/firestore';

describe('item names and duplicates', () => {
  test('normalizes spacing and capitalises all-lower-case names only', () => {
    assert.equal(normalizeItemName('  whole   milk '), 'Whole milk');
    assert.equal(normalizeItemName('iPhone cable'), 'iPhone cable');
    assert.equal(normalizeItemName('BBQ sauce'), 'BBQ sauce');
    assert.equal(normalizeItemName('   '), '');
    assert.ok(normalizeItemName('x'.repeat(300)).length <= 120);
  });

  test('merge keys ignore case and spacing', () => {
    assert.equal(itemNameKey(' Milk '), itemNameKey('milk'));
    assert.equal(itemNameKey('Oat  milk'), 'oat milk');
  });

  test('merges only into a still-needed item with the same name', () => {
    const items = [
      { id: 'a', name: 'Milk', status: 'purchased' as const },
      { id: 'b', name: 'milk ', status: 'needed' as const },
      { id: 'c', name: 'Eggs', status: 'needed' as const },
    ];
    assert.equal(findMergeTarget(items, 'MILK')?.id, 'b');
    assert.equal(findMergeTarget(items, 'bread'), undefined);
    assert.equal(findMergeTarget([items[0]], 'milk'), undefined, 'purchased items belong to the trip');
    assert.equal(findMergeTarget(items, '  '), undefined);
  });
});

describe('quick-add parsing', () => {
  test('splits on commas, semicolons and new lines, with counts before or after', () => {
    assert.deepEqual(parseQuickAdd('milk, eggs, 2 bread'), [
      { name: 'Milk', quantity: 1 },
      { name: 'Eggs', quantity: 1 },
      { name: 'Bread', quantity: 2 },
    ]);
    assert.deepEqual(parseQuickAdd('bananas x3; 2x apples\n3 × limes'), [
      { name: 'Bananas', quantity: 3 },
      { name: 'Apples', quantity: 2 },
      { name: 'Limes', quantity: 3 },
    ]);
  });

  test('keeps numbers that are part of a name', () => {
    assert.deepEqual(parseQuickAdd('7up'), [{ name: '7up', quantity: 1 }]);
    assert.deepEqual(parseQuickAdd('2xl shirt'), [{ name: '2xl shirt', quantity: 1 }]);
    assert.deepEqual(parseQuickAdd('2 xbox controllers'), [{ name: 'Xbox controllers', quantity: 2 }]);
  });

  test('merges repeats in one submission and ignores empty entries', () => {
    assert.deepEqual(parseQuickAdd('milk, , Milk, 2 milk'), [{ name: 'Milk', quantity: 4 }]);
    assert.deepEqual(parseQuickAdd(' , ;\n'), []);
  });

  test('caps the entry count and quantities', () => {
    const many = Array.from({ length: 40 }, (_, i) => `item ${String.fromCharCode(97 + (i % 26))}${i}`).join(',');
    assert.equal(parseQuickAdd(many).length, MAX_QUICK_ADD_ITEMS);
    assert.equal(parseQuickAdd('999 eggs, 999 eggs')[0].quantity, 999);
    assert.equal(parseQuickAdd('0 eggs')[0].quantity, 1);
  });
});

describe('store-walk grouping', () => {
  test('orders departments like a store walk, custom categories next, Other last', () => {
    const items = [
      { name: 'Soap', category: 'Household' },
      { name: 'Milk', category: 'Dairy' },
      { name: 'Apples', category: 'Produce' },
      { name: 'Mystery', category: 'Other' },
      { name: 'Batteries', category: 'Garage' },
      { name: 'Bananas', category: 'Produce' },
      { name: 'Cake', category: 'Party' },
      { name: 'Orphan', category: 'Removed category' },
    ];
    const groups = groupItemsByAisle(items, ['Party', 'Garage', 'Produce', 'Dairy', 'Household', 'Other']);
    assert.deepEqual(groups.map((group) => group.category), ['Produce', 'Dairy', 'Household', 'Party', 'Garage', 'Removed category', 'Other']);
    assert.deepEqual(groups[0].items.map((item) => item.name), ['Apples', 'Bananas']);
  });

  test('items without a category fall into Other, so nothing disappears', () => {
    const groups = groupItemsByAisle([{ name: 'Thing', category: '' }], []);
    assert.deepEqual(groups, [{ category: 'Other', items: [{ name: 'Thing', category: '' }] }]);
  });

  test('pluralizes counts', () => {
    assert.equal(pluralize(1, 'item'), '1 item');
    assert.equal(pluralize(0, 'item'), '0 items');
    assert.equal(pluralize(3, 'product'), '3 products');
  });
});

describe('pantry handoff', () => {
  test('maps shopping categories to shelves', () => {
    assert.equal(pantryLocationForCategory('Dairy'), 'Fridge');
    assert.equal(pantryLocationForCategory('meat'), 'Fridge');
    assert.equal(pantryLocationForCategory('Produce'), 'Fridge');
    assert.equal(pantryLocationForCategory('Frozen'), 'Freezer');
    assert.equal(pantryLocationForCategory('Snacks'), 'Pantry');
    assert.equal(pantryLocationForCategory(undefined), 'Pantry');
  });

  test('merges into same-name entries on the same shelf counted in items, else creates', () => {
    const existing = [
      { id: 'milk-1', name: 'Whole Milk', quantity: 1, unit: 'items' as const, location: 'Fridge' as const },
      { id: 'rice-1', name: 'Rice', quantity: 2, unit: 'lbs' as const, location: 'Pantry' as const },
    ];
    const plans = planPantryHandoff([
      { item: { name: 'whole milk', quantity: 2 }, location: 'Fridge' },
      { item: { name: 'Rice', quantity: 1 }, location: 'Pantry' },
      { item: { name: 'Peas', quantity: 1 }, location: 'Freezer' },
      { item: { name: 'peas', quantity: 2 }, location: 'Freezer' },
      { item: { name: '  ', quantity: 1 }, location: 'Pantry' },
    ], existing);
    assert.deepEqual(plans, [
      { kind: 'increment', id: 'milk-1', name: 'Whole Milk', add: 2, location: 'Fridge' },
      { kind: 'create', name: 'Rice', quantity: 1, location: 'Pantry' },
      { kind: 'create', name: 'Peas', quantity: 3, location: 'Freezer' },
    ]);
  });
});

describe('pantry handoff is concurrency-safe', () => {
  test('an increment plan carries only the amount added, never a total computed from a read', () => {
    const plans = planPantryHandoff(
      [{ item: { name: 'Eggs', quantity: 1 }, location: 'Fridge' }],
      [{ id: 'eggs', name: 'Eggs', quantity: 2, unit: 'items', location: 'Fridge' }],
    );
    assert.deepEqual(plans, [{ kind: 'increment', id: 'eggs', name: 'Eggs', add: 1, location: 'Fridge' }]);
    assert.ok(!('quantity' in plans[0]));
  });

  test('the writer applies increments with Firestore increment(), which also queues offline', () => {
    const source = readFileSync(join(__dirname, '..', '..', 'src', 'lib', 'shopping', 'pantry-writes.ts'), 'utf8');
    assert.match(source, /quantity: increment\(plan\.add\)/);
  });
});

describe('shopping quantity merges are atomic', () => {
  test('a merge writes increment(added), never a locally computed total', () => {
    const update = quantityIncrement(2);
    assert.deepEqual(Object.keys(update), ['quantity']);
    assert.ok(update.quantity.isEqual(increment(2)));
  });

  test('no shopping code writes a quantity total computed from a read', () => {
    const files = ['components/shopping-list-client.tsx', 'components/pantry-inventory-client.tsx', 'components/share-target-client.tsx', 'lib/shopping/pantry-writes.ts'];
    for (const file of files) {
      const source = readFileSync(join(__dirname, '..', '..', 'src', ...file.split('/')), 'utf8');
      assert.doesNotMatch(source, /quantity\)\s*\|\|\s*0\)\s*\+/, `${file} adds to a read quantity`);
      assert.doesNotMatch(source, /(?:updateDoc|batch\.update)\([^)]*\)?,\s*\{\s*quantity\s*\}/, `${file} writes a bare quantity total`);
    }
  });
});

describe('clearing purchased items', () => {
  test('removes exactly the cleared ids, keeping items ticked meanwhile', () => {
    const items = [
      { id: 'a', status: 'purchased' },
      { id: 'b', status: 'purchased' }, // ticked after the member pressed Clear
      { id: 'c', status: 'needed' },
    ];
    assert.deepEqual(withoutIds(items, ['a']).map((item) => item.id), ['b', 'c']);
    assert.deepEqual(withoutIds(items, []).length, 3);
  });

  test('clear and the empty-list prompt never derive from a local status filter', () => {
    const source = readFileSync(join(__dirname, '..', '..', 'src', 'components', 'shopping-list-client.tsx'), 'utf8');
    const clear = source.slice(source.indexOf('const clearPurchasedItems'), source.indexOf('const sendToPantry'));
    assert.match(clear, /deleteStillPurchasedItems\(/);
    assert.match(clear, /withoutIds\(prev, deleted\)/);
    assert.match(clear, /isBrowserOffline\(\)/);
    assert.match(clear, /const confirmed = await fetchItemsAndCategories/);
    assert.doesNotMatch(clear, /status === '(?:needed|purchased)'/);
  });
});

describe('decisions from confirmed (re-read) state, not the cached list', () => {
  test('an addition merges only into an item that is still needed', () => {
    assert.equal(canMergeInto({ status: 'needed' }), true);
    assert.equal(canMergeInto({ status: 'purchased' }), false, 'bought by someone else meanwhile');
    assert.equal(canMergeInto(undefined), false, 'deleted meanwhile');
  });

  test('clear removes only items that are still purchased', () => {
    assert.equal(isStillPurchased({ status: 'purchased' }), true);
    assert.equal(isStillPurchased({ status: 'needed' }), false, 'un-ticked by someone else meanwhile');
    assert.equal(isStillPurchased(null), false);
  });

  test('a trip is complete only when the confirmed list has items and none is needed', () => {
    assert.equal(isTripComplete([{ status: 'purchased' }]), true);
    assert.equal(isTripComplete([{ status: 'purchased' }, { status: 'needed' }]), false, 'someone added an item');
    assert.equal(isTripComplete([]), false);
  });

  test('a pantry increment applies only to an entry still on the same shelf, unit and name', () => {
    const plan = { name: 'Eggs' };
    assert.equal(pantryMergeStillValid({ name: 'eggs', unit: 'items', location: 'Fridge' }, plan, 'Fridge'), true);
    assert.equal(pantryMergeStillValid({ name: 'Eggs', unit: 'items', location: 'Freezer' }, plan, 'Fridge'), false, 'moved');
    assert.equal(pantryMergeStillValid({ name: 'Eggs', unit: 'dozen', location: 'Fridge' }, plan, 'Fridge'), false, 'unit changed');
    assert.equal(pantryMergeStillValid({ name: 'Duck eggs', unit: 'items', location: 'Fridge' }, plan, 'Fridge'), false, 'renamed');
    assert.equal(pantryMergeStillValid(undefined, plan, 'Fridge'), false, 'deleted');
  });

  test('the merge is a transaction online and never happens offline', () => {
    const source = readFileSync(join(__dirname, '..', '..', 'src', 'components', 'shopping-list-client.tsx'), 'utf8');
    assert.match(source, /const target = offline \? undefined : findMergeTarget\(/);
    assert.match(source, /await mergeIntoNeededItem\(/);
    const tx = readFileSync(join(__dirname, '..', '..', 'src', 'lib', 'shopping', 'item-transactions.ts'), 'utf8');
    assert.match(tx, /runTransaction\(db, async \(transaction\) => \{\s*const snapshot = await transaction\.get\(itemRef\);\s*if \(!canMergeInto/);
    const pantry = readFileSync(join(__dirname, '..', '..', 'src', 'lib', 'shopping', 'pantry-writes.ts'), 'utf8');
    assert.match(pantry, /runTransaction\(/);
    assert.match(pantry, /pantryMergeStillValid\(/);
  });
});

describe('shopping URL state', () => {
  const params = (search: string) => new URLSearchParams(search);

  test('parses tab, list and the quick-add request', () => {
    assert.deepEqual(parseShoppingUrlState(params('')), { tab: 'lists', listId: null, quickAdd: false });
    assert.deepEqual(parseShoppingUrlState(params('list=weekly-groceries')), { tab: 'lists', listId: 'weekly-groceries', quickAdd: false });
    assert.deepEqual(parseShoppingUrlState(params('tab=pantry&list=x')), { tab: 'inventory', listId: null, quickAdd: false });
    assert.deepEqual(parseShoppingUrlState(params('quickAdd=1')), { tab: 'lists', listId: null, quickAdd: true });
    assert.deepEqual(parseShoppingUrlState(null), { tab: 'lists', listId: null, quickAdd: false });
  });

  test('builds hrefs that keep unrelated params and drop the one-shot quick-add', () => {
    assert.equal(shoppingHref('/shopping', params('quickAdd=1&utm=a'), { tab: 'lists', listId: 'groceries' }), '/shopping?utm=a&list=groceries');
    assert.equal(shoppingHref('/shopping', params('list=a'), { tab: 'inventory', listId: null }), '/shopping?tab=pantry');
    assert.equal(shoppingHref('/shopping', params('tab=pantry'), { tab: 'lists', listId: null }), '/shopping');
  });

  test('the Shopping Center derives its state from useSearchParams, not a one-time read', () => {
    const source = readFileSync(join(__dirname, '..', '..', 'src', 'components', 'shopping-center-client.tsx'), 'utf8');
    assert.match(source, /useSearchParams\(\)/);
    assert.doesNotMatch(source, /useState<ShoppingUrlState>/);
    assert.doesNotMatch(source, /addEventListener\('popstate'/);
  });
});

describe('pantry shelves', () => {
  const now = new Date(2026, 7, 1, 15, 0, 0);

  test('expiry states: expired, within three days, fresh, none', () => {
    assert.equal(expiryState('2026-07-31', now), 'expired');
    assert.equal(expiryState('2026-08-01', now), 'soon');
    assert.equal(expiryState('2026-08-04', now), 'soon');
    assert.equal(expiryState('2026-08-05', now), 'fresh');
    assert.equal(expiryState(null, now), 'none');
    assert.equal(expiryState('not a date', now), 'none');
    assert.equal(daysUntilExpiry('2026-08-03', now), 2);
  });

  test('expiry labels read naturally', () => {
    assert.equal(expiryLabel('2026-08-01', now), 'Expires today');
    assert.equal(expiryLabel('2026-08-02', now), 'Expires tomorrow');
    assert.equal(expiryLabel('2026-08-06', now), '5 days left');
    assert.equal(expiryLabel('2026-07-31', now), 'Expired yesterday');
    assert.equal(expiryLabel('2026-07-28', now), 'Expired 4 days ago');
    assert.equal(expiryLabel(undefined, now), null);
  });

  test('tile emoji from the name, falling back to the shelf', () => {
    assert.equal(pantryEmoji('Greek yogurt', 'Fridge'), '🥣');
    assert.equal(pantryEmoji('Jasmine rice', 'Pantry'), '🍚');
    assert.equal(pantryEmoji('Something odd', 'Freezer'), '🧊');
  });

  test('matches recipe ingredient lines back to pantry items', () => {
    const items = [
      { id: 'rice', name: 'Jasmine rice' },
      { id: 'yogurt', name: 'Greek yogurt' },
      { id: 'berries', name: 'Frozen berries' },
      { id: 'oil', name: 'Olive oil' },
    ];
    assert.deepEqual(
      matchRecipeIngredients(['2 cups rice', '1 cup Greek yogurt', 'A handful of berries'], items).sort(),
      ['berries', 'rice', 'yogurt'],
    );
    assert.deepEqual(matchRecipeIngredients([], items), []);
  });

  test('finds a product photo by exact name only', () => {
    const library = [{ name: 'E2E Oat Cereal', imageUrl: '/favicon.ico' }, { name: 'No photo', imageUrl: '' }];
    assert.equal(productPhotoForName('e2e oat cereal', library), '/favicon.ico');
    assert.equal(productPhotoForName('No photo', library), undefined);
    assert.equal(productPhotoForName('Oat', library), undefined);
  });
});

describe('list tints and icons (D14)', () => {
  test('stored tints are used; legacy hex or missing colors get a stable palette slot', () => {
    assert.equal(isListTint('tint-3'), true);
    assert.equal(isListTint('#22c55e'), false);
    assert.equal(listTintIndex({ id: 'x', color: 'tint-5' }), 5);
    const legacy = listTintIndex({ id: 'weekly-groceries', color: '#22c55e' });
    assert.equal(legacy, listTintIndex({ id: 'weekly-groceries' }));
    assert.ok(legacy >= 1 && legacy <= 8);
    assert.match(listTint({ id: 'x', color: 'tint-2' }).classes.text, /^text-member-2$/);
  });

  test('unknown icon names fall back to the list type icon', () => {
    const known = new Set(['ShoppingCart', 'Wrench']);
    assert.equal(resolveListIconName({ icon: 'Hammer', type: 'Hardware' }, known), 'Wrench');
    assert.equal(resolveListIconName({ icon: 'ShoppingCart', type: 'Custom' }, known), 'ShoppingCart');
    assert.equal(resolveListIconName({ icon: '', type: 'Custom' }, known), 'ClipboardList');
  });
});

describe('shopping UI uses tokens only (D14)', () => {
  const root = join(__dirname, '..', '..', 'src');
  const files = [
    ...readdirSync(join(root, 'components', 'shopping')).map((file) => join(root, 'components', 'shopping', file)),
    join(root, 'components', 'shopping-list-client.tsx'),
    join(root, 'components', 'shopping-center-client.tsx'),
    join(root, 'components', 'pantry-inventory-client.tsx'),
    join(root, 'components', 'barcode-library-client.tsx'),
  ];

  for (const file of files) {
    test(`${file.split(/[\\/]/).slice(-2).join('/')} has no raw color literals or inline list colors`, () => {
      const source = readFileSync(file, 'utf8');
      assert.doesNotMatch(source, /#[0-9a-fA-F]{3,8}\b(?![\w-])/, 'hex color');
      assert.doesNotMatch(source, /\brgba?\(/, 'rgb() color');
      assert.doesNotMatch(source, /\b(?:bg|text|border|ring)-(?:red|orange|amber|yellow|green|emerald|teal|blue|sky|indigo|violet|purple|pink|rose|slate|gray|zinc|neutral|stone)-\d{2,3}\b/, 'Tailwind palette color');
      assert.doesNotMatch(source, /style=\{\{\s*(?:color|backgroundColor):\s*\w*\.?color/, 'stored list color as inline style');
    });
  }
});
