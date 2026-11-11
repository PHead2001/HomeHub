import { saveStateLabel, type SaveState } from './save-status';

/** A write that has been sent but not answered within the wait yet. */
export type SaveLineState = SaveState | 'waiting';

/**
 * One status line for a dialog's last write ("Dairy moved up · Saved"). The
 * state comes from `trackWrite` (save-status.ts): "Saved" only once the server
 * answered, "Saved, will sync" only when the durable cache shows the write, and
 * "Still sending…" / "Checking…" otherwise, so nothing unconfirmed reads as saved.
 */
export function saveLineText(state: SaveLineState, subject: string): string {
  const label = state === 'waiting' ? 'Saving…' : saveStateLabel(state);
  return subject ? `${subject} · ${label}` : label;
}

const sameText = (a: string, b: string) => a.replace(/\s+/g, ' ').trim() === b.replace(/\s+/g, ' ').trim();

/**
 * What an input field shows when the write it submitted (and cleared the field
 * for) is rejected, at once or later (queued offline, or slower than the 4 s
 * wait): the submitted text comes back only while the field is still empty or
 * holds that same text. Newer input is kept; the failure toast names what failed.
 */
export function rejectedInputRestore(current: string, submitted: string): { value: string; restored: boolean } {
  if (current.trim() === '' || sameText(current, submitted)) return { value: submitted, restored: true };
  return { value: current, restored: false };
}

/**
 * Whether a rejected list form (create or edit) opens again with what was
 * submitted: only while the list dialog is closed, so a form opened since is
 * never replaced, and for an edit only while that list still exists.
 */
export function rejectedDraftRestore({ dialogOpen, listGone }: { dialogOpen: boolean; listGone: boolean }): boolean {
  return !dialogOpen && !listGone;
}

/**
 * Runs tracked writes one after another. Each task resolves with its tracked
 * write as soon as the status wait ends (the UI moves on after at most 4 s), but
 * the queue is held until that write's `settled` answer, so a slow transaction
 * is never overtaken by the next one and writes commit in the order asked.
 */
export function createSettledQueue() {
  let tail: Promise<unknown> = Promise.resolve();
  return <T extends { settled: Promise<unknown> }>(start: () => Promise<T>): Promise<T> => {
    const run = tail.then(start, start);
    tail = run.then((tracked) => tracked.settled, () => undefined).catch(() => undefined);
    return run;
  };
}
