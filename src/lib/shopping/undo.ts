/**
 * Undo for shopping ticks and deletes (S3: SH-15a/b, UNDO-10s, WT-20).
 *
 * Pure logic only (no Firestore): the Undo window, operation ids, the plans that
 * decide whether an Undo may still be written, and the per-device Undo journal
 * that re-offers the rest of the window after a reload.
 *
 * An Undo never writes back a stale copy of the whole item:
 * - a tick writes a fresh `purchaseOpId`; its Undo writes only
 *   `{ status: 'needed', undoOpId: <that id>, purchasedByUid: null, purchasedAt: null }`,
 *   and the rules accept it only while the item's `purchaseOpId` is still that id,
 *   so a re-tick (or anything that wrote a new purchase) by someone else wins;
 * - a delete's Undo re-creates the item with a fresh `restoreOpId`, which the rules
 *   accept only on a create, so it never overwrites an item that came back meanwhile.
 * Both are ordinary queued writes, so they also work offline and after a reload.
 */

/**
 * The one Undo window (16.3 "one Undo window everywhere: 10 seconds"). No shared
 * app-wide constant exists yet on this branch; when one lands, use it here.
 */
export const UNDO_WINDOW_MS = 10_000;

/** The journal key in localStorage (one per device; entries are scoped by user, household and list). */
export const UNDO_JOURNAL_KEY = 'homehub.shopping.undo.v1';

export type UndoGroup = 'shopping-tick' | 'shopping-remove';

type UndoBase = {
  group: UndoGroup;
  uid: string;
  householdId: string;
  listId: string;
  itemId: string;
  /** The item's name, for "Milk is in the cart". */
  name: string;
  /** The tick's `purchaseOpId`, or the restore's `restoreOpId`. */
  opId: string;
  /** Epoch ms when the Undo stops being offered. */
  expiresAt: number;
  /** An extra line (the first offline tick's note, SH-7c). */
  note?: string;
};

export type TickUndo = UndoBase & { group: 'shopping-tick' };
/** `data` is the restore document in journal form (`toJournalData`). */
export type RemoveUndo = UndoBase & { group: 'shopping-remove'; data: Record<string, JournalValue> };
export type UndoEntry = TickUndo | RemoveUndo;

export type JournalValue = string | number | boolean | null | { $date: number };

/** A fresh id for one tick or restore (at most 64 characters, as the rules require). */
export function newOpId(random: () => string = defaultRandom): string {
  return random().replace(/[^A-Za-z0-9-]/g, '').slice(0, 64) || `op-${Date.now().toString(36)}`;
}

