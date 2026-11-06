import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { parseSharedContent } from '../../src/lib/share-target';
import { buildShoppingListItem, normalizeSourceUrl, normalizeStoredCategories } from '../../src/lib/shopping-items';

describe('share target parsing', () => {
  test('uses the shared title as the item name and keeps the http(s) URL', () => {
    const shared = parseSharedContent({ title: '  Oat   milk ', url: 'https://example.com/oat-milk' });
    assert.equal(shared.itemName, 'Oat milk');
    assert.equal(shared.url, 'https://example.com/oat-milk');
  });

  test('finds a link inside shared text when no url parameter is sent (Android)', () => {
    const shared = parseSharedContent({ text: 'Best banana bread https://recipes.example.org/banana-bread' });
    assert.equal(shared.url, 'https://recipes.example.org/banana-bread');
    assert.equal(shared.itemName, 'Best banana bread');
  });

  test('falls back to the host name when only a link is shared', () => {
    assert.equal(parseSharedContent({ url: 'https://www.example.com/p/123' }).itemName, 'example.com');
  });

  test('drops non-http links and caps the item name length', () => {
    const shared = parseSharedContent({ title: 'x'.repeat(300), url: 'javascript:alert(1)' });
    assert.equal(shared.url, undefined);
    assert.ok(shared.itemName.length <= 120);
  });

  test('empty shares produce an empty, editable name', () => {
    assert.deepEqual(parseSharedContent({}), { itemName: '' });
  });
});

describe('shopping item contract', () => {
  test('builds the same document shape as the Shopping Lists tab and omits empty optional fields', () => {
    const { itemId, data } = buildShoppingListItem({ name: 'Whole milk', quantity: 2, category: 'Dairy' });
    assert.match(itemId, /^whole-milk-[a-z0-9]{1,4}$/);
    assert.equal(data.status, 'needed');
    assert.equal(data.quantity, 2);
    assert.ok(data.createdAt instanceof Date);
    assert.deepEqual(Object.keys(data).sort(), ['category', 'createdAt', 'name', 'quantity', 'status']);
  });

  test('keeps a valid source URL', () => {
    const { data } = buildShoppingListItem({ name: 'Flour', quantity: 1, category: 'Pantry', sourceUrl: 'https://example.com/flour' });
    assert.equal(data.sourceUrl, 'https://example.com/flour');
  });

  test('normalizes URLs and stored categories', () => {
    assert.equal(normalizeSourceUrl('ftp://example.com'), undefined);
    assert.equal(normalizeSourceUrl('not a url'), undefined);
    assert.deepEqual(normalizeStoredCategories({ list: ['Produce', 3, 'Dairy'] }), ['Produce', 'Dairy', 'Other']);
    assert.equal(normalizeStoredCategories(undefined), null);
  });
});
