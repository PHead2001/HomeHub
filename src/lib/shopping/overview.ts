/**
 * The Shopping overview's Grocery section (S8a: SH-11a–c, SH-28c), pure: which
 * Grocery list the overview shows, its needed items grouped by aisle, who is
 * shopping it right now, and which pantry items are about to expire. Unit tested
 * in tests/unit/shopping-overview.test.ts.
 */

import type { ShoppingList, ShoppingListItem } from '@/lib/types';
import { groupItemsByAisle, type AisleGroup } from './items';
import { groupingOrder, type CategoryConfig } from './category-order';
import { toMillis } from './attribution';
import { daysUntilExpiry } from './pantry';

/** The household's Grocery lists, in the order the lists are shown (by name). */
export const groceryListsOf = <T extends Pick<ShoppingList, 'type'>>(lists: readonly T[]): T[] =>
  lists.filter((list) => list.type === 'Grocery');

export type OverviewListChoice<T> = {
  /** The Grocery list the overview shows, or null (none, or still deciding). */
  list: T | null;
  /** Every Grocery list (more than one: the overview offers a switcher). */
  groceries: T[];
  /** The household default is not known yet: nothing is chosen, so no other list flashes first. */
  waiting: boolean;
};

/**
 * Which Grocery list the overview shows: the one picked in the switcher on this
 * screen, else the household default (`shopping-settings/preferences`
 * `defaultGroceryListId`) while it is still a Grocery list, else the only Grocery
 * list, else the one most recently used on this device, else the first by name.
 * While the default is still loading nothing is chosen (unless the member picked).
 */
export function chooseOverviewList<T extends Pick<ShoppingList, 'id' | 'type'>>({
  lists,
  defaultListId,
  defaultKnown,
  pickedId,
  recentId,
}: {
  lists: readonly T[];
  defaultListId: string | null | undefined;
  /** The default is known (`preferencesKnown`). */
  defaultKnown: boolean;
  pickedId?: string | null;
  recentId?: string | null;
}): OverviewListChoice<T> {
  const groceries = groceryListsOf(lists);
  const find = (id: string | null | undefined) => (id ? groceries.find((list) => list.id === id) ?? null : null);
  const picked = find(pickedId);
  if (picked) return { list: picked, groceries, waiting: false };
  if (groceries.length === 0) return { list: null, groceries, waiting: false };
  // The only Grocery list is the answer whatever the default says.
  if (groceries.length === 1) return { list: groceries[0], groceries, waiting: false };
  if (!defaultKnown) return { list: null, groceries, waiting: true };
  const chosen = find(defaultListId) ?? find(recentId) ?? groceries[0];
  return { list: chosen, groceries, waiting: false };
}

/**
 * Whether the household default is known: the preferences listener failed (then
 * there is none), or answered from the server, or from the cache when offline
 * or when the cache already names a default. A cached "no document" alone is not
 * proof, so a default set elsewhere never loses to a fallback list for a moment.
 */
export const preferencesKnown = ({
  status,
  fromCache,
  offline,
  defaultListId,
}: {
  status: 'loading' | 'ready' | 'error';
  fromCache: boolean;
  offline: boolean;
  defaultListId: string | null;
}): boolean => status === 'error' || (status === 'ready' && (!fromCache || offline || defaultListId !== null));

/**
 * The needed items grouped by aisle exactly as the open list groups them (S6): a
 * list at a store follows the store's aisle order, a list whose order was edited
 * (`ordered`) its own order, any other list the supermarket walk.
 */
export function neededAisleGroups<T extends Pick<ShoppingListItem, 'name' | 'category' | 'status'>>(
  items: readonly T[],
  config: Pick<CategoryConfig, 'list' | 'ordered'>,
  store: { aisleOrder: readonly unknown[] } | null,
): AisleGroup<T>[] {
  const needed = items.filter((item) => item.status === 'needed');
  return groupItemsByAisle(needed, config.list, store || config.ordered ? { order: groupingOrder(config.list, store) } : {});
}

/** The empty "Needed" copy: one message, never "empty" and "in the cart" together (SH-10g). */
export function neededEmptyCopy({ total, canEdit }: { total: number; canEdit: boolean }): { title: string; description: string } {
  if (total === 0) {
    return {
      title: 'This list is empty',
      description: canEdit ? 'Type items into the field, like "milk, eggs, 2 bread".' : 'Items your household adds will show up here.',
    };
  }
  return {
    title: 'Nothing left to buy',
    description: canEdit ? 'Everything is in the cart. Type more items into the field, like "milk, eggs".' : 'Everything on this list is in the cart.',
  };
}

/** How long a tick counts as "shopping now" (SH-28c). */
export const SHOPPING_WINDOW_MS = 10 * 60_000;
/** Ticks one member needs in the window to count as shopping (one tick at home is not a trip). */
export const SHOPPING_MIN_TICKS = 2;

export type ShoppingActivity = {
  /** Who is shopping, most recent first (uids). */
  shopperUids: string[];
  /** Items still needed on the list. */
  left: number;
  /** "Alex is shopping · 7 left". */
  label: string;
};

/**
 * "Alex is shopping · 7 left" (SH-28c), from the list's live items alone: a
 * member is shopping when at least `minTicks` items carry their `purchasedByUid`
 * with a server `purchasedAt` inside the last `windowMs`. Ticks this device made
 * (their `purchaseOpId` is in `localOpIds`) never count, so the label names
 * someone else, or "You" on another device. A `purchasedAt` slightly in the
 * future (this device's clock is behind the server's) counts as now, up to one
 * window. A tick not yet acknowledged has no `purchasedAt` and does not count.
 */
