// The tablet's Undo journal (docs/modules/devices/README.md, "Offline queue and Undo
// journal"; design 10.3, WT-20): one explicit state machine per action, stored in
// IndexedDB `homehub-device`, store `undo`, keyed by opId. Pure: the transitions
// (`journalStep`, and `journalTransition`, which also says when a step took the action
// back), what each state offers (`undoOffer`), what an Undo tap does
// (`undoRoute`) and how an entry comes back after a reload (`restoreJournalEntry`). The
// tablet's runtime only stores entries and runs the steps. The server's window is the
// authority; this decides whether the button is shown and what tapping it does.
//
// States:
// - attempting       a live send is in flight (written before sending).
// - unknown-outcome  a live send got no answer: the server may hold it, applied.
// - applied          the server answered: applied, and this tablet may Undo it.
// - queued-unsent    waiting in the offline queue, never sent.
// - queued-sent      the queue has sent it at least once, no confirmation yet.
// - undo-pending     an Undo is on its way (being sent, or waiting in the queue).
// - undone, refused, expired: final. Taken back; refused by the server (never applied,
//   or applied with nothing to take back); its Undo window is over.
//
// Rules: an unknown transport outcome keeps the opId and offers Undo for the window that
// may remain on the server; an explicit refusal ends it; a queued action keeps a local
// cancellation window (restorable after a reload) while it has never been sent, and takes
// the server's window once sync confirms it. An Undo of anything that may have been sent
// goes to the server by opId; only a never-sent queue entry is removed locally, and
// `removeIfNeverSent` (under the queue lock) has the last word on that.

import type { DeviceCapability, DeviceRefusal } from './action-policy';
import type { RecordStore } from './device-store';
import type { QueueSession } from './offline-queue';

/** The server's Undo window (10 s) as the tablet counts it; the server adds a 5 s latency grace. */
export const JOURNAL_UNDO_WINDOW_MS = 10_000;
/** Entries are kept a little past the window so a late answer still finds them. */
export const JOURNAL_KEEP_MS = 60_000;
/** A send the page lost (a reload mid-request) cannot have applied later than this after it started. */
export const JOURNAL_MAX_SEND_MS = 60_000;
/** Queued entries the queue would refuse as stale (24 h, JC-18), plus a margin. */
export const JOURNAL_QUEUED_KEEP_MS = 25 * 60 * 60 * 1000;

export type JournalState =
  | 'attempting'
  | 'unknown-outcome'
  | 'applied'
  | 'queued-unsent'
  | 'queued-sent'
  | 'undo-pending'
  | 'undone'
  | 'refused'
  | 'expired';

/** The states an Undo is sent from (and returned to when that Undo does not go through). */
export type UndoableState = 'unknown-outcome' | 'applied' | 'queued-sent';

export const FINAL_STATES: ReadonlySet<JournalState> = new Set(['undone', 'refused', 'expired']);

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
  state: JournalState;
  /** Device clock when the action was first attempted or queued. */
  createdAt: number;
  /**
   * Device clock the Undo window counts from: the server's answer (applied, a confirmed sync
   * included), the end of a send that got no answer (unknown-outcome, queued-sent: the latest
   * the server could have applied it), or the queuing (queued-unsent: the local cancellation
   * window). Null while attempting.
   */
  windowFrom: number | null;
  /** The action reached (or may reach) the server from the offline queue (R1). */
  viaQueue: boolean;
  /** undo-pending: where an Undo that does not go through returns, and whether the Undo intent waits in the queue. */
  undo: { from: UndoableState; queued: boolean } | null;
};

