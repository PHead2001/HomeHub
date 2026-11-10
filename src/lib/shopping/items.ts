/**
 * Pure helpers for shopping-list items: name normalization, duplicate matching,
 * the inline quick-add parser and store-walk grouping. No Firebase imports, so
 * they are unit tested directly (tests/unit/shopping-logic.test.ts).
 */

import type { ShoppingListItem } from '@/lib/types';

/** Longest item name accepted from quick-add and the add-item dialog. */
export const MAX_ITEM_NAME_LENGTH = 120;
/** Most items one quick-add submission may create. */
export const MAX_QUICK_ADD_ITEMS = 20;
/** Highest quantity a quick-add entry may carry. */
export const MAX_ITEM_QUANTITY = 999;

/**
 * Display form of a typed item name: trimmed, inner whitespace collapsed, and the
 * first letter capitalised when the member typed it all lower case ("milk" ->
 * "Milk"). Names with deliberate casing ("iPhone cable", "BBQ sauce") are kept.
 */
export function normalizeItemName(value: string): string {
  const collapsed = value.replace(/\s+/g, ' ').trim().slice(0, MAX_ITEM_NAME_LENGTH).trim();
  if (!collapsed) return '';
  if (collapsed === collapsed.toLowerCase()) {
    return collapsed.charAt(0).toUpperCase() + collapsed.slice(1);
  }
  return collapsed;
}

/** Case- and whitespace-insensitive key used to merge duplicates ("milk" == " Milk "). */
export function itemNameKey(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLocaleLowerCase();
}

/**
 * The still-needed item an added name should merge into, if any. Purchased items
 * are left alone: they belong to the trip in progress.
 */
export function findMergeTarget<T extends Pick<ShoppingListItem, 'name' | 'status'>>(items: readonly T[], name: string): T | undefined {
  const key = itemNameKey(name);
  if (!key) return undefined;
  return items.find((item) => item.status === 'needed' && itemNameKey(item.name) === key);
}

export type QuickAddEntry = { name: string; quantity: number };

const clampQuantity = (value: number) => Math.min(MAX_ITEM_QUANTITY, Math.max(1, Math.round(value)));

/** One quick-add token: "2 bread", "bread x2", "2x bread", "3 × eggs" or "milk". */
function parseEntry(token: string): QuickAddEntry | null {
  const text = token.replace(/\s+/g, ' ').trim();
  if (!text) return null;

  // Leading count: "2 bread", "2x bread", "2 x bread", "2× bread".
  // ("2xbread" is not split, so names like "2xl shirt" stay intact.)
  let match = /^(\d{1,3})\s*(?:[x×]\s+|\s+)(.+)$/i.exec(text);
  if (match) {
    const name = normalizeItemName(match[2]);
    return name ? { name, quantity: clampQuantity(Number(match[1])) } : null;
  }
  // Trailing count: "bread x2", "bread ×2", "bread x 2".
  match = /^(.+?)\s+[x×]\s*(\d{1,3})$/i.exec(text);
  if (match) {
    const name = normalizeItemName(match[1]);
    return name ? { name, quantity: clampQuantity(Number(match[2])) } : null;
  }
  const name = normalizeItemName(text);
  return name ? { name, quantity: 1 } : null;
}

/**
 * Parses the inline quick-add field: entries are separated by commas, semicolons
 * or new lines; each may carry a count. Repeated names in one submission are
 * merged (quantities add up). At most {@link MAX_QUICK_ADD_ITEMS} entries are kept.
 */
export function parseQuickAdd(input: string): QuickAddEntry[] {
  const merged = new Map<string, QuickAddEntry>();
  for (const token of input.split(/[,;\n]+/)) {
    const entry = parseEntry(token);
    if (!entry) continue;
    const key = itemNameKey(entry.name);
    const existing = merged.get(key);
    if (existing) {
      existing.quantity = clampQuantity(existing.quantity + entry.quantity);
    } else {
      if (merged.size >= MAX_QUICK_ADD_ITEMS) continue;
      merged.set(key, { ...entry });
    }
  }
  return [...merged.values()];
}

/**
 * Splits `Promise.allSettled` results for a list of entries into what was saved
 * and what failed, so a partial failure keeps only the failed entries for retry
 * (retrying the whole text would add the saved ones twice).
 */
export function splitSettled<E, R>(
  entries: readonly E[],
  settled: readonly PromiseSettledResult<R>[],
): { succeeded: R[]; failed: E[]; firstError?: unknown } {
  const succeeded: R[] = [];
  const failed: E[] = [];
  let firstError: unknown;
  settled.forEach((result, index) => {
    if (result.status === 'fulfilled') {
      succeeded.push(result.value);
    } else {
      failed.push(entries[index]);
      if (firstError === undefined) firstError = result.reason;
    }
  });
  return firstError === undefined ? { succeeded, failed } : { succeeded, failed, firstError };
}

/** Quick-add text for entries, so failed ones can be put back in the field: "2 Bread, Milk". */
export function formatQuickAddEntries(entries: readonly QuickAddEntry[]): string {
  return entries.map((entry) => (entry.quantity > 1 ? `${entry.quantity} ${entry.name}` : entry.name)).join(', ');
}

/**
 * The quick-add field after a save: the failed entries (if any) go back in front
 * of whatever the member has typed since the submit, which is new input and is
 * kept as is. Leading separators the member typed (", eggs") are dropped so the
 * result reads as one list. With nothing failed the current text is unchanged.
 */
