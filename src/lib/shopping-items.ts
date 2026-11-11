import type { ShoppingListItem } from '@/lib/types';
import { slugify } from '@/lib/utils';
import { dedupeCategories, isOtherCategory, readCategoryConfig } from '@/lib/shopping/category-order';
import { itemNameKey } from '@/lib/shopping/items';
import type { CategorySource } from '@/lib/shopping/local-categories';
import { packageSize } from '@/lib/shopping/scan';

export const DEFAULT_SHOPPING_CATEGORIES = ['Produce', 'Dairy', 'Meat', 'Bakery', 'Pantry', 'Frozen', 'Snacks', 'Drinks', 'Household', 'Other'];

/**
 * Categories stored at `config/categories`, always including `Other` (the AI
 * fallback). With `ordered` (S6) they are read as the Shopping screen reads
 * them (`readCategoryConfig`: `list` decides which exist, `ordered` the order);
 * otherwise `list` as stored. Spellings that differ only in case or spacing are
 * one category ("dairy" and "Dairy", SH-10d): the first one is kept.
 */
export function normalizeStoredCategories(value: unknown): string[] | null {
  if (!value || typeof value !== 'object' || !('list' in value || 'ordered' in value)) return null;
  if (Array.isArray((value as { ordered?: unknown }).ordered)) return readCategoryConfig(value, true, []).list;
  const list = (value as { list?: unknown }).list;
  const stored = dedupeCategories(Array.isArray(list) ? list : []);
  return stored.some(isOtherCategory) ? stored : [...stored, 'Other'];
}

/** Accepts only absolute http(s) URLs of a sane length; anything else is dropped. */
export function normalizeSourceUrl(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 2048) return undefined;
  try {
    const url = new URL(trimmed);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Builds the Firestore document for a new shopping-list item. This is the one
 * item-creation contract shared by the Shopping Lists tab, the command palette,
 * the pantry and the share target (all through `addItemsToList`): the document ID
 * is `slugify(name)` (a slug plus a random suffix, so repeated names create
 * separate items) and optional fields are omitted, never undefined. New items carry
 * `nameKey` and, when known, `addedByUid` (SH-28a) and `categorySource` (QA-6); a
 * scanned package size goes to `size`/`sizeUnit`, never into `quantity` (BL-1).
 */
export function buildShoppingListItem({
  name,
  quantity,
  category,
  categorySource,
  addedByUid,
  imageUrl,
  barcode,
  sourceUrl,
  size,
  sizeUnit,
}: {
  name: string;
  quantity: number;
  category: string;
  categorySource?: CategorySource;
  addedByUid?: string | null;
  imageUrl?: string;
  barcode?: string;
  sourceUrl?: string;
  size?: number;
  sizeUnit?: string;
}): { itemId: string; data: Omit<ShoppingListItem, 'id'> } {
  const packaged = packageSize(size, sizeUnit);
  return {
    itemId: slugify(name),
    data: {
      name,
      nameKey: itemNameKey(name),
      quantity,
      category,
      ...(categorySource ? { categorySource } : {}),
      ...(addedByUid ? { addedByUid } : {}),
      createdAt: new Date(),
      ...(imageUrl ? { imageUrl } : {}),
      ...(barcode ? { barcode } : {}),
      ...(sourceUrl ? { sourceUrl } : {}),
      ...(packaged ? packaged : {}),
      status: 'needed',
    },
  };
}