export type JournalEvent =
  /** The live send answered: applied and undoable, or applied with nothing to undo (a no-op). */
  | { type: 'answered'; at: number; undoable: boolean }
  /** The server refused the action (a live answer, or a queued replay dropped at sync). */
  | { type: 'refused'; at: number }
  /** A live send got no answer. `queued`: it now waits in the queue, marked as sent. */
  | { type: 'no-answer'; at: number; queued: boolean }
  /** The queue marked it in flight and is sending it. */
  | { type: 'sync-sending'; at: number }
  /** Sync: the server applied it (or replayed an earlier apply). */
  | { type: 'sync-confirmed'; at: number }
  /** Sync: no answer, or a passing refusal; it stays in the queue, marked as sent. */
  | { type: 'sync-retry'; at: number }
  /** An Undo was sent, or its intent was queued. */
  | { type: 'undo-sent'; at: number; queued: boolean }
  /** Undone, already undone or never applied (server), or a never-sent entry removed locally. */
  | { type: 'undone'; at: number }
  /** The server refused the Undo for good (too late, changed since, not undoable, forbidden). */
  | { type: 'undo-refused'; at: number }
  /** The Undo did not go through for a passing reason (no PIN, cancelled, an outage): back to where it was. */
  | { type: 'undo-back'; at: number }
  /** Never sent, and gone from the queue for another reason (another session's entry). */
  | { type: 'discarded'; at: number };

/** Undo refusals that end the Undo for good; any other refusal sends the entry back to where it was. */
const FINAL_UNDO_REFUSALS: ReadonlySet<DeviceRefusal> = new Set(['undo_expired', 'changed_since', 'not_undoable', 'forbidden', 'conflict']);
export const undoRefusalEvent = (code: DeviceRefusal, at: number): JournalEvent =>
  FINAL_UNDO_REFUSALS.has(code) ? { type: 'undo-refused', at } : { type: 'undo-back', at };

export const journalEntry = (input: Pick<UndoJournalEntry, 'opId' | 'householdId' | 'deviceId' | 'generation' | 'capability' | 'actorUid' | 'label'> & { at: number; queued?: boolean }): UndoJournalEntry => ({
  opId: input.opId.toLowerCase(),
  householdId: input.householdId,
  deviceId: input.deviceId,
  generation: input.generation,
  capability: input.capability,
  actorUid: input.actorUid,
  label: input.label,
  state: input.queued ? 'queued-unsent' : 'attempting',
  createdAt: input.at,
  windowFrom: input.queued ? input.at : null,
  viaQueue: Boolean(input.queued),
  undo: null,
});

const to = (entry: UndoJournalEntry, state: JournalState, patch: Partial<UndoJournalEntry> = {}): UndoJournalEntry => ({ ...entry, state, undo: null, ...patch });

/**
 * The one transition function. An event that does not apply to the current state leaves it
 * as it is, and a final state never moves (a late or duplicate event changes nothing).
 */
