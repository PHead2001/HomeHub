import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { readFileSync } from 'node:fs';
import { libraryOfferFor, localLibraryLookup, scannedLibraryId } from '../../src/lib/barcode/library-fill';

describe('library that fills itself (BL-19)', () => {
  const off = { source: 'open_food_facts', productName: '  Oat   drink ', imageUrl: 'https://images.openfoodfacts.org/images/products/1/front.jpg' };

  test('an Open Food Facts find is offered under its normalised ID, with its photo', () => {
    assert.deepEqual(libraryOfferFor(off, '012345678905', 'h'), {
      barcode: '0012345678905', name: 'Oat drink', imageUrl: 'https://images.openfoodfacts.org/images/products/1/front.jpg',
    });
  });

  test('allergens and Nutri-Score travel with the offer (BL-22)', () => {
    assert.deepEqual(libraryOfferFor({ ...off, allergens: ['peanuts'], nutriScore: 'd' }, '4006381333931', 'h'), {
      barcode: '4006381333931', name: 'Oat drink', imageUrl: off.imageUrl, allergens: ['peanuts'], nutriScore: 'd',
    });
  });

  test('a photo the rules would refuse is left out; the product is still offered', () => {
    assert.equal(libraryOfferFor({ ...off, imageUrl: 'https://evil.example/x.jpg' }, '4006381333931', 'h')?.imageUrl, '');
  });

  test('no offer for a household hit, a miss, or a nameless reply', () => {
    assert.equal(libraryOfferFor({ ...off, source: 'household' }, '4006381333931', 'h'), null);
    assert.equal(libraryOfferFor({ source: 'none', productName: null }, '4006381333931', 'h'), null);
    assert.equal(libraryOfferFor({ ...off, productName: '   ' }, '4006381333931', 'h'), null);
    assert.equal(libraryOfferFor({ ...off, libraryItem: { id: 'x' } }, '4006381333931', 'h'), null);
  });

  test('a saved product answers from the device, in either barcode form', () => {
    const library = new Map([['0012345678905', { name: 'Oat drink', imageUrl: '' }], ['000000000404', { name: 'Mystery tin' }]]);
    assert.deepEqual(localLibraryLookup(library, '012345678905'), {
      productName: 'Oat drink', libraryItem: { id: '0012345678905', name: 'Oat drink', imageUrl: '', createdAt: '' }, source: 'household',
    });
    assert.equal(localLibraryLookup(library, '000000000404')?.productName, 'Mystery tin');
    assert.equal(localLibraryLookup(library, '4006381333931'), null);
    assert.equal(localLibraryLookup(null, '012345678905'), null);
  });
});

describe('which saved product a scan counts toward (BL-23)', () => {
  const library = new Map([['0012345678905', { name: 'Oat drink' }]]);

  test('a household answer counts its product; Open Food Facts and misses count nothing', () => {
    assert.equal(scannedLibraryId(library, '012345678905', { source: 'household', libraryItem: { id: '0012345678905' } }), '0012345678905');
    assert.equal(scannedLibraryId(library, '012345678905', { source: 'open_food_facts', libraryItem: null }), null);
    assert.equal(scannedLibraryId(library, '012345678905', { source: 'none', libraryItem: null }), null);
  });

  test('without a lookup (Scan to tick matched the list by barcode) the on-device library decides, in either form', () => {
    assert.equal(scannedLibraryId(library, '012345678905'), '0012345678905');
    assert.equal(scannedLibraryId(library, '4006381333931'), null);
    assert.equal(scannedLibraryId(null, '012345678905'), null);
  });

  test('Scan to tick counts on its barcode fast path; Add Item counts before awaiting the add (queued offline)', () => {
    const tick = readFileSync('src/components/shopping/scan-to-tick.tsx', 'utf8');
    const fast = tick.slice(tick.indexOf('const local = matchByBarcode'), tick.indexOf('act(local, barcode);'));
    assert.match(fast, /countLibraryScan\(householdId, savedId\)/);
    const list = readFileSync('src/components/shopping-list-client.tsx', 'utf8');
    const count = list.indexOf('if (savedId) countLibraryScan(householdForLookup, savedId);');
    const add = list.indexOf('const final = await addScannedProduct(');
    assert.ok(count > 0 && add > count, 'the count is queued before the add is awaited');
  });
});
