import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  classifyOpenFoodFactsError,
  classifyOpenFoodFactsReply,
  lookupErrorMiss,
  lookupMiss,
  lookupMissCopy,
} from '../../src/lib/barcode/lookup-outcome';

describe('Open Food Facts replies (BL-9)', () => {
  test('a found product', () => {
    assert.deepEqual(classifyOpenFoodFactsReply(200, { status: 'success', product: { product_name: 'Juice' } }),
      { kind: 'found', product: { product_name: 'Juice' } });
    assert.equal(classifyOpenFoodFactsReply(200, { status: 'success_with_warnings', product: {} }).kind, 'found');
    assert.equal(classifyOpenFoodFactsReply(200, { status: 1, product: {} }).kind, 'found');
  });

  test('unknown codes are "not found"', () => {
    assert.deepEqual(classifyOpenFoodFactsReply(404, null), { kind: 'not-found' });
    assert.deepEqual(classifyOpenFoodFactsReply(200, { status: 'failure' }), { kind: 'not-found' });
    assert.deepEqual(classifyOpenFoodFactsReply(200, { status: 0 }), { kind: 'not-found' });
    assert.deepEqual(classifyOpenFoodFactsReply(200, { status: 'success' }), { kind: 'not-found' });
  });

  test('outages, rate limits and unreadable replies are "unavailable", never "not found"', () => {
    assert.deepEqual(classifyOpenFoodFactsReply(429, null), { kind: 'unavailable', reason: 'rate_limited' });
    assert.deepEqual(classifyOpenFoodFactsReply(503, { status: 'failure' }), { kind: 'unavailable', reason: 'error' });
    assert.deepEqual(classifyOpenFoodFactsReply(200, null), { kind: 'unavailable', reason: 'error' });
    assert.deepEqual(classifyOpenFoodFactsReply(200, { status: 'weird' }), { kind: 'unavailable', reason: 'error' });
    assert.deepEqual(classifyOpenFoodFactsError(Object.assign(new Error('aborted'), { name: 'AbortError' })), { kind: 'unavailable', reason: 'timeout' });
    assert.deepEqual(classifyOpenFoodFactsError(new TypeError('fetch failed')), { kind: 'unavailable', reason: 'error' });
  });
});

describe('lookup misses on screen', () => {
  test('a named product is no miss; none and unavailable are told apart', () => {
    assert.equal(lookupMiss({ source: 'open_food_facts', productName: 'Juice' }), null);
    assert.equal(lookupMiss({ source: 'household', productName: 'Ours' }), null);
    assert.deepEqual(lookupMiss({ source: 'none', productName: null }), { kind: 'not-found' });
    assert.deepEqual(lookupMiss({ source: 'unavailable', productName: null, unavailableReason: 'timeout' }), { kind: 'unavailable', reason: 'timeout' });
    assert.deepEqual(lookupMiss({ source: 'unavailable' }), { kind: 'unavailable', reason: 'error' });
  });

  test('capacity and connection errors of the action read as unavailable; auth errors do not', () => {
    assert.deepEqual(lookupErrorMiss({ code: 'rate_limited' }), { kind: 'unavailable', reason: 'rate_limited' });
    assert.deepEqual(lookupErrorMiss({ code: 'timeout' }), { kind: 'unavailable', reason: 'timeout' });
    assert.deepEqual(lookupErrorMiss(new TypeError('Failed to fetch')), { kind: 'unavailable', reason: 'error' });
    assert.deepEqual(lookupErrorMiss(new Error('anything'), true), { kind: 'unavailable', reason: 'error' });
    assert.equal(lookupErrorMiss({ code: 'forbidden' }), null);
    assert.equal(lookupErrorMiss({ code: 'unauthenticated' }), null);
    assert.equal(lookupErrorMiss(new Error('boom')), null);
    assert.equal(lookupErrorMiss(null), null);
  });

  test('copy: not found offers the library; unavailable never says "not found"', () => {
    const notFound = lookupMissCopy({ kind: 'not-found' }, 'type the name instead');
    assert.equal(notFound.title, 'Product not found');
    assert.match(notFound.description, /Save it to your Barcode Library/);
    assert.doesNotMatch(lookupMissCopy({ kind: 'not-found' }, 'type the name instead', false).description, /Barcode Library/);
    for (const reason of ['timeout', 'rate_limited', 'error'] as const) {
      const copy = lookupMissCopy({ kind: 'unavailable', reason }, 'type the name instead');
      assert.equal(copy.title, 'Lookup unavailable');
      assert.doesNotMatch(copy.description, /not found|No product matches/i);
      assert.match(copy.description, /Try the scan again/);
    }
  });
});
