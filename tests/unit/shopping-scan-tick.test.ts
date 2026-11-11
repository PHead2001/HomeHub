import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { currentItemForToggle, matchByBarcode, scanTickDecision, type TickCandidate } from '../../src/lib/shopping/scan-tick';
import { rowPhoto, shownPhoto } from '../../src/lib/shopping/row-photo';
import { productPhotoForName } from '../../src/lib/shopping/pantry';

const items: TickCandidate[] = [
  { id: 'milk', name: 'Milk', status: 'needed' },
  { id: 'juice', name: 'E2E Family Juice', status: 'needed' },
  { id: 'yogurt', name: 'Yogurt', status: 'needed', barcode: '009900045000' },
  { id: 'bread', name: 'Bread', status: 'purchased', barcode: '111111111111' },
  { id: 'eggs', name: 'Eggs', status: 'purchased' },
];

describe('scan to tick (SH-33f)', () => {
  test('an item added by scanning the same code ticks without a lookup', () => {
    assert.deepEqual(matchByBarcode(items, '009900045000'), { kind: 'tick', item: items[2] });
    assert.deepEqual(matchByBarcode(items, '111111111111'), { kind: 'in-cart', item: items[3] });
    assert.equal(matchByBarcode(items, '222222222222'), null);
    assert.equal(matchByBarcode(items, ' '), null);
  });

  test('a looked-up name ticks the needed item of that name (case and spacing ignored)', () => {
    assert.deepEqual(scanTickDecision(items, '008500001280', { source: 'open_food_facts', productName: ' e2e  family juice ' }),
      { kind: 'tick', item: items[1] });
    assert.deepEqual(scanTickDecision(items, '1', { source: 'household', productName: 'x', libraryItem: { name: 'milk' } }),
      { kind: 'tick', item: items[0] });
  });

  test('a name already in the cart says so', () => {
    assert.deepEqual(scanTickDecision(items, '3', { source: 'open_food_facts', productName: 'Eggs' }), { kind: 'in-cart', item: items[4] });
  });

  test('a product not on the list is offered as an Add of one package', () => {
    assert.deepEqual(scanTickDecision(items, '4', { source: 'open_food_facts', productName: 'Tea', quantity: 450, unit: 'g' }),
      { kind: 'offer-add', entry: { name: 'Tea', quantity: 1, size: 450, sizeUnit: 'g' } });
  });

  test('unknown and unavailable lookups are misses', () => {
    assert.deepEqual(scanTickDecision(items, '000000000404', { source: 'none', productName: null }), { kind: 'miss', miss: { kind: 'not-found' } });
    assert.deepEqual(scanTickDecision(items, '000000000408', { source: 'unavailable', productName: null, unavailableReason: 'timeout' }),
      { kind: 'miss', miss: { kind: 'unavailable', reason: 'timeout' } });
  });
});

describe('stale matches never re-tick (SH-33f)', () => {
  test('a name match decided on the items AFTER the lookup reports the cart when someone ticked meanwhile', () => {
    const before = items;
    const after = items.map((item) => (item.id === 'juice' ? { ...item, status: 'purchased' as const } : item));
    const result = { source: 'open_food_facts' as const, productName: 'E2E Family Juice' };
    assert.equal(scanTickDecision(before, '008500001280', result).kind, 'tick');
    assert.deepEqual(scanTickDecision(after, '008500001280', result), { kind: 'in-cart', item: after[1] });
  });

  test('the tick acts on the latest copy and refuses one whose status changed', () => {
    const seen = items[1];
    const ticked = { ...seen, status: 'purchased' as const };
    assert.equal(currentItemForToggle(seen, [ticked]), null);
    const renamed = { ...seen, name: 'Juice (big)' };
    assert.equal(currentItemForToggle(seen, [renamed]), renamed);
    // Not in the listener (yet): acted on as seen; the write decides.
    assert.equal(currentItemForToggle(seen, []), seen);
  });
});

describe('row photos follow the library', () => {
  const managedUrl = 'https://storage.test/households%2Fh%2Fbarcode-library%2Fold.jpg';
  const isManaged = (url: string) => url.includes('barcode-library');
  const library = new Map([['111', { imageUrl: 'https://storage.test/new.jpg' }], ['222', { imageUrl: '' }]]);

  test('the current library photo wins over the stored one', () => {
    assert.equal(rowPhoto({ barcode: '111', imageUrl: managedUrl }, library, isManaged), 'https://storage.test/new.jpg');
    assert.equal(rowPhoto({ barcode: '222', imageUrl: managedUrl }, library, isManaged), null);
  });

  test('a deleted product hides its managed photo but keeps other stored photos', () => {
    assert.equal(rowPhoto({ barcode: '333', imageUrl: managedUrl }, library, isManaged), null);
    assert.equal(rowPhoto({ imageUrl: 'https://images.openfoodfacts.org/x.jpg' }, library, isManaged), 'https://images.openfoodfacts.org/x.jpg');
    assert.equal(rowPhoto({}, library, isManaged), null);
  });

  test('while the library is unknown the stored photo shows', () => {
    assert.equal(rowPhoto({ barcode: '111', imageUrl: managedUrl }, null, isManaged), managedUrl);
  });
});

describe('photos that fail to load fall back (rows and pantry tiles)', () => {
  test('a URL that failed is not drawn again; a new URL is', () => {
    assert.equal(shownPhoto('https://x.test/a.jpg', null), 'https://x.test/a.jpg');
    assert.equal(shownPhoto('https://x.test/a.jpg', 'https://x.test/a.jpg'), null);
    assert.equal(shownPhoto('https://x.test/b.jpg', 'https://x.test/a.jpg'), 'https://x.test/b.jpg');
    assert.equal(shownPhoto(undefined, null), null);
    assert.equal(shownPhoto('', null), null);
  });

  test('pantry tiles follow the live library: a replaced or removed photo changes the tile', () => {
    const before = [{ name: 'Oat milk', imageUrl: 'https://x.test/old.jpg' }];
    assert.equal(productPhotoForName('oat milk', before), 'https://x.test/old.jpg');
    assert.equal(productPhotoForName('oat milk', [{ name: 'Oat milk', imageUrl: 'https://x.test/new.jpg' }]), 'https://x.test/new.jpg');
    assert.equal(productPhotoForName('oat milk', [{ name: 'Oat milk', imageUrl: '' }]), undefined);
  });
});
