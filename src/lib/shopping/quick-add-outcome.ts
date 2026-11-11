import type { QuickAddEntry } from './items';

/**
 * What happened to a quick-add submission: `failed` are the entries that could not
 * be saved. `pending` are entries without an answer yet (save-status.ts `sending`
 * or `uncertain`): they show in a status chip and `settled` resolves with those of
 * them that finally failed. The others were saved. `null` means nothing was
 * saved, so every submitted entry counts as failed.
 */
export type QuickAddOutcome = {
  failed: QuickAddEntry[];
  pending?: { entries: QuickAddEntry[]; label: string; settled: Promise<QuickAddEntry[]> };
} | null;

export type NotAddedNotice = { variant: 'destructive'; title: string; description: string };

/** The entries of `submitted` that were not saved, per `outcome` (all of them when nothing was saved). */
export function failedEntries(outcome: QuickAddOutcome, submitted: readonly QuickAddEntry[]): QuickAddEntry[] {
  return outcome ? outcome.failed : [...submitted];
}

/** The toast for entries that were not added when there is no field to put them back into; null when none failed. */
export function notAddedNotice(listName: string, failed: readonly QuickAddEntry[]): NotAddedNotice | null {
  if (failed.length === 0) return null;
  return { variant: 'destructive', title: `Not added to ${listName}`, description: failed.map((entry) => entry.name).join(', ') };
}

/**
 * Runs a quick add that has no input field of its own (a usual chip) and
 * reports every entry that was not saved, the way the quick-add field does
 * once it is gone: at once for failures, and later for pending entries that
 * finally fail. A thrown save counts as all failed. Resolves when the
 * immediate outcome is known.
 */
export async function addAndReportDetached(
  listName: string,
  submitted: readonly QuickAddEntry[],
  add: (entries: QuickAddEntry[]) => Promise<QuickAddOutcome>,
  notify: (notice: NotAddedNotice) => void,
): Promise<void> {
  let outcome: QuickAddOutcome = null;
  try {
    outcome = await add([...submitted]);
  } catch {
    outcome = null;
  }
  const now = notAddedNotice(listName, failedEntries(outcome, submitted));
  if (now) notify(now);
  const pending = outcome?.pending;
  if (pending) {
    void pending.settled.catch(() => pending.entries).then((late) => {
      const notice = notAddedNotice(listName, late);
      if (notice) notify(notice);
    });
  }
}