export function shoppingActivity({
  items,
  now,
  uid,
  localOpIds,
  names,
  windowMs = SHOPPING_WINDOW_MS,
  minTicks = SHOPPING_MIN_TICKS,
}: {
  items: readonly Pick<ShoppingListItem, 'status' | 'purchasedByUid' | 'purchasedAt' | 'purchaseOpId'>[];
  now: number;
  uid: string | null | undefined;
  localOpIds: ReadonlySet<string>;
  names: ReadonlyMap<string, string>;
  windowMs?: number;
  minTicks?: number;
}): ShoppingActivity | null {
  const ticks = new Map<string, { count: number; latest: number }>();
  for (const item of items) {
    if (item.status !== 'purchased' || !item.purchasedByUid) continue;
    if (item.purchaseOpId && localOpIds.has(item.purchaseOpId)) continue;
    const at = toMillis(item.purchasedAt);
    if (at === null) continue;
    const age = now - at;
    if (age > windowMs || age < -windowMs) continue;
    const entry = ticks.get(item.purchasedByUid) ?? { count: 0, latest: -Infinity };
    entry.count += 1;
    entry.latest = Math.max(entry.latest, at);
    ticks.set(item.purchasedByUid, entry);
  }
  const shopperUids = [...ticks.entries()]
    .filter(([, entry]) => entry.count >= minTicks)
    .sort((a, b) => b[1].latest - a[1].latest)
    .map(([shopper]) => shopper);
  if (shopperUids.length === 0) return null;
  const left = items.filter((item) => item.status === 'needed').length;
  const who = shopperUids.map((shopper) => (shopper === uid ? 'You' : names.get(shopper) ?? 'Someone'));
  const subject = who.length === 1
    ? (who[0] === 'You' ? 'You are shopping on another device' : `${who[0]} is shopping`)
    : `${who.slice(0, -1).join(', ')} and ${who[who.length - 1]} are shopping`;
  const tail = left === 0 ? 'all in the cart' : `${left} left`;
  return { shopperUids, left, label: `${subject} · ${tail}` };
}

export type ExpiringChip = { id: string; name: string; days: number; when: string };

/** "expired", "today", "tomorrow", "in 3 days". */
export function expiryWhen(days: number): string {
  if (days < 0) return 'expired';
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  return `in ${days} days`;
}

/** Days ahead that count as "expiring soon" (the pantry's own "soon" state). */
export const EXPIRING_HORIZON_DAYS = 3;

/**
 * The pantry chips on the overview (SH-11c): items that expired or expire within
 * `horizonDays` of the household's today (`today`, YYYY-MM-DD in the household
 * zone), soonest first, at most `limit` (the rest are counted in `more`). Expiry
 * is read only through the pantry's own `daysUntilExpiry`, with the household day
 * as its "now", so a date-only expiry is a household calendar day.
 */
export function expiringChips(
  items: readonly { id: string; name?: unknown; expiryDate?: unknown }[],
  today: string,
  { horizonDays = EXPIRING_HORIZON_DAYS, limit = 8 }: { horizonDays?: number; limit?: number } = {},
): { chips: ExpiringChip[]; more: number } {
  const dayStart = new Date(`${today}T00:00:00`);
  if (Number.isNaN(dayStart.getTime())) return { chips: [], more: 0 };
  const soon: ExpiringChip[] = [];
  for (const item of items) {
    const days = daysUntilExpiry(typeof item.expiryDate === 'string' ? item.expiryDate : null, dayStart);
    if (days === null || days > horizonDays) continue;
    const name = typeof item.name === 'string' && item.name.trim() ? item.name.trim() : 'Pantry item';
    soon.push({ id: item.id, name, days, when: expiryWhen(days) });
  }
  soon.sort((a, b) => a.days - b.days || a.name.localeCompare(b.name));
  return { chips: soon.slice(0, limit), more: Math.max(0, soon.length - limit) };
}

/** Where this device remembers the Grocery list it used last, per household. */
export const RECENT_GROCERY_KEY = 'homehub.shopping.recentGrocery.v1';

type KeyValueStorage = Pick<Storage, 'getItem' | 'setItem'>;

/** The stored map (household id -> list id); a missing, blocked or corrupt entry reads as empty. */
function readRecentMap(storage: KeyValueStorage): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(storage.getItem(RECENT_GROCERY_KEY) ?? '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? { ...(parsed as Record<string, unknown>) } : {};
  } catch {
    return {};
  }
}

/** The Grocery list this device used last in `householdId`, or null (also when storage is blocked). */
export function readRecentGrocery(storage: KeyValueStorage | null, householdId: string | null | undefined): string | null {
  if (!storage || !householdId) return null;
  const value = readRecentMap(storage)[householdId];
  return typeof value === 'string' && value ? value : null;
}

/** Remembers `listId` as this device's most recently used Grocery list in `householdId`. */
export function rememberRecentGrocery(storage: KeyValueStorage | null, householdId: string | null | undefined, listId: string): void {
  if (!storage || !householdId || !listId) return;
  const map = readRecentMap(storage);
  if (map[householdId] === listId) return;
  map[householdId] = listId;
  try {
    storage.setItem(RECENT_GROCERY_KEY, JSON.stringify(map));
  } catch {
    // Storage blocked or full: the overview falls back to the first Grocery list.
  }
}

/** `localStorage`, or null where it cannot be reached (private mode, blocked site data). */
export function browserStorage(): KeyValueStorage | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}