function defaultRandom(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

/** Milliseconds of the window left (0 once expired). */
export function remainingMs(entry: Pick<UndoEntry, 'expiresAt'>, now: number): number {
  return Math.max(0, entry.expiresAt - now);
}

// --- Plans ------------------------------------------------------------------

/** What the screen knows about the item right now (the live listener or the cache); undefined = not known. */
export type KnownItem = { status?: string; purchaseOpId?: string | null } | null | undefined;

export type TickUndoPlan =
  /** Write the Undo; the rules make the final call (another device may have changed it). */
  | 'write'
  /** Someone else changed the item after this tick (a new purchase or it is gone): do not undo. */
  | 'refused'
  /** Already needed again under the same purchase (undone here or elsewhere): nothing to do. */
  | 'already';

/**
 * Whether the Undo of the tick `opId` may be written. `known` is the item as this
 * screen sees it: `null` = known to be gone, `undefined` = not known (another list
 * is open, or the list has not loaded after a reload), in which case the rules decide.
 */
export function planTickUndo(known: KnownItem, opId: string): TickUndoPlan {
  if (known === undefined) return 'write';
  if (known === null) return 'refused';
  if ((known.purchaseOpId ?? null) !== opId) return 'refused';
  return known.status === 'purchased' ? 'write' : 'already';
}

export type RemoveUndoPlan = 'write' | 'already';

/**
 * A delete's Undo re-creates the item only if it is absent: when the screen
 * already shows it again (restored on another device, or the delete was refused)
 * there is nothing to do. Unknown means write; the rules refuse an overwrite.
 */
export function planRemoveUndo(known: KnownItem): RemoveUndoPlan {
  return known ? 'already' : 'write';
}

/**
 * True when a refused Undo means "someone else changed it": the rules denied the
 * guarded write (another purchase, or the item exists again) or the item is gone.
 */
export function isChangedElsewhere(error: unknown): boolean {
  const code = typeof error === 'object' && error !== null && 'code' in error ? String((error as { code: unknown }).code) : '';
  return code === 'permission-denied' || code === 'not-found' || code === 'firestore/permission-denied' || code === 'firestore/not-found';
}

export const CHANGED_ELSEWHERE_TITLE = 'Changed by someone else — not undone';

// --- Journal ----------------------------------------------------------------

/** The part of Storage the journal uses (localStorage in the app, a stub in tests). */
export type JournalStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/** localStorage, or null where it is unavailable (server, private mode, blocked site data). */
export function browserJournalStorage(): JournalStorage | null {
  try {
    return typeof window !== 'undefined' && window.localStorage ? window.localStorage : null;
  } catch {
    return null;
  }
}

function isEntry(value: unknown): value is UndoEntry {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Record<string, unknown>;
  const strings = ['uid', 'householdId', 'listId', 'itemId', 'name', 'opId'].every((key) => typeof entry[key] === 'string' && (entry[key] as string).length > 0);
  if (!strings || typeof entry.expiresAt !== 'number') return false;
  if (entry.group === 'shopping-tick') return true;
  return entry.group === 'shopping-remove' && typeof entry.data === 'object' && entry.data !== null;
}

/** The unexpired entries in the journal (at most one per group); never throws. */
export function readJournal(storage: JournalStorage | null, now: number): UndoEntry[] {
  if (!storage) return [];
  try {
    const raw = storage.getItem(UNDO_JOURNAL_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isEntry).filter((entry) => remainingMs(entry, now) > 0);
  } catch {
    return [];
  }
}

function writeJournal(storage: JournalStorage | null, entries: UndoEntry[]): void {
  if (!storage) return;
  try {
    if (entries.length === 0) storage.removeItem(UNDO_JOURNAL_KEY);
    else storage.setItem(UNDO_JOURNAL_KEY, JSON.stringify(entries));
  } catch {
    // Full or blocked storage: the Undo still works until the page closes.
  }
}

/** Adds `entry`, replacing the older entry of its group (one Undo per group, like a toast group); drops expired ones. */
export function pushJournal(storage: JournalStorage | null, entry: UndoEntry, now: number): UndoEntry[] {
  const next = [...readJournal(storage, now).filter((existing) => existing.group !== entry.group), entry];
  writeJournal(storage, next);
  return next;
}

/** Removes the entry with `opId` (used, refused or dismissed). */
export function dropJournal(storage: JournalStorage | null, opId: string, now: number): UndoEntry[] {
  const next = readJournal(storage, now).filter((entry) => entry.opId !== opId);
  writeJournal(storage, next);
  return next;
}

/** The entries this signed-in member may be offered in this household. */
export function journalFor(entries: readonly UndoEntry[], uid: string | null | undefined, householdId: string | null | undefined): UndoEntry[] {
  if (!uid || !householdId) return [];
  return entries.filter((entry) => entry.uid === uid && entry.householdId === householdId);
}

// --- Restore data in journal form ---------------------------------------------

const hasToMillis = (value: unknown): value is { toMillis: () => number } =>
  typeof value === 'object' && value !== null && typeof (value as { toMillis?: unknown }).toMillis === 'function';

/**
 * The restore document as JSON-safe values: dates and Firestore timestamps become
 * `{ $date: ms }`; anything else that is not a plain scalar is dropped.
 */
export function toJournalData(data: Record<string, unknown>): Record<string, JournalValue> {
  const out: Record<string, JournalValue> = {};
  for (const [key, value] of Object.entries(data)) {
    if (value === null || typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) {
      out[key] = value as JournalValue;
    } else if (value instanceof Date && Number.isFinite(value.getTime())) {
      out[key] = { $date: value.getTime() };
    } else if (hasToMillis(value)) {
      out[key] = { $date: value.toMillis() };
    }
  }
  return out;
}

/** Back from journal form: `{ $date }` becomes a Date (written as a Firestore timestamp). */
export function fromJournalData(data: Record<string, JournalValue>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    out[key] = value !== null && typeof value === 'object' && typeof value.$date === 'number' ? new Date(value.$date) : value;
  }
  return out;
}

// --- Focus ------------------------------------------------------------------

/**
 * The row that should take focus after the row `id` leaves (SH-26a): the next one,
 * else the previous one, else none. `ids` are the rows in screen order.
 */
export function nextFocusId(ids: readonly string[], id: string): string | null {
  const index = ids.indexOf(id);
  if (index === -1) return null;
  return ids[index + 1] ?? ids[index - 1] ?? null;
}
