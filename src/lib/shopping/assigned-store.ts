/**
 * Which store the open list follows, while the household's stores listener may
 * still be loading (S6: SH-34b). The list document and the stores collection
 * arrive on independent listeners, so a list that names a store can be on
 * screen before that store is. "Not loaded yet" must not look like "no store":
 * a category move would then rewrite the list's own order instead of the
 * store's aisle order, and a new store would start from the wrong order.
 * No Firebase imports, so it is unit tested under Node
 * (tests/unit/shopping-assigned-store.test.ts).
 */

/** The parts of the stores listener state this needs (`LiveState` from `./live-state`). */
export type StoresSnapshot<T> = {
  status: 'loading' | 'ready' | 'error';
  value: readonly T[];
  fromCache: boolean;
};

/**
 * - `none`: the list names no store; it follows its own order.
 * - `found`: the named store is loaded (from the server or the cache).
 * - `loading`: no stores snapshot has arrived yet.
 * - `unconfirmed`: a snapshot arrived but only the cache (or a failed listener)
 *   says the store is absent, which does not prove it was deleted.
 * - `missing`: the server confirmed the named store does not exist; the list
 *   falls back to its own order.
 */
export type AssignedStoreState = 'none' | 'found' | 'loading' | 'unconfirmed' | 'missing';

export type AssignedStore<T> = {
  state: AssignedStoreState;
  /** The store whose aisle order the list follows; null for every state but `found`. */
  store: T | null;
  /** The list's `storeId` when it names one. */
  storeId: string | null;
  /** The open list waits (skeleton) instead of grouping by its own order first. */
  waitForStore: boolean;
  /**
   * Category moves and store changes are allowed: the target of a move (the
   * store's aisle order or the list's own order) and the store select's
   * current value are known for sure.
   */
  resolved: boolean;
};

export function assignedStore<T extends { id: string }>(storeId: unknown, stores: StoresSnapshot<T>): AssignedStore<T> {
  const id = typeof storeId === 'string' && storeId ? storeId : null;
  const result = (state: AssignedStoreState, store: T | null = null): AssignedStore<T> => ({
    state,
    store,
    storeId: id,
    waitForStore: state === 'loading',
    resolved: state === 'none' || state === 'found' || state === 'missing',
  });
  if (!id) return result('none');
  const store = stores.value.find((entry) => entry.id === id);
  if (store) return result('found', store);
  if (stores.status === 'loading') return result('loading');
  if (stores.status === 'ready' && !stores.fromCache) return result('missing');
  return result('unconfirmed');
}

/**
 * The stores the select offers are complete enough to pick from or to check a
 * new store's name against: a snapshot has arrived.
 */
export const storesListed = (stores: { status: 'loading' | 'ready' | 'error' }): boolean => stores.status !== 'loading';
