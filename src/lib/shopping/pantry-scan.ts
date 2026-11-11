/**
 * A barcode scan in the pantry's Add Item form (Pantry v2, BL-1). Pure; unit
 * tested in tests/unit/pantry-scan.test.ts.
 *
 * - The name is the Barcode Library's (else the looked-up product name), stored
 *   as the pantry stores names (`clampPantryName`: at most 120 characters), so a
 *   long product name never blocks Save.
 * - For a weight or volume the looked-up amount is the size of ONE package: a
 *   450 g bag is 1 package of 450 g, never 450 packages. A size above the
 *   largest stored size is left out (the size is optional).
 * - For a counted unit ("6 eggs", "4 cans") the amount is how many there are:
 *   counted stock has no package size, and Used one removes one of them. It is
 *   at least 1 and at most the per-batch limit.
 * - An amount without a known pantry unit is not filled in.
 */
import { pantryItemUnitCategories, type PantryItemUnit } from '@/lib/types';
import { clampPantryName, isCountUnit, MAX_PACKAGE_SIZE, MAX_PACKAGES } from './pantry-batches';

export type PantryScanResult = {
  productName?: string | null;
  libraryItem?: { name?: string | null } | null;
  quantity?: number | null;
  unit?: string | null;
};

export type PantryScanPrefill = {
  name: string;
  /** Null when the lookup gave no usable amount (the member enters it). */
  amount: { unit: PantryItemUnit; packages: number; packageSize: string } | null;
};

const PANTRY_UNITS: readonly string[] = [
  ...pantryItemUnitCategories.Weight,
  ...pantryItemUnitCategories.Volume,
  ...pantryItemUnitCategories.Count,
];

const isPantryUnit = (unit: unknown): unit is PantryItemUnit => typeof unit === 'string' && PANTRY_UNITS.includes(unit);

/** What a scan fills into the pantry form, or null without a name. */
export function pantryScanPrefill(result: PantryScanResult): PantryScanPrefill | null {
  const name = clampPantryName(result.libraryItem?.name || result.productName || '');
  if (!name) return null;
  const { quantity, unit } = result;
  if (typeof quantity !== 'number' || !Number.isFinite(quantity) || quantity <= 0 || !isPantryUnit(unit)) {
    return { name, amount: null };
  }
  if (isCountUnit(unit)) {
    return { name, amount: { unit, packages: Math.min(MAX_PACKAGES, Math.max(1, Math.round(quantity))), packageSize: '' } };
  }
  const size = Math.round(quantity * 1000) / 1000;
  return { name, amount: { unit, packages: 1, packageSize: size > 0 && size <= MAX_PACKAGE_SIZE ? String(size) : '' } };
}
