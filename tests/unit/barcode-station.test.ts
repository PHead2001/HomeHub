import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { restockLine, stationModeFrom, stationProduct, usedUpLine } from '../../src/lib/barcode/station';

describe('kitchen scan station (BL-20, BL-21)', () => {
  test('the mode comes from the address; Used up by default', () => {
    assert.equal(stationModeFrom(''), 'used');
    assert.equal(stationModeFrom('?mode=restock'), 'restock');
    assert.equal(stationModeFrom('?mode=list'), 'list');
    assert.equal(stationModeFrom('?mode=delete'), 'used');
  });

  test('a found product uses the library name and ID; Open Food Facts uses the normalised code', () => {
    assert.deepEqual(stationProduct({ source: 'household', productName: 'Beans', libraryItem: { id: '012345678905', name: 'My beans' } }, '012345678905'), {
      kind: 'product', product: { barcode: '012345678905', name: 'My beans', libraryId: '012345678905' },
    });
    assert.deepEqual(stationProduct({ source: 'open_food_facts', productName: 'Oat drink', libraryItem: null }, '012345678905'), {
      kind: 'product', product: { barcode: '0012345678905', name: 'Oat drink', libraryId: null },
    });
  });

  test('a miss or an outage is a miss, never a product', () => {
    assert.deepEqual(stationProduct({ source: 'none', productName: null, libraryItem: null }, '000000000404'), { kind: 'miss', miss: { kind: 'not-found' } });
    const outage = stationProduct({ source: 'unavailable', unavailableReason: 'timeout', productName: null, libraryItem: null }, '000000000408');
    assert.equal(outage.kind === 'miss' && outage.miss.kind, 'unavailable');
  });

  test('lines say what happened, and the last package says so', () => {
    assert.equal(usedUpLine({ kind: 'used', name: 'Beans', remaining: 2, askAddToList: false }, 'Beans'), 'Used one Beans. 2 left.');
    assert.equal(usedUpLine({ kind: 'used', name: 'Beans', remaining: 0, askAddToList: true }, 'Beans'), 'Used the last Beans.');
    assert.equal(usedUpLine({ kind: 'not-stocked' }, 'Beans'), 'Beans is not in the pantry.');
    assert.equal(usedUpLine({ kind: 'nothing-left', name: 'Beans' }, 'Beans'), 'There is nothing left of Beans to use.');
    assert.equal(restockLine('Beans', true), 'One more Beans in the pantry.');
    assert.equal(restockLine('Beans', false), 'Beans is in the pantry (1).');
  });
});
