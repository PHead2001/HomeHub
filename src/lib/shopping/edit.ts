/** The item edit sheet's pure logic (S3, SH-8a): what an edit writes. Unit tested in tests/unit/shopping-undo.test.ts. */
import { itemNameKey, normalizeItemName } from './items';
import type { ShoppingListItem } from '@/lib/types';

/** The fields an edit changes (only those that differ from the item). */
export type ItemEditChanges = {
  name?: string;
  nameKey?: string;
  quantity?: number;
  category?: string;
  categorySource?: 'manual';
};

export const MAX_ITEM_NAME = 120;
export const MAX_EDIT_QUANTITY = 999;

/**
 * What an edit writes: only the fields that differ, so another member's change to
 * a field this edit did not touch is kept. A new name gets its `nameKey`; a new
 * category is the member's choice (`categorySource: 'manual'`, so a late AI answer
 * never overrides it). Returns an error message instead when a value is invalid.
 */
export function planItemEdit(
  item: Pick<ShoppingListItem, 'name' | 'quantity' | 'category'>,
  draft: { name: string; quantity: number; category: string },
): { changes: ItemEditChanges } | { error: { field: 'name' | 'quantity'; message: string } } {
  const name = normalizeItemName(draft.name);
  if (!name) return { error: { field: 'name', message: 'Item name is required.' } };
  if (name.length > MAX_ITEM_NAME) return { error: { field: 'name', message: `Keep the name under ${MAX_ITEM_NAME} characters.` } };
  if (!Number.isInteger(draft.quantity) || draft.quantity < 1) return { error: { field: 'quantity', message: 'Quantity must be a whole number, at least 1.' } };
  if (draft.quantity > MAX_EDIT_QUANTITY) return { error: { field: 'quantity', message: `Quantity must be ${MAX_EDIT_QUANTITY} or less.` } };
  const changes: ItemEditChanges = {};
  if (name !== item.name) {
    changes.name = name;
    changes.nameKey = itemNameKey(name);
  }
  if (draft.quantity !== item.quantity) changes.quantity = draft.quantity;
  if (draft.category && draft.category !== item.category) {
    changes.category = draft.category;
    changes.categorySource = 'manual';
  }
  return { changes };
}
