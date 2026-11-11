/**
 * Adding a scanned product without consuming the Add Item form (S7). The Add
 * Item form is shared by every opening of the dialog; a scan (Scan to tick's
 * "Add" offer, or the scanner inside Add Item) is its own submission: it never
 * takes the form's draft revision, never resets the typed draft, and only uses
 * the category it was given when the scan started. Pure apart from the injected
 * save and report functions; unit tested in tests/unit/shopping-scan-add.test.ts.
 *
 * A save that is not confirmed in time is reported as pending with the typed
 * add's status ("Still sending…" / "Checking…", `pendingSaveStatus`), and the
 * scan stays outstanding (`createScanAddGuard`) until its write settles, so
 * scanning the same product again meanwhile does not queue a second addition.
 */
import type { AddEntry, EntryOutcome } from './add-items';
import { dialogAfterSave, isPendingState, pendingSaveStatus, type DialogDraft } from './save-status';
import type { ScanEntry } from './scan';

export type ScanAddDeps<L> = {
  /** The shared save path (`addEntries` → `addItemsToList`). */
  add: (entries: AddEntry[], options: { selectedCategory?: string; libraryItem?: L | null; barcode?: string }) => Promise<EntryOutcome[] | null>;
  /** Honest result reporting (saved / will sync / merged). */
  report: (outcomes: EntryOutcome[]) => void;
  /** A failure now (a late one is reported by the save path's own onLateError). */
  fail: (error: unknown) => void;
  /**
   * The save is not confirmed yet: called once, before waiting for the final
   * answer, with the typed add's status line ("Still sending… Milk is not
   * confirmed yet."). The final answer still goes to `report` (or the save path's
   * onLateError).
   */
  pending: (status: string) => void;
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
    deps.pending(pendingSaveStatus(outcome.state, outcome.name));
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

/** Which scanned product on which list a scan adds: one outstanding addition each. */
export function scanAddKey(listId: string | null, barcode: string): string {
  return `${listId ?? ''}/${barcode}`;
}

/**
 * Scans still being added (looked up, saved, or saved but not confirmed yet),
 * shared by every scan entry point of a list (the scanner inside Add Item and
 * Scan to tick's Add). A second scan of the same product on the same list is
 * refused until the first one's write settles; its pending status (if any) is
 * kept so the refusal can say why.
 */
export function createScanAddGuard() {
  const outstanding = new Map<string, string | null>();
  return {
    /** True when this scan may start (and marks it outstanding). */
    begin(key: string): boolean {
      if (outstanding.has(key)) return false;
      outstanding.set(key, null);
      return true;
    },
    /** Records the outstanding scan's pending status line. */
    note(key: string, status: string) {
      if (outstanding.has(key)) outstanding.set(key, status);
    },
    /** The outstanding scan's pending status line, or null. */
    status(key: string): string | null {
      return outstanding.get(key) ?? null;
    },
    end(key: string) {
      outstanding.delete(key);
    },
  };
}

export type ScanAddGuard = ReturnType<typeof createScanAddGuard>;

/**
 * Runs one scan under the guard: `run` only when no scan of the same product on
 * the same list is outstanding (otherwise `duplicate` gets the refusal copy), and
 * the scan stays outstanding until `run` has finished (a pending save until it
 * settles). Resolves to `run`'s result, or `'duplicate'`.
 */
export async function withScanGuard<T>(
  guard: ScanAddGuard,
  key: string,
  run: (notePending: (status: string) => void) => Promise<T>,
  duplicate: (copy: string) => void,
): Promise<T | 'duplicate'> {
  if (!guard.begin(key)) {
    duplicate(duplicateScanCopy(guard.status(key)));
    return 'duplicate';
  }
  try {
    return await run((status) => guard.note(key, status));
  } finally {
    guard.end(key);
  }
}

/** Why a second scan of a product still being added was not added again. */
export function duplicateScanCopy(status: string | null): string {
  return `${status ?? 'This product is still being added.'} Scan it again once it is confirmed to add another.`;
}
