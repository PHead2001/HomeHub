/**
 * Adding a scanned product without consuming the Add Item form (S7). The Add
 * Item form is shared by every opening of the dialog; a scan (Scan to tick's
 * "Add" offer, or the scanner inside Add Item) is its own submission: it never
 * takes the form's draft revision, never resets the typed draft, and only uses
 * the category it was given when the scan started. Pure apart from the injected
 * save and report functions; unit tested in tests/unit/shopping-scan-tick.test.ts.
 */
import type { AddEntry, EntryOutcome } from './add-items';
import { dialogAfterSave, isPendingState, type DialogDraft } from './save-status';
import type { ScanEntry } from './scan';

export type ScanAddDeps<L> = {
  /** The shared save path (`addEntries` → `addItemsToList`). */
  add: (entries: AddEntry[], options: { selectedCategory?: string; libraryItem?: L | null; barcode?: string }) => Promise<EntryOutcome[] | null>;
  /** Honest result reporting (saved / will sync / merged). */
  report: (outcomes: EntryOutcome[]) => void;
  /** A failure now (a late one is reported by the save path's own onLateError). */
  fail: (error: unknown) => void;
};

/** Saves one scanned package and reports it; resolves to the final state ('saved', 'failed' or null when nothing ran). */
export async function addScannedProduct<L>(
  entry: ScanEntry,
  extras: { libraryItem?: L | null; barcode: string; selectedCategory?: string },
  deps: ScanAddDeps<L>,
): Promise<'saved' | 'failed' | null> {
  const outcomes = await deps.add(
    [{ name: entry.name, quantity: entry.quantity, size: entry.size, sizeUnit: entry.sizeUnit }],
    { selectedCategory: extras.selectedCategory || undefined, libraryItem: extras.libraryItem, barcode: extras.barcode },
  );
  if (!outcomes) return null;
  const [outcome] = outcomes;
  if (!outcome) return null;
  if (outcome.state === 'failed') {
    deps.fail(outcome.error);
    return 'failed';
  }
  if (isPendingState(outcome.state)) {
    const final = await outcome.settled;
    if (final === 'saved') deps.report([{ ...outcome, state: 'saved' }]);
    return final;
  }
  deps.report(outcomes);
  return 'saved';
}

/**
 * After a scan from inside Add Item is saved: close that same opening of the
 * dialog (nothing typed since the scan), but never reset the form, because the
 * draft was not what was saved.
 */
export function dialogAfterScan(started: DialogDraft, current: DialogDraft & { open: boolean }): { reset: false; close: boolean } {
  return { reset: false, close: dialogAfterSave(started, current).close };
}
