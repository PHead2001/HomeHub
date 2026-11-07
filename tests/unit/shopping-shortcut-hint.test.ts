import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { matchShortcut } from '../../src/lib/dashboard/shortcuts';
import { ADD_SHOPPING_ITEM_SHORTCUT, shortcutTitle } from '../../src/lib/shopping/shortcut-hint';

describe('shopping shortcut hints (H28)', () => {
  it('reads the Add item key from the global shortcut map', () => {
    assert.equal(shortcutTitle('Add item', ADD_SHOPPING_ITEM_SHORTCUT), 'Add item (A)');
    // The hinted key really is the add-item shortcut.
    const { action } = matchShortcut({ key: 'a' }, false, () => true);
    assert.deepEqual(action, { type: 'quick-add', prefix: 'add ' });
  });

  it('falls back to the plain label for an unknown shortcut', () => {
    assert.equal(shortcutTitle('Add item', 'No such shortcut'), 'Add item');
  });
});
