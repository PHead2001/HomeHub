/**
 * Scan to tick (SH-33f). On an open list, scanning a product ticks the needed
 * item it matches through the list's ordinary tick (with its 10 s Undo); a
 * product that is not needed is offered as an Add. Pure; unit tested in
 * tests/unit/shopping-scan-tick.test.ts.
 *
 * Matching: first an item that was added by scanning this same barcode (no
 * lookup needed, so it works offline); then, after the lookup, an item whose
 * name matches the product name (case and spacing ignored).
 */
import { itemNameKey } from './items';
import { scanToShoppingEntry, type ScanEntry, type ScannedProduct } from './scan';
import { lookupMiss, type LookupMiss, type LookupSummary } from '@/lib/barcode/lookup-outcome';

export type TickCandidate = { id: string; name: string; status: 'needed' | 'purchased'; barcode?: string };

export type ScanTickDecision<T extends TickCandidate> =
  | { kind: 'tick'; item: T }
  | { kind: 'in-cart'; item: T }
  | { kind: 'offer-add'; entry: ScanEntry }
  | { kind: 'miss'; miss: LookupMiss };

/** A needed (or, failing that, already purchased) item carrying this barcode. */
export function matchByBarcode<T extends TickCandidate>(items: readonly T[], barcode: string): ScanTickDecision<T> | null {
  const code = barcode.trim();
  if (!code) return null;
  const needed = items.find((item) => item.status === 'needed' && item.barcode === code);
  if (needed) return { kind: 'tick', item: needed };
  const purchased = items.find((item) => item.status === 'purchased' && item.barcode === code);
  return purchased ? { kind: 'in-cart', item: purchased } : null;
}

/** The decision once the lookup has answered. */
export function scanTickDecision<T extends TickCandidate>(
  items: readonly T[],
  barcode: string,
  result: ScannedProduct & LookupSummary,
): ScanTickDecision<T> {
  const byCode = matchByBarcode(items, barcode);
  if (byCode) return byCode;
  const miss = result.libraryItem?.name ? null : lookupMiss(result);
  const entry = scanToShoppingEntry(result);
  if (miss || !entry) return { kind: 'miss', miss: miss ?? { kind: 'not-found' } };
  const key = itemNameKey(entry.name);
  const needed = items.find((item) => item.status === 'needed' && itemNameKey(item.name) === key);
  if (needed) return { kind: 'tick', item: needed };
  const purchased = items.find((item) => item.status === 'purchased' && itemNameKey(item.name) === key);
  if (purchased) return { kind: 'in-cart', item: purchased };
  return { kind: 'offer-add', entry };
}
