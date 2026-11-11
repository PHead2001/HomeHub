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
  selfKnown = true,
}: {
  items: readonly Pick<ShoppingListItem, 'status' | 'purchasedByUid' | 'purchasedAt' | 'purchaseOpId'>[];
  now: number;
  uid: string | null | undefined;
  /** This device's recent ticks (`readLocalTicks`, kept across reloads). */
  localOpIds: ReadonlySet<string>;
  names: ReadonlyMap<string, string>;
  windowMs?: number;
  minTicks?: number;
  /**
   * Whether `localOpIds` is complete (`readLocalTicks` `reliable`). When it is
   * not (storage unavailable), the member's own ticks never count: no "You are
   * shopping on another device" that may be this device before a reload.
   */
  selfKnown?: boolean;
}): ShoppingActivity | null {
  const ticks = new Map<string, { count: number; latest: number }>();
  for (const item of items) {
    if (item.status !== 'purchased' || !item.purchasedByUid) continue;
    if (item.purchaseOpId && localOpIds.has(item.purchaseOpId)) continue;
    if (!selfKnown && item.purchasedByUid === uid) continue;
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

/**
 * Whether an overview write (a quick-add, a tick) may run against `targetListId`
 * now: the page's items and categories listener must follow that list and both
 * must have answered. Before that the known items are empty or another list's,
 * so a duplicate name would not merge into the needed item (it would be added
 * twice) and a category guess would use the wrong list.
 */
export const overviewWriteReady = ({
  targetListId,
  itemsListId,
  itemsStatus,
  categoriesStatus,
}: {
  targetListId: string | null | undefined;
  itemsListId: string | null | undefined;
  itemsStatus: 'loading' | 'ready' | 'error';
  categoriesStatus: 'loading' | 'ready' | 'error';
}): boolean => Boolean(targetListId) && targetListId === itemsListId && itemsStatus !== 'loading' && categoriesStatus !== 'loading';

/** Where this device keeps the purchase ids of its own recent ticks (SH-28c), per household and list. */
export const LOCAL_TICKS_KEY = 'homehub.shopping.localTicks.v1';
/** Own ticks are kept a little longer than the activity window (server and device clocks may differ). */
export const LOCAL_TICKS_KEEP_MS = 2 * SHOPPING_WINDOW_MS;

type LocalTick = { opId: string; at: number };

/** The stored map ("household/list" -> ticks), pruned; null when storage cannot be read. */
function readLocalTickMap(storage: KeyValueStorage, now: number): Record<string, LocalTick[]> | null {
  let raw: string | null;
  try {
    raw = storage.getItem(LOCAL_TICKS_KEY);
  } catch {
    return null;
  }
  let parsed: unknown = {};
  try {
    parsed = JSON.parse(raw ?? '{}');
  } catch {
    parsed = {};
  }
  const map: Record<string, LocalTick[]> = {};
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return map;
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!Array.isArray(value)) continue;
    const kept = value.filter((tick): tick is LocalTick => Boolean(tick)
      && typeof (tick as LocalTick).opId === 'string'
      && typeof (tick as LocalTick).at === 'number'
      && now - (tick as LocalTick).at <= LOCAL_TICKS_KEEP_MS
      && (tick as LocalTick).at - now <= LOCAL_TICKS_KEEP_MS);
    if (kept.length > 0) map[key] = kept;
  }
  return map;
}

const localTicksKey = (householdId: string, listId: string) => `${householdId}/${listId}`;

/**
 * This device's own recent ticks on one list (their purchase ids), restored from
 * storage and pruned to `LOCAL_TICKS_KEEP_MS`. `reliable` is false when storage
 * cannot be read or written: then the device cannot tell its own earlier ticks
 * (from before a reload) from another device's, and the overview shows no "You
 * are shopping on another device" (other members still show).
 */
export function readLocalTicks(
  storage: KeyValueStorage | null,
  householdId: string | null | undefined,
  listId: string | null | undefined,
  now: number,
): { opIds: Set<string>; reliable: boolean } {
  if (!householdId || !listId) return { opIds: new Set(), reliable: true };
  if (!storage) return { opIds: new Set(), reliable: false };
  const map = readLocalTickMap(storage, now);
  if (!map) return { opIds: new Set(), reliable: false };
  return { opIds: new Set((map[localTicksKey(householdId, listId)] ?? []).map((tick) => tick.opId)), reliable: true };
}

/** Records one of this device's ticks; false when it could not be stored (storage blocked or full). */
export function recordLocalTick(
  storage: KeyValueStorage | null,
  householdId: string | null | undefined,
  listId: string | null | undefined,
  opId: string,
  now: number,
): boolean {
  if (!storage || !householdId || !listId || !opId) return false;
  const map = readLocalTickMap(storage, now);
  if (!map) return false;
  const key = localTicksKey(householdId, listId);
  map[key] = [...(map[key] ?? []).filter((tick) => tick.opId !== opId), { opId, at: now }].slice(-200);
  try {
    storage.setItem(LOCAL_TICKS_KEY, JSON.stringify(map));
    return true;
  } catch {
    return false;
  }
}
