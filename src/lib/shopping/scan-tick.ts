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

/** Which list a scan belongs to: the household and list it was started on. */
export type ScanListIdentity = { householdId: string; listId: string };

/**
 * Whether a scan's lookup result may still act: only on the household and list
 * it was started on. A result that comes back after the member opened another
 * list (or left the list) is dropped, so one list's items are never ticked or
 * added with another list's callbacks or path.
 */
export function scanStillApplies(started: ScanListIdentity, current: ScanListIdentity | null): boolean {
  return current !== null && current.householdId === started.householdId && current.listId === started.listId;
}

/**
 * The copy of an item a tick or un-tick must act on: the latest one from the
 * list's listener. Null when the item's status has changed since `seen` was read
 * (someone else ticked or un-ticked it), so the action no longer applies and must
 * not overwrite their change. An item the listener does not hold (yet) is acted on
 * as seen; the write then succeeds or fails on its own.
 */
export function currentItemForToggle<T extends { id: string; status: 'needed' | 'purchased' }>(seen: T, latest: readonly T[]): T | null {
  const current = latest.find((item) => item.id === seen.id);
  if (!current) return seen;
  return current.status === seen.status ? current : null;
}

/** The decision once the lookup has answered. Pass the LATEST items (read after the lookup). */
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
