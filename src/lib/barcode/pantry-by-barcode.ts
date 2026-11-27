/**
 * A scanned or saved product's pantry stock (BL-13 "Add to pantry", BL-16, BL-20
 * "Used up" / "Restock", BL-21). Pure; unit tested in tests/unit/barcode-pantry.test.ts.
 *
 * A product is found by barcode first (any visible batch that stores the same
 * code, `sameBarcode`), then by name (the pantry's name key), so stock added by
 * hand before barcodes were stored is still found. "Used up" removes ONE package
 * (never 1 g of a measured amount, audit 17.3) from the soonest-expiring batch,
 * and at zero the screen asks "Add to list?" (D-8; nothing is added without a
 * tap). "Restock" adds one package to the soonest batch (`planAddOne`), or a new
 * batch of one item on the Pantry shelf when nothing is stocked yet.
 */
import { itemNameKey } from '@/lib/shopping/items';
import {
  clampPantryName,
  groupPantryBatches,
  planAddOne,
  usedUpOutcome,
  type AddOnePlan,
  type PantryBatch,
  type PantryBatchInput,
  type PantryProduct,
  type UsedUpOutcome,
} from '@/lib/shopping/pantry-batches';
import { sameBarcode } from './gtin';

export type ScannedProductRef = { barcode: string; name: string };

/** The pantry product for a scanned code: by barcode first, then by name; null when not stocked. */
export function pantryProductFor(batches: readonly PantryBatch[], scanned: ScannedProductRef): PantryProduct | null {
  const products = groupPantryBatches(batches);
  const byCode = products.find((product) => product.batches.some((batch) => sameBarcode(batch.barcode, scanned.barcode)));
  if (byCode) return byCode;
  const key = itemNameKey(clampPantryName(scanned.name));
  if (!key) return null;
  return products.find((product) => product.nameKey === key) ?? null;
}

export type UsedUpPlan =
  | { kind: 'not-stocked' }
  | { kind: 'nothing-left'; product: PantryProduct }
  | ({ kind: 'use'; product: PantryProduct } & UsedUpOutcome);

/** What "Used up" does for a scanned code. */
export function planUsedUp(batches: readonly PantryBatch[], scanned: ScannedProductRef): UsedUpPlan {
  const product = pantryProductFor(batches, scanned);
  if (!product) return { kind: 'not-stocked' };
  const outcome = usedUpOutcome(product);
  if (!outcome) return { kind: 'nothing-left', product };
  return { kind: 'use', product, ...outcome };
}

export type RestockPlan =
  | { kind: 'add-one'; product: PantryProduct; plan: AddOnePlan }
  | { kind: 'new'; input: PantryBatchInput };

/** What "Restock" (or the library's "Add to pantry") does for a scanned code. */
export function planRestock(batches: readonly PantryBatch[], scanned: ScannedProductRef): RestockPlan {
  const product = pantryProductFor(batches, scanned);
  const plan = product ? planAddOne(product.batches) : undefined;
  if (product && plan) return { kind: 'add-one', product, plan };
  return {
    kind: 'new',
    input: { name: clampPantryName(scanned.name), location: 'Pantry', unit: 'items', packages: 1, packageSize: null, expiryDate: null, barcode: scanned.barcode },
  };
}
