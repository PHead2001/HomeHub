/**
 * Scan into quick add (QA-24): a scanned product becomes the same shopping
 * suggestion a typed name would, shown in the preview before anything is saved.
 * Pure.
 */
import type { QuickAddList, ShoppingIntent } from './quick-add';
import { normalizeItemName } from '../shopping/items';

/** The preview for a scanned product's name, on the Grocery list (else the first list); null without a name or a list. */
export function scannedShoppingIntent(productName: string | null | undefined, lists: readonly QuickAddList[]): ShoppingIntent | null {
  const name = normalizeItemName(productName ?? '');
  const list = lists.find((candidate) => candidate.type === 'Grocery') ?? lists[0] ?? null;
  if (!name || !list) return null;
  return { kind: 'shopping', items: [{ name, quantity: 1 }], list, explicit: true };
}
