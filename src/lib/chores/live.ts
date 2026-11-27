/**
 * What the Chores page holds from its live listeners (CH-1): members, chores, chore
 * templates and rooms of one household. Framework-free and unit tested;
 * `useChoreLiveData` (src/components/chores/use-chore-live-data.ts) drives it.
 *
 * - The state is keyed by the listener key (household and member). An answer or failure
 *   for another key starts over, so one household's chores never show in another's.
 * - The page is `ready` once every collection has answered once for the key.
 * - A failure before that is the page's error state (CH-8: never a false "No chores
 *   yet"); the listeners keep retrying with backoff, and on `online` / visible. A
 *   failure after that keeps what loaded (the listener retries).
 */

export const CHORE_COLLECTIONS = ['members', 'chores', 'chore-templates', 'rooms'] as const;
export type ChoreCollection = typeof CHORE_COLLECTIONS[number];

export type LiveDoc = { id: string; data: Record<string, unknown> };

export type ChoreLiveState = {
  key: string | null;
  session: number;
  docs: Record<ChoreCollection, LiveDoc[] | null>;
  failures: Partial<Record<ChoreCollection, 'retrying' | 'unauthorized'>>;
};

const EMPTY: ChoreLiveState['docs'] = { members: null, chores: null, 'chore-templates': null, rooms: null };

export const initialChoreLiveState = (key: string | null = null, session = 0): ChoreLiveState => ({ key, session, docs: EMPTY, failures: {} });

export type ChoreLiveEvent =
  | { type: 'answer'; key: string; session: number; collection: ChoreCollection; docs: LiveDoc[] }
  | { type: 'failure'; key: string; session: number; collection: ChoreCollection; failure: 'retrying' | 'unauthorized' };

export function choreLiveReducer(state: ChoreLiveState, event: ChoreLiveEvent): ChoreLiveState {
  const base = state.key === event.key && state.session === event.session ? state : initialChoreLiveState(event.key, event.session);
  if (event.type === 'answer') {
    const failures = { ...base.failures };
    delete failures[event.collection];
    return { ...base, docs: { ...base.docs, [event.collection]: event.docs }, failures };
  }
  return { ...base, failures: { ...base.failures, [event.collection]: event.failure } };
}

export type ChoreLiveStatus = 'loading' | 'ready' | 'error';

/** Ready once every collection answered; an error only while something has not answered yet. */
export function choreLiveStatus(state: ChoreLiveState): ChoreLiveStatus {
  const missing = CHORE_COLLECTIONS.filter(collection => state.docs[collection] === null);
  if (missing.length === 0) return 'ready';
  return missing.some(collection => state.failures[collection]) ? 'error' : 'loading';
}

/** Whether two stored values are the same (plain data, arrays, maps and Firestore timestamps). */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

function sameRow(a: object, b: object): boolean {
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const key of keys) if (!sameValue(left[key], right[key])) return false;
  return true;
}

/**
 * CH-26: the next rows, reusing the previous object for every row whose content is
 * unchanged, so a snapshot that changed one chore re-renders only that row (rows
 * are memoised by object identity). Returns `previous` itself when nothing changed.
 */
export function keepUnchangedRows<T extends { id: string }>(next: readonly T[], previous: readonly T[]): T[] {
  const before = new Map(previous.map(row => [row.id, row]));
  let changed = next.length !== previous.length;
  const rows = next.map((row, index) => {
    const old = before.get(row.id);
    const kept = old && (old === row || sameRow(old, row)) ? old : row;
    if (kept !== previous[index]) changed = true;
    return kept;
  });
  return changed ? rows : (previous as T[]);
}

/**
 * The rows the page shows: the listener's rows, except chores with a write in flight
 * (`pending`), which keep the page's own optimistic version (or stay hidden when the
 * page already removed them) until the write settles, so an unrelated snapshot never
 * flips a just-ticked row back for a moment. Order follows the listener.
 */
export function mergeLiveRows<T extends { id: string }>(server: readonly T[], local: readonly T[], pending: ReadonlySet<string>): T[] {
  if (pending.size === 0) return [...server];
  const localById = new Map(local.map(row => [row.id, row]));
  const rows: T[] = [];
  const seen = new Set<string>();
  for (const row of server) {
    seen.add(row.id);
    if (!pending.has(row.id)) rows.push(row);
    else if (localById.has(row.id)) rows.push(localById.get(row.id)!);
  }
  for (const row of local) {
    if (pending.has(row.id) && !seen.has(row.id)) rows.push(row);
  }
  return rows;
}
