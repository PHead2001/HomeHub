// The tablet's shopping list view (docs/modules/devices/README.md, "Tablet shell"). Pure:
// the needed items of ONE list, all of them, oldest first, from that list's own live items.
// The dashboard's preview (`computeShoppingFacts`) stays capped at its few first items
// across lists; the section view never filters that preview.

import { toDateValue } from '@/lib/dashboard/dates';

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
