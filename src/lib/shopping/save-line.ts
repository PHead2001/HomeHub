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