export function journalStep(entry: UndoJournalEntry, event: JournalEvent): UndoJournalEntry {
  const { state } = entry;
  if (FINAL_STATES.has(state)) return entry;
  switch (event.type) {
    case 'answered':
      if (state !== 'attempting' && state !== 'unknown-outcome') return entry;
      // A no-op changed nothing this tablet could take back: nothing is reported as done.
      return event.undoable ? to(entry, 'applied', { windowFrom: event.at }) : to(entry, 'refused');
    case 'refused':
      return state === 'attempting' || state === 'unknown-outcome' || state === 'queued-unsent' || state === 'queued-sent' ? to(entry, 'refused') : entry;
    case 'no-answer':
      if (state !== 'attempting') return entry;
      return to(entry, event.queued ? 'queued-sent' : 'unknown-outcome', { windowFrom: event.at, viaQueue: entry.viaQueue || event.queued });
    case 'sync-sending':
      return state === 'queued-unsent' ? to(entry, 'queued-sent', { viaQueue: true }) : entry;
    case 'sync-confirmed':
      // The server's window starts at its answer; an Undo already on its way keeps going.
      if (state === 'queued-unsent' || state === 'queued-sent') return to(entry, 'applied', { windowFrom: event.at, viaQueue: true });
      if (state === 'undo-pending' && entry.undo?.from === 'queued-sent') return { ...entry, windowFrom: event.at, undo: { ...entry.undo, from: 'applied' } };
      return entry;
    case 'sync-retry':
      // Sent without an answer: it may be applied as of now.
      if (state === 'queued-unsent' || state === 'queued-sent') return to(entry, 'queued-sent', { windowFrom: event.at, viaQueue: true });
      if (state === 'undo-pending' && entry.undo?.from === 'queued-sent') return { ...entry, windowFrom: event.at };
      return entry;
    case 'undo-sent': {
      if (state !== 'unknown-outcome' && state !== 'applied' && state !== 'queued-sent' && state !== 'undo-pending') return entry;
      const from: UndoableState = state === 'undo-pending' && entry.undo ? entry.undo.from : (state as UndoableState);
      return { ...entry, state: 'undo-pending', undo: { from, queued: event.queued } };
    }
    case 'undone':
      return to(entry, 'undone');
    case 'undo-refused':
      return state === 'undo-pending' ? to(entry, 'expired') : entry;
    case 'undo-back':
      return state === 'undo-pending' && entry.undo ? to(entry, entry.undo.from) : entry;
    case 'discarded':
      return state === 'queued-unsent' ? to(entry, 'refused') : entry;
    default:
      return entry;
  }
}

/** Whether the Undo button is offered now, and for how long (device clock). */
export function undoOffer(entry: UndoJournalEntry, now: number): { offered: boolean; remainingMs: number } {
  if (entry.state === 'unknown-outcome' || entry.state === 'applied' || entry.state === 'queued-sent' || entry.state === 'queued-unsent') {
    const remainingMs = entry.windowFrom === null ? 0 : Math.max(0, entry.windowFrom + JOURNAL_UNDO_WINDOW_MS - now);
    return { offered: remainingMs > 0, remainingMs };
  }
  return { offered: false, remainingMs: 0 };
}

/**
 * What tapping Undo does:
 * - `remove-locally`: `removeIfNeverSent` first (it alone decides, under the queue lock; when
 *   it finds the entry was sent meanwhile, the caller moves it to queued-sent and routes again);
 * - `send`: by opId, after authorizing the original actor;
 * - `queue-undo`: offline, an Undo intent waits in the queue;
 * - `needs-connection`: it can't wait (a PIN is needed, or the queue isn't durable); the entry
 *   stays as it is and stays offered;
 * - `none`: nothing to undo.
 */
export type UndoRoute = 'remove-locally' | 'send' | 'queue-undo' | 'needs-connection' | 'none';

export function undoRoute(entry: UndoJournalEntry, context: { now: number; online: boolean; undoCanWait: boolean }): UndoRoute {
  if (!undoOffer(entry, context.now).offered) return 'none';
  if (entry.state === 'queued-unsent') return 'remove-locally';
  if (context.online) return 'send';
  return context.undoCanWait ? 'queue-undo' : 'needs-connection';
}

/**
 * An entry as it comes back after a reload: a send the page lost may have reached the
 * server (unknown outcome, its window counted from when it could last have applied); an
 * Undo that was being sent live may not have arrived (offered again: the server's ledger
 * answers a second Undo `already`); everything else as stored.
 */
export function restoreJournalEntry(entry: UndoJournalEntry, now: number): UndoJournalEntry {
  if (entry.state === 'attempting') return to(entry, 'unknown-outcome', { windowFrom: Math.min(now, entry.createdAt + JOURNAL_MAX_SEND_MS) });
  if (entry.state === 'undo-pending' && entry.undo && !entry.undo.queued) return to(entry, entry.undo.from);
  return entry;
}

const ofSession = (entry: UndoJournalEntry, session: QueueSession) =>
  entry.householdId === session.householdId && entry.deviceId === session.deviceId && entry.generation === session.generation;

