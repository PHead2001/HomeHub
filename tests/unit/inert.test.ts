import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { version } from 'react';
import { inertProps } from '../../src/lib/inert';

describe('inertProps', () => {
  test('nothing when the element is not inert, whichever React runs', () => {
    assert.deepEqual(inertProps(false, '18.3.1'), {});
    assert.deepEqual(inertProps(false, '19.3.0-canary-278794d7-20261002'), {});
  });

  test('React 19 (Next App Router) gets the boolean it reads as the attribute', () => {
    assert.deepEqual(inertProps(true, '19.3.0-canary-278794d7-20261002'), { inert: true });
    assert.deepEqual(inertProps(true, '19.0.0'), { inert: true });
    assert.deepEqual(inertProps(true, '20.0.0'), { inert: true });
  });

  test('React 18 gets the string it writes as the attribute', () => {
    assert.deepEqual(inertProps(true, '18.3.1'), { inert: '' });
  });

  test('defaults to the React that is loaded', () => {
    const expected = Number.parseInt(version, 10) >= 19 ? true : '';
    assert.deepEqual(inertProps(true), { inert: expected });
  });
});
