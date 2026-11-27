// The tablet's shopping list view (docs/modules/devices/README.md, "Tablet shell"). Pure:
// the needed items of ONE list, all of them, oldest first, from that list's own live items.
// The dashboard's preview (`computeShoppingFacts`) stays capped at its few first items
// across lists; the section view never filters that preview.

import { toDateValue } from '@/lib/dashboard/dates';
import { MAX_ITEM_QUANTITY, MAX_QUICK_ADD_ITEMS, itemNameKey, normalizeItemName } from '@/lib/shopping/items';

export type TabletShoppingItem = { id: string; name: string; quantity: number };

export function neededListItems(docs: ReadonlyArray<{ id: string } & Record<string, unknown>>): TabletShoppingItem[] {
  return docs
    .filter((item) => item.status !== 'purchased')
    .map((item) => ({ item, at: toDateValue(item.createdAt)?.getTime() ?? 0 }))
    .sort((a, b) => a.at - b.at || a.item.id.localeCompare(b.item.id))
    .map(({ item }) => ({
      id: item.id,
      name: typeof item.name === 'string' && item.name.trim() ? item.name.trim() : 'Item',
      quantity: typeof item.quantity === 'number' && Number.isFinite(item.quantity) && item.quantity > 0 ? item.quantity : 1,
    }));
}

export type AddEntryInput = { name: string; quantity: number };

/**
 * The entries of one `shopping.add` (the tablet's quick add, checked again by the server):
 * as the personal quick add parses them (`parseQuickAdd`), a name of at most 120 characters
 * after `normalizeItemName`, a whole quantity from 1 to 999, at most 20 entries, one per name
 * (repeats add up, capped at 999). Null when anything is out of shape.
 */
export function deviceAddEntries(value: unknown): AddEntryInput[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_QUICK_ADD_ITEMS) return null;
  const merged = new Map<string, AddEntryInput>();
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') return null;
    const { name, quantity } = raw as { name?: unknown; quantity?: unknown };
    if (typeof name !== 'string' || name.length > 500) return null;
    const clean = normalizeItemName(name);
    if (!clean) return null;
    if (typeof quantity !== 'number' || !Number.isInteger(quantity) || quantity < 1 || quantity > MAX_ITEM_QUANTITY) return null;
    const key = itemNameKey(clean);
    const existing = merged.get(key);
    if (existing) existing.quantity = Math.min(MAX_ITEM_QUANTITY, existing.quantity + quantity);
    else merged.set(key, { name: clean, quantity });
  }
  return [...merged.values()];
}
