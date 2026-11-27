import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { libraryOfferFor, localLibraryLookup } from '../../src/lib/barcode/library-fill';

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
