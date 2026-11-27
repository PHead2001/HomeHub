/**
 * The library page's search and sort (BL-13, BL-23). Pure; unit tested in
 * tests/unit/barcode-library.test.ts.
 */
import type { BarcodeLibraryItem } from '@/lib/types';

export type LibrarySort = 'newest' | 'name' | 'most-scanned';

export const LIBRARY_SORTS: readonly { id: LibrarySort; label: string }[] = [
  { id: 'newest', label: 'Newest' },
  { id: 'name', label: 'Name' },
];

const words = (value: string) => value.toLowerCase().split(/\s+/).filter(Boolean);

/**
 * Search by word: every word typed must appear in the product's name or barcode
 * (in any order), so "test audit" finds "Audit test product". Spaces inside a
 * typed barcode are ignored when matching the code.
 */
export function matchesLibrarySearch(item: Pick<BarcodeLibraryItem, 'id' | 'name'>, search: string): boolean {
  const terms = words(search);
  if (terms.length === 0) return true;
  const name = item.name.toLowerCase();
  const code = item.id.toLowerCase();
  const digits = search.replace(/\s+/g, '');
  if (/^\d{3,}$/.test(digits) && code.includes(digits)) return true;
  return terms.every((term) => name.includes(term) || code.includes(term));
}

const createdMs = (item: Pick<BarcodeLibraryItem, 'createdAt'>) => {
  const ms = Date.parse(item.createdAt);
  return Number.isFinite(ms) ? ms : 0;
};

const lastScannedMs = (item: Partial<Pick<BarcodeLibraryItem, 'lastScannedAt'>>) => {
  const value = item.lastScannedAt;
  if (typeof value === 'string') {
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : 0;
  }
  return 0;
};

/**
 * Newest first; by name (A to Z); or most scanned (BL-23: scan count, then the
 * latest scan, then name), a product never scanned counting 0.
 */
export function sortLibrary<T extends Pick<BarcodeLibraryItem, 'id' | 'name' | 'createdAt'> & Partial<Pick<BarcodeLibraryItem, 'scanCount' | 'lastScannedAt'>>>(
  items: readonly T[],
  sort: LibrarySort,
): T[] {
  const byName = (a: T, b: T) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || a.id.localeCompare(b.id);
  const sorted = [...items];
  if (sort === 'name') return sorted.sort(byName);
  if (sort === 'most-scanned') {
    return sorted.sort((a, b) => (b.scanCount ?? 0) - (a.scanCount ?? 0) || lastScannedMs(b) - lastScannedMs(a) || byName(a, b));
  }
  return sorted.sort((a, b) => createdMs(b) - createdMs(a) || byName(a, b));
}
