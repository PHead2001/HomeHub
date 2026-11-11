import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { assignedStore, storesListed, type StoresSnapshot } from '../../src/lib/shopping/assigned-store';
import { initialAisleOrder, listOrderAtStore } from '../../src/lib/shopping/category-order';

type Store = { id: string; name: string; aisleOrder: string[] };
const corner: Store = { id: 'corner', name: 'Corner Shop', aisleOrder: ['Party', 'Dairy', 'Bakery'] };

const loading: StoresSnapshot<Store> = { status: 'loading', value: [], fromCache: true };
const cached = (value: Store[]): StoresSnapshot<Store> => ({ status: 'ready', value, fromCache: true });
const server = (value: Store[]): StoresSnapshot<Store> => ({ status: 'ready', value, fromCache: false });
const failed: StoresSnapshot<Store> = { status: 'error', value: [], fromCache: true };

describe('assignedStore (S6: SH-34b)', () => {
  test('a list that names no store follows its own order at once, stores loaded or not', () => {
    for (const storeId of [undefined, null, '', 42]) {
      for (const stores of [loading, cached([corner]), server([]), failed]) {
        const result = assignedStore(storeId, stores);
        assert.equal(result.state, 'none');
        assert.equal(result.store, null);
        assert.equal(result.storeId, null);
        assert.equal(result.resolved, true);
        assert.equal(result.waitForStore, false);
      }
    }
  });

  test('a named store before the stores listener answers is loading, not "no store": moves wait', () => {
    const result = assignedStore('corner', loading);
    assert.equal(result.state, 'loading');
    assert.equal(result.store, null);
    assert.equal(result.storeId, 'corner');
    assert.equal(result.resolved, false);
    assert.equal(result.waitForStore, true);
  });

  test('a named store that is loaded, from the server or the cache, is found', () => {
    for (const stores of [server([corner]), cached([corner])]) {
      const result = assignedStore('corner', stores);
      assert.equal(result.state, 'found');
      assert.equal(result.store, corner);
      assert.equal(result.resolved, true);
      assert.equal(result.waitForStore, false);
    }
  });

  test('a failed listener keeps showing a store it already had', () => {
    const result = assignedStore('corner', { status: 'ready', value: [corner], fromCache: true });
    assert.equal(result.state, 'found');
  });

  test('absent only in the cache, or after a listener error, is unconfirmed: shown in list order, moves still wait', () => {
    for (const stores of [cached([]), failed]) {
      const result = assignedStore('corner', stores);
      assert.equal(result.state, 'unconfirmed');
      assert.equal(result.store, null);
      assert.equal(result.resolved, false);
      assert.equal(result.waitForStore, false);
    }
  });

  test('absent in a server snapshot is missing: the list falls back to its own order and can be changed', () => {
    const result = assignedStore('gone', server([corner]));
    assert.equal(result.state, 'missing');
    assert.equal(result.store, null);
    assert.equal(result.storeId, 'gone');
    assert.equal(result.resolved, true);
    assert.equal(result.waitForStore, false);
  });

  test('stores are listed once any snapshot or error has arrived', () => {
    assert.equal(storesListed(loading), false);
    assert.equal(storesListed(cached([])), true);
    assert.equal(storesListed(failed), true);
  });
});

describe('a new store starts from the order on screen (S6: SH-34b)', () => {
  test('while the list is at a store, that is the store order, not the list’s own', () => {
    const listOrder = ['Bakery', 'Dairy', 'Party', 'Other'];
    const shown = listOrderAtStore(['Party', 'Bakery', 'Dairy'], listOrder);
    assert.deepEqual(shown, ['Party', 'Bakery', 'Dairy', 'Other']);
    assert.deepEqual(initialAisleOrder(shown), ['Party', 'Bakery', 'Dairy']);
  });
});