export function mergeRetryText(failed: readonly QuickAddEntry[], current: string): string {
  const retry = formatQuickAddEntries(failed);
  if (!retry) return current;
  const typed = current.replace(/^[\s,;]+/, '').trim();
  return typed ? `${retry}, ${typed}` : retry;
}

/** Inline message naming the entries that could not be added. */
export function quickAddFailureMessage(failed: readonly QuickAddEntry[]): string | null {
  if (failed.length === 0) return null;
  const names = failed.map((entry) => entry.name);
  const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  return `Couldn't add ${list}. ${failed.length === 1 ? 'It is' : 'They are'} still in the field; press Add to try again.`;
}

/**
 * The order a typical supermarket walk visits departments: fresh produce at the
 * door, then bakery, deli/meat, dairy along the back wall, frozen, the centre
 * aisles, and household goods by the tills.
 */
export const STORE_WALK_ORDER = ['Produce', 'Bakery', 'Meat', 'Dairy', 'Frozen', 'Pantry', 'Snacks', 'Drinks', 'Household'] as const;

export type AisleGroup<T> = { category: string; items: T[] };

/**
 * Groups items by category in store-walk order: known departments first in
 * {@link STORE_WALK_ORDER}, then the list's custom categories in their configured
 * order, then categories that only exist on items (for example one removed from
 * the list's configuration, so its items never disappear), and `Other` last.
 * Items inside a group are sorted by name.
 */
export function groupItemsByAisle<T extends Pick<ShoppingListItem, 'name' | 'category'>>(
  items: readonly T[],
  configuredCategories: readonly string[],
): AisleGroup<T>[] {
  const byCategory = new Map<string, T[]>();
  for (const item of items) {
    const category = item.category?.trim() || 'Other';
    const bucket = byCategory.get(category);
    if (bucket) bucket.push(item);
    else byCategory.set(category, [item]);
  }

  const walkIndex = (category: string) => {
    const index = STORE_WALK_ORDER.findIndex((known) => known.toLowerCase() === category.toLowerCase());
    return index;
  };
  const configuredIndex = (category: string) => configuredCategories.findIndex((c) => c.toLowerCase() === category.toLowerCase());

  const rank = (category: string): [number, number, string] => {
    if (category.toLowerCase() === 'other') return [3, 0, category];
    const walk = walkIndex(category);
    if (walk >= 0) return [0, walk, category];
    const configured = configuredIndex(category);
    if (configured >= 0) return [1, configured, category];
    return [2, 0, category.toLowerCase()];
  };

  return [...byCategory.entries()]
    .sort(([a], [b]) => {
      const [ga, ia, na] = rank(a);
      const [gb, ib, nb] = rank(b);
      return ga - gb || ia - ib || na.localeCompare(nb);
    })
    .map(([category, groupItems]) => ({
      category,
      items: [...groupItems].sort((x, y) => x.name.localeCompare(y.name)),
    }));
}

/**
 * Whether an addition may be folded into this item, judged from the item as just
 * read inside a transaction (never from the cached list): only while it exists
 * and is still needed. A bought or deleted item gets a new needed item instead.
 */
export function canMergeInto(data: { status?: unknown } | undefined | null): boolean {
  return Boolean(data) && data!.status === 'needed';
}

/** Whether a confirmed (just read) item may be removed by "Clear purchased". */
export function isStillPurchased(data: { status?: unknown } | undefined | null): boolean {
  return Boolean(data) && data!.status === 'purchased';
}

/**
 * Whether the open list is finished, from a confirmed re-read: it has items and
 * none is still needed. Drives the trip receipt online.
 */
export function isTripComplete(items: readonly { status?: unknown }[]): boolean {
  return items.length > 0 && items.every((item) => item.status !== 'needed');
}

/** `items` without the given ids (for removing exactly what a write deleted). */
export function withoutIds<T extends { id: string }>(items: readonly T[], ids: Iterable<string>): T[] {
  const drop = new Set(ids);
  return items.filter((item) => !drop.has(item.id));
}

/** "1 item", "3 items". */
export function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

/** Fields a restore never writes back: stamps that only the writer of the moment may set (rules: request.time, own uid). */
const RESTORE_DROPS = ['purchasedByUid', 'purchasedAt', 'editedByUid', 'editedAt', 'undoOpId', 'restoreOpId', 'restoredAt'] as const;

/**
 * The document an Undo-after-delete writes back: the item as it was read,
 * keeping its original `addedByUid`, plus `restoredByUid` naming the signed-in
 * member who restored it (the rules accept another member's `addedByUid` on a
 * create only together with the writer's own `restoredByUid`) and, from S3, a
 * fresh `restoreOpId` (accepted only on a create, so a restore never overwrites
 * an item that exists again). Purchase and edit stamps are not written back (the
 * rules accept them only as the writer's own uid and the server's time; a restore
 * keeps its status and purchaseOpId). `restoreDocument` (item-writes.ts) adds
 * `restoredAt` at write time.
 * Without a signed-in uid the snapshot is returned as a copy, without the stamps.
 */
export function restoreItemData<T extends object>(
  snapshot: T,
  restorerUid: string | null | undefined,
  restoreOpId?: string,
): T & { restoredByUid?: string; restoreOpId?: string } {
  const copy: Record<string, unknown> = { ...(snapshot as Record<string, unknown>) };
  for (const key of RESTORE_DROPS) delete copy[key];
  if (!restorerUid) return copy as T;
  return { ...copy, restoredByUid: restorerUid, ...(restoreOpId ? { restoreOpId } : {}) } as T & { restoredByUid?: string; restoreOpId?: string };
}
