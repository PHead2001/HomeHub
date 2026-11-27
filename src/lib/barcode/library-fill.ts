/**
 * The library that fills itself (BL-19). Pure; unit tested in
 * tests/unit/barcode-library-fill.test.ts.
 *
 * - When Open Food Facts finds a product, the screen offers "Save to library"
 *   with its name and (only when the rules would accept it on a create) its
 *   photo, under the normalised barcode ID (BL-12).
 * - Before asking the server, a scan checks the household library already on
 *   the device (the live listener behind `useLibraryPhotos`), so a saved
 *   product's second scan answers at once and works offline.
 */
import type { BarcodeLibraryItem } from '@/lib/types';
import { lookupIds, normalizeGtin } from './gtin';
import { MAX_PRODUCT_NAME_LENGTH, photoUrlAcceptedOnCreate, productName } from './library-writes';
import { storedNutrition, type NutriScore } from './nutrition';

export type LibraryOffer = { barcode: string; name: string; imageUrl: string; allergens?: string[]; nutriScore?: NutriScore };

type LookupLike = { source?: string; productName?: string | null; imageUrl?: string | null; libraryItem?: unknown; allergens?: unknown; nutriScore?: unknown };

/** What "Save to library" would save after a lookup, or null (not an Open Food Facts find). */
export function libraryOfferFor(result: LookupLike, scanned: string, householdId: string): LibraryOffer | null {
  if (result.source !== 'open_food_facts' || result.libraryItem) return null;
  const name = productName(result.productName ?? '').slice(0, MAX_PRODUCT_NAME_LENGTH).trim();
  if (!name) return null;
  const normalized = normalizeGtin(scanned);
  if (!normalized.ok) return null;
  const imageUrl = typeof result.imageUrl === 'string' && photoUrlAcceptedOnCreate(householdId, result.imageUrl) ? result.imageUrl : '';
  // BL-22: allergens and Nutri-Score travel with the saved product.
  const { allergens, nutriScore } = storedNutrition(result);
  return { barcode: normalized.id, name, imageUrl, ...(allergens.length > 0 ? { allergens } : {}), ...(nutriScore ? { nutriScore } : {}) };
}

export type LocalLibraryEntry = { name: string; imageUrl?: string; allergens?: string[]; nutriScore?: NutriScore | null };

export type LocalLookup = {
  productName: string;
  libraryItem: BarcodeLibraryItem;
  source: 'household';
  /** A saved product carries no package size (as the server's household answer). */
  quantity?: undefined;
  unit?: undefined;
  imageUrl?: undefined;
};

/** A saved product from the library already on the device (either barcode form), or null. */
export function localLibraryLookup(library: ReadonlyMap<string, LocalLibraryEntry> | null, scanned: string): LocalLookup | null {
  if (!library) return null;
  for (const id of lookupIds(scanned)) {
    const entry = library.get(id);
    if (entry && entry.name.trim()) {
      return {
        productName: entry.name,
        libraryItem: {
          id, name: entry.name, imageUrl: entry.imageUrl ?? '', createdAt: '',
          ...(entry.allergens?.length ? { allergens: entry.allergens } : {}), ...(entry.nutriScore ? { nutriScore: entry.nutriScore } : {}),
        },
        source: 'household',
      };
    }
  }
  return null;
}

/**
 * The saved product a scan counts toward (BL-23), or null: the household product a lookup
 * answered with, else (no lookup made, as Scan to tick's fast path for an item already on
 * the list) the product the on-device library holds for this code in either barcode form.
 */
export function scannedLibraryId(
  library: ReadonlyMap<string, LocalLibraryEntry> | null,
  scanned: string,
  result?: { source?: string; libraryItem?: { id: string } | null } | null,
): string | null {
  if (result) return result.source === 'household' && result.libraryItem ? result.libraryItem.id : null;
  return localLibraryLookup(library, scanned)?.libraryItem.id ?? null;
}
