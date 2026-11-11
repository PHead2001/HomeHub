/**
 * Barcode scan to shopping entry (BL-1, audit 17.3). A scan adds ONE package: the
 * product's package size and unit ("450 g", "128 fl oz") are kept separately as
 * `size` / `sizeUnit` and never become the quantity. Merging a scan into a
 * still-needed item of the same name adds 1. Pure; unit tested in
 * tests/unit/shopping-scan.test.ts.
 */

/** Largest package size stored on an item (matches the rules). */
export const MAX_PACKAGE_SIZE = 100_000;
/** Longest stored size unit (matches the rules). */
export const MAX_SIZE_UNIT_LENGTH = 16;

export type ScannedProduct = {
  productName?: string | null;
  libraryItem?: { name?: string | null } | null;
  /** Package size from the lookup (Open Food Facts), not a count. */
  quantity?: number | null;
  unit?: string | null;
};

export type ScanEntry = {
  name: string;
  /** Always 1: one scan is one package. */
  quantity: 1;
  size?: number;
  sizeUnit?: string;
};

/** The package size worth keeping, or nothing when it is missing or out of bounds. */
export function packageSize(quantity: unknown, unit: unknown): { size: number; sizeUnit: string } | null {
  if (typeof quantity !== 'number' || !Number.isFinite(quantity) || quantity <= 0 || quantity > MAX_PACKAGE_SIZE) return null;
  if (typeof unit !== 'string') return null;
  const sizeUnit = unit.trim();
  if (!sizeUnit || sizeUnit.length > MAX_SIZE_UNIT_LENGTH) return null;
  return { size: Math.round(quantity * 1000) / 1000, sizeUnit };
}

/** Maps a barcode lookup result to the one-package entry a scan adds, or null without a name. */
export function scanToShoppingEntry(result: ScannedProduct): ScanEntry | null {
  const name = (result.libraryItem?.name || result.productName || '').trim();
  if (!name) return null;
  const size = packageSize(result.quantity, result.unit);
  return size ? { name, quantity: 1, ...size } : { name, quantity: 1 };
}

/** Row note for a package size: "450 g", "1.5 L". Empty without a size. */
export function formatPackageSize(size: unknown, sizeUnit: unknown): string {
  const parsed = packageSize(size, sizeUnit);
  if (!parsed) return '';
  return `${parsed.size.toLocaleString('en-US', { maximumFractionDigits: 3 })} ${parsed.sizeUnit}`;
}
