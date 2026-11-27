/**
 * The kitchen scan station (BL-20, BL-21; audit 17.3 and D-8). Pure; unit
 * tested in tests/unit/barcode-station.test.ts.
 *
 * The station keeps one action selected (Used up, Restock or Add to list) and
 * applies it to every product scanned, so a run of empty packages is "scan,
 * scan, scan". Used up removes ONE package (never 1 g of a measured amount); at
 * zero the station asks "Add to list?" (Add / Not now) and adds nothing by itself.
 */
import { lookupMiss, type LookupMiss, type LookupSummary } from './lookup-outcome';
import { normalizeGtin } from './gtin';

export type StationMode = 'used' | 'restock' | 'list';

export const STATION_MODES: readonly { id: StationMode; label: string; hint: string }[] = [
  { id: 'used', label: 'Used up', hint: 'Each scan takes one package out of the pantry.' },
  { id: 'restock', label: 'Restock', hint: 'Each scan adds one package to the pantry.' },
  { id: 'list', label: 'Add to list', hint: 'Each scan puts one on the shopping list.' },
];

/** `?mode=used|restock|list`; Used up when absent or unknown. */
export function stationModeFrom(search: string): StationMode {
  const mode = new URLSearchParams(search).get('mode');
  return mode === 'restock' || mode === 'list' ? mode : 'used';
}

export type StationLookup = LookupSummary & { productName?: string | null; libraryItem?: { id: string; name: string } | null };

export type StationProduct = { barcode: string; name: string; libraryId: string | null };

/** The product a lookup found (the library's name first), or the miss to show. */
export function stationProduct(result: StationLookup, scanned: string): { kind: 'product'; product: StationProduct } | { kind: 'miss'; miss: LookupMiss } {
  const name = (result.libraryItem?.name || result.productName || '').trim();
  const miss = result.libraryItem ? null : lookupMiss(result);
  if (!name || miss) return { kind: 'miss', miss: miss ?? { kind: 'not-found' } };
  const normalized = normalizeGtin(scanned);
  return {
    kind: 'product',
    product: { barcode: result.libraryItem?.id ?? (normalized.ok ? normalized.id : scanned), name, libraryId: result.libraryItem?.id ?? null },
  };
}

export type UsedUpAnswer =
  | { kind: 'not-stocked' }
  | { kind: 'nothing-left'; name: string }
  | { kind: 'used'; name: string; remaining: number; askAddToList: boolean };

/** The station's line after Used up. */
export function usedUpLine(answer: UsedUpAnswer, scannedName: string): string {
  if (answer.kind === 'not-stocked') return `${scannedName} is not in the pantry.`;
  if (answer.kind === 'nothing-left') return `There is nothing left of ${answer.name} to use.`;
  if (answer.remaining === 0) return `Used the last ${answer.name}.`;
  return `Used one ${answer.name}. ${answer.remaining} left.`;
}

/** The station's line after Restock. */
export function restockLine(name: string, merged: boolean): string {
  return merged ? `One more ${name} in the pantry.` : `${name} is in the pantry (1).`;
}
