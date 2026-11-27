// The tablet's Shopping view (docs/modules/devices/README.md, "Shopping on the tablet"). Pure:
// the needed items of ONE list, all of them, oldest first, from that list's own live items
// (`neededListItems`); the kitchen view's list choice, rows, attribution and "is shopping" line
// (SH-11, SH-28), built on the personal overview's own helpers (src/lib/shopping/overview.ts,
// attribution.ts); and the entries an add may carry. The dashboard's preview
// (`computeShoppingFacts`) stays capped at its few first items across lists; the section view
// never filters that preview.

import { toDateValue } from '@/lib/dashboard/dates';
import { MAX_ITEM_QUANTITY, MAX_QUICK_ADD_ITEMS, itemNameKey, normalizeItemName } from '@/lib/shopping/items';
import { attributionLabel } from '@/lib/shopping/attribution';
import { chooseOverviewList, shoppingActivity, type ShoppingActivity } from '@/lib/shopping/overview';
import type { ShoppingList, ShoppingListItem } from '@/lib/types';

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

/** A list as the kitchen view reads it (`shopping-lists`). */
export type KitchenList = Pick<ShoppingList, 'id' | 'name' | 'type'> & { storeId: string | null };

export const kitchenLists = (docs: ReadonlyArray<{ id: string } & Record<string, unknown>>): KitchenList[] => docs
  .map((doc) => ({
    id: doc.id,
    name: typeof doc.name === 'string' && doc.name.trim() ? doc.name.trim() : 'List',
    type: (typeof doc.type === 'string' ? doc.type : 'Other') as ShoppingList['type'],
    storeId: typeof doc.storeId === 'string' && doc.storeId ? doc.storeId : null,
  }))
  .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));

/**
 * Which list the kitchen view shows (SH-11): the one in the address (`/shopping?list=`, the
 * tablet's start page or the switcher), else what the personal overview shows
 * (`chooseOverviewList`: the household's default Grocery list, else the only or first Grocery
 * list), else the first list of any kind. `waiting` while the household default is unknown.
 */
export function kitchenListChoice({ lists, pickedId, defaultListId, defaultKnown }: {
  lists: readonly KitchenList[];
  pickedId: string | null | undefined;
  defaultListId: string | null;
  defaultKnown: boolean;
}): { list: KitchenList | null; waiting: boolean } {
  const picked = pickedId ? lists.find((list) => list.id === pickedId) ?? null : null;
  if (picked) return { list: picked, waiting: false };
  const choice = chooseOverviewList({ lists, defaultListId, defaultKnown });
  if (choice.list || choice.waiting) return { list: choice.list, waiting: choice.waiting };
  return { list: lists[0] ?? null, waiting: false };
}

/** One item as the kitchen view reads it (the fields its rows, groups and the activity line use). */
export type KitchenItem = Pick<ShoppingListItem, 'id' | 'name' | 'quantity' | 'category' | 'status' | 'addedByUid' | 'purchasedByUid' | 'purchasedAt' | 'purchaseOpId'> & {
  createdAt: unknown;
  /** The tick was made on a wall tablet (its purchase attribution is bound to this purchase). */
  tickedOnTablet: boolean;
};

export const kitchenItems = (docs: ReadonlyArray<{ id: string } & Record<string, unknown>>): KitchenItem[] => docs.map((doc) => {
  const purchaseOpId = typeof doc.purchaseOpId === 'string' ? doc.purchaseOpId : undefined;
  const deviceTick = doc.purchaseDeviceAttribution && typeof doc.purchaseDeviceAttribution === 'object' ? doc.purchaseDeviceAttribution as { purchaseOpId?: unknown } : null;
  return {
    id: doc.id,
    name: typeof doc.name === 'string' && doc.name.trim() ? doc.name.trim() : 'Item',
    quantity: typeof doc.quantity === 'number' && Number.isFinite(doc.quantity) && doc.quantity > 0 ? doc.quantity : 1,
    category: typeof doc.category === 'string' && doc.category.trim() ? doc.category : 'Other',
    status: doc.status === 'purchased' ? 'purchased' : 'needed',
    addedByUid: typeof doc.addedByUid === 'string' ? doc.addedByUid : undefined,
    createdAt: doc.createdAt,
    purchasedByUid: typeof doc.purchasedByUid === 'string' ? doc.purchasedByUid : null,
    purchasedAt: doc.purchasedAt,
    purchaseOpId,
    tickedOnTablet: Boolean(purchaseOpId && deviceTick && deviceTick.purchaseOpId === purchaseOpId),
  };
});

/** First names of the people the tablet knows (its roster: never an email, WT-5a, WT-10e). */
export const rosterFirstNames = (roster: ReadonlyArray<{ uid: string; name: string }>): Map<string, string> =>
  new Map(roster.map((person) => [person.uid, person.name.split(/\s+/)[0] || person.name]));

/** "Sam added · 2d" (SH-28b): never "You" on a tablet (no one is signed in); an unknown adder reads "Member". */
export const kitchenAttribution = (item: Pick<KitchenItem, 'addedByUid' | 'createdAt'>, names: ReadonlyMap<string, string>, now: number): string | null =>
  attributionLabel({ addedByUid: item.addedByUid ?? null, createdAt: item.createdAt, currentUid: null, names, now });

/**
 * "Alex is shopping · 7 left" (SH-28c) on the tablet: the personal overview's rule (two ticks
 * by one member in the last 10 minutes) over the list's live items, except ticks made on a wall
 * tablet: ticking at home is not a trip. No one is "You" on a tablet.
 */
export const kitchenActivity = (items: readonly KitchenItem[], names: ReadonlyMap<string, string>, now: number): ShoppingActivity | null =>
  shoppingActivity({
    items: items.map((item) => ({ status: item.status, purchasedByUid: item.purchasedByUid, purchasedAt: item.purchasedAt, purchaseOpId: item.purchaseOpId })),
    now,
    uid: null,
    localOpIds: new Set(items.filter((item) => item.tickedOnTablet && item.purchaseOpId).map((item) => item.purchaseOpId!)),
    names,
  });
