import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tapBelongsToAnotherLayer } from '../../src/lib/ui/outside-tap';

const node = (isConnected: boolean, inDialog: boolean) => ({ isConnected, closest: (selector: string) => (inDialog && selector.includes('dialog') ? {} : null) });

test('a tap on the page (or this dialog\'s own overlay) is an outside tap', () => {
  assert.equal(tapBelongsToAnotherLayer(node(true, false)), false);
});

test('a tap whose target already left the page (a dialog above that closed on that tap) is not', () => {
  assert.equal(tapBelongsToAnotherLayer(node(false, false)), true);
  assert.equal(tapBelongsToAnotherLayer(node(false, true)), true);
});

test('a tap inside another open dialog is not', () => {
  assert.equal(tapBelongsToAnotherLayer(node(true, true)), true);
});

test('no usable target is never read as an outside tap', () => {
  assert.equal(tapBelongsToAnotherLayer(null), true);
  assert.equal(tapBelongsToAnotherLayer(undefined), true);
  assert.equal(tapBelongsToAnotherLayer(window_like()), true);
});

function window_like() { return {}; }
