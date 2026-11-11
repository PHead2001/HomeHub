import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { matchByBarcode, scanTickDecision, type TickCandidate } from '../../src/lib/shopping/scan-tick';

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
