import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { MAX_PUSH_TOKENS, nextPushTokens } from '../../src/lib/push-tokens';

const tokens = (count: number, prefix = 't') => Array.from({ length: count }, (_, i) => `${prefix}${i}`);

describe('push token list on subscribe', () => {
  test('adds this device after the stored and legacy tokens', () => {
    assert.deepEqual(nextPushTokens(['a', 'b'], ['c'], 'new'), ['a', 'b', 'c', 'new']);
    assert.deepEqual(nextPushTokens(undefined, undefined, 'new'), ['new']);
  });

  test('removes duplicates and moves a re-subscribing device to the end', () => {
    assert.deepEqual(nextPushTokens(['a', 'new', 'b'], ['b', 'a'], 'new'), ['a', 'b', 'new']);
  });

  test('never exceeds the rules cap: the oldest tokens make room', () => {
    const full = tokens(MAX_PUSH_TOKENS);
    const next = nextPushTokens(full, [], 'new');
    assert.equal(next.length, MAX_PUSH_TOKENS);
    assert.equal(next[next.length - 1], 'new');
    assert.equal(next.includes('t0'), false);
    assert.equal(next[0], 't1');
  });

  test('legacy tokens count toward the cap and the device token always survives', () => {
    const next = nextPushTokens(tokens(15, 's'), tokens(10, 'l'), 'new');
    assert.equal(next.length, MAX_PUSH_TOKENS);
    assert.deepEqual(next.slice(-3), ['l8', 'l9', 'new']);
    assert.equal(next.includes('s5'), false);
    assert.equal(next.includes('s6'), true);
  });

  test('ignores malformed stored values', () => {
    assert.deepEqual(nextPushTokens('not-a-list', [1, null, '', 'a'], 'new'), ['a', 'new']);
  });
});