/** After a reload: this session's entries, restored, with the Undo toasts that come back and their time left. */
export function restorableUndos(entries: readonly UndoJournalEntry[], now: number, session: QueueSession): Array<{ entry: UndoJournalEntry; remainingMs: number }> {
  return entries
    .filter((entry) => ofSession(entry, session))
    .map((entry) => restoreJournalEntry(entry, now))
    .map((entry) => ({ entry, remainingMs: undoOffer(entry, now).remainingMs }))
    .filter((item) => item.remainingMs > 0)
    .sort((a, b) => a.remainingMs - b.remainingMs);
}

/**
 * Entries to delete: another session's, final ones, or past their window plus the keep
 * margin. Queued entries (and an Undo waiting in the queue) stay while the queue may still
 * send them: they take the server's window when sync confirms them.
 */
export function expiredJournalEntries(entries: readonly UndoJournalEntry[], now: number, session: QueueSession): UndoJournalEntry[] {
  return entries.filter((entry) => {
    if (!ofSession(entry, session)) return true;
    if (FINAL_STATES.has(entry.state)) return true;
    if (entry.state === 'queued-unsent' || entry.state === 'queued-sent' || entry.state === 'undo-pending') {
      return now - entry.createdAt > JOURNAL_QUEUED_KEEP_MS;
    }
    const from = entry.windowFrom ?? entry.createdAt + JOURNAL_MAX_SEND_MS;
    return now - from > JOURNAL_UNDO_WINDOW_MS + JOURNAL_KEEP_MS;
  });
}

export async function recordAttempt(store: RecordStore<UndoJournalEntry>, entry: UndoJournalEntry): Promise<void> {
  await store.put(entry);
}

/**
 * One step, and whether it took the action back ("reverted"): the entry moved into `undone`.
 * That covers every way an action is taken back: a never-sent entry removed locally, a live
 * Undo answered, a queued Undo answered at sync (undone, already, not applied), and the
 * queued original answered "already undone" at sync. A final state never moves, so this is
 * true at most once per entry; an entry that ends applied (or refused, or expired) never
 * reports it.
 */
export function journalTransition(entry: UndoJournalEntry, event: JournalEvent): { entry: UndoJournalEntry; reverted: boolean } {
  const next = journalStep(entry, event);
  return { entry: next, reverted: entry.state !== 'undone' && next.state === 'undone' };
}

/**
 * Applies one event to a stored entry (read, step, write). The new entry, or null when none
 * is stored. `onReverted` runs once, after the write, when this step took the action back.
 */
export async function stepJournal(
  store: RecordStore<UndoJournalEntry>,
  opId: string,
  event: JournalEvent,
  onReverted?: (opId: string) => void,
): Promise<UndoJournalEntry | null> {
  const current = await store.get(opId.toLowerCase());
  if (!current) return null;
  const { entry: next, reverted } = journalTransition(current, event);
  if (next !== current) await store.put(next);
  if (reverted) onReverted?.(next.opId);
  return next;
}

/**
 * After a reload: prunes, stores every entry of this session as restored (a send the page
 * lost becomes an unknown outcome for good), and returns the Undo toasts that come back.
 */
export async function restoreJournal(store: RecordStore<UndoJournalEntry>, now: number, session: QueueSession): Promise<Array<{ entry: UndoJournalEntry; remainingMs: number }>> {
  await pruneJournal(store, now, session);
  const entries = (await store.all()).filter((entry) => ofSession(entry, session));
  for (const entry of entries) {
    const restored = restoreJournalEntry(entry, now);
    if (restored !== entry) await store.put(restored);
  }
  return restorableUndos(await store.all(), now, session);
}

export async function pruneJournal(store: RecordStore<UndoJournalEntry>, now: number, session: QueueSession): Promise<number> {
  const expired = expiredJournalEntries(await store.all(), now, session);
  for (const entry of expired) await store.delete(entry.opId);
  return expired.length;
}
