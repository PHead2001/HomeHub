// The tablet's Undo journal (docs/modules/devices/README.md, "Offline queue and Undo
// journal"; design 10.3, WT-20). IndexedDB `homehub-device`, store `undo`. An entry is
// written when an action is first attempted (not only when confirmed), so a reload can
// restore the Undo toast for the time that is left, counted on the device clock from the
// server's answer. The server's window is the authority; this only decides whether to
// offer the button. Cleared on expiry and on revocation. F4's actions write to it; the
// shell restores toasts from it.

import type { DeviceCapability } from './action-policy';
import type { RecordStore } from './device-store';
import type { QueueSession } from './offline-queue';

const ofSession = (entry: UndoJournalEntry, session: QueueSession) =>
  entry.householdId === session.householdId && entry.deviceId === session.deviceId && entry.generation === session.generation;

export const JOURNAL_UNDO_WINDOW_MS = 10_000;
/** Entries are kept a little past the window so a late server answer still finds them. */
export const JOURNAL_KEEP_MS = 60_000;

export type UndoJournalState = 'attempted' | 'confirmed' | 'undoing' | 'undone';

export type UndoJournalEntry = {
  opId: string;
  /** The tablet session the action was made in (household, device record, credential generation). */
  householdId: string;
  deviceId: string;
  generation: number;
  capability: DeviceCapability;
  actorUid: string;
  /** Short description for the restored toast ("Fed Maple"); no PII beyond names shown on the tablet. */
  label: string;
  /** Device clock when the action was first attempted. */
  sentAt: number;
  /** Device clock when the server answered (the window counts from here once known). */
  respondedAt: number | null;
  /** The action was sent from the offline queue (R1). */
  viaQueue: boolean;
  state: UndoJournalState;
};

export const journalEntry = (input: Omit<UndoJournalEntry, 'respondedAt' | 'state'>): UndoJournalEntry => ({
  ...input, opId: input.opId.toLowerCase(), respondedAt: null, state: 'attempted',
});

/** Milliseconds of Undo left on the device clock (0 when none). */
export function journalRemainingMs(entry: UndoJournalEntry, now: number): number {
  if (entry.state === 'undone' || entry.state === 'undoing') return 0;
  // A queued action counts from its sync answer; until then it has no window yet.
  const from = entry.respondedAt ?? (entry.viaQueue ? null : entry.sentAt);
  if (from === null) return 0;
  return Math.max(0, from + JOURNAL_UNDO_WINDOW_MS - now);
}

/** After a reload: this session's entries whose Undo toast comes back, with the time left. */
export function restorableUndos(entries: readonly UndoJournalEntry[], now: number, session: QueueSession): Array<{ entry: UndoJournalEntry; remainingMs: number }> {
  return entries
    .filter((entry) => ofSession(entry, session))
    .filter((entry) => entry.state === 'confirmed' || entry.state === 'attempted')
    .map((entry) => ({ entry, remainingMs: journalRemainingMs(entry, now) }))
    .filter((item) => item.remainingMs > 0)
    .sort((a, b) => a.remainingMs - b.remainingMs);
}

/** Entries to delete: another session's, undone, or past the window plus the keep margin. */
export function expiredJournalEntries(entries: readonly UndoJournalEntry[], now: number, session: QueueSession): UndoJournalEntry[] {
  return entries.filter((entry) => {
    if (!ofSession(entry, session)) return true;
    if (entry.state === 'undone') return true;
    const from = entry.respondedAt ?? entry.sentAt;
    return now - from > JOURNAL_UNDO_WINDOW_MS + JOURNAL_KEEP_MS;
  });
}

export async function recordAttempt(store: RecordStore<UndoJournalEntry>, entry: UndoJournalEntry): Promise<void> {
  await store.put(entry);
}

export async function markJournal(store: RecordStore<UndoJournalEntry>, opId: string, patch: Partial<Pick<UndoJournalEntry, 'state' | 'respondedAt'>>): Promise<void> {
  const current = await store.get(opId.toLowerCase());
  if (!current) return;
  await store.put({ ...current, ...patch });
}

export async function pruneJournal(store: RecordStore<UndoJournalEntry>, now: number, session: QueueSession): Promise<number> {
  const expired = expiredJournalEntries(await store.all(), now, session);
  for (const entry of expired) await store.delete(entry.opId);
  return expired.length;
}
