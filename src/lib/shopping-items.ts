import type { ShoppingListItem } from '@/lib/types';
import { slugify } from '@/lib/utils';

export const DEFAULT_SHOPPING_CATEGORIES = ['Produce', 'Dairy', 'Meat', 'Bakery', 'Pantry', 'Frozen', 'Snacks', 'Drinks', 'Household', 'Other'];

/** Categories stored at `config/categories`, always including `Other` (the AI fallback). */
export function normalizeStoredCategories(value: unknown): string[] | null {
  if (!value || typeof value !== 'object' || !('list' in value)) return null;
  const list = (value as { list: unknown }).list;
  const stored = Array.isArray(list) ? list.filter((category: unknown): category is string => typeof category === 'string') : [];
  return stored.includes('Other') ? stored : [...stored, 'Other'];
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
 * item-creation contract shared by the Shopping Lists tab and the share target:
 * the document ID is `slugify(name)` (a slug plus a random suffix, so repeated
 * names create separate items) and optional fields are omitted, never undefined.
 */
export function buildShoppingListItem({
  name,
  quantity,
  category,
  imageUrl,
  barcode,
  sourceUrl,
}: {
  name: string;
  quantity: number;
  category: string;
  imageUrl?: string;
  barcode?: string;
  sourceUrl?: string;
}): { itemId: string; data: Omit<ShoppingListItem, 'id'> } {
  return {
    itemId: slugify(name),
    data: {
      name,
      quantity,
      category,
      createdAt: new Date(),
      ...(imageUrl ? { imageUrl } : {}),
      ...(barcode ? { barcode } : {}),
      ...(sourceUrl ? { sourceUrl } : {}),
      status: 'needed',
    },
  };
}
