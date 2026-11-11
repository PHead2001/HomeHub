/**
 * Helpers behind the live Shopping and Pantry listeners (`./live.ts`): how a
 * snapshot becomes screen state, which lists get a live count listener, the
 * retry delay after a listener fails, and when a list on screen counts as deleted.
 * No Firebase imports, so they are unit-tested under Node.
 */

type Unsubscribe = () => void;

/** The parts of a Firestore snapshot's metadata the screens use. */
export type LiveMetadata = { fromCache: boolean; hasPendingWrites: boolean };

/**
 * Screen state of one live subscription. `key` names what it was produced for
 * (household and list): a consumer only shows `value` while the key still
 * matches, so a list switch or household change never shows another list's data.
 */
export type LiveState<T> = LiveMetadata & {
  key: string;
  status: 'loading' | 'ready' | 'error';
  value: T;
  error: unknown;
};

/** A stable key for a subscription; null when there is nothing to subscribe to. */
export const liveKey = (...parts: Array<string | null | undefined>): string | null =>
  parts.some((part) => !part) ? null : parts.map((part) => encodeURIComponent(part as string)).join('/');

/** Initial (loading) state for `key`. */
export const loadingState = <T>(key: string, empty: T): LiveState<T> => ({
  key,
  status: 'loading',
  value: empty,
  error: null,
  fromCache: true,
  hasPendingWrites: false,
});

/**
 * The state after a snapshot: its mapped value and metadata. A cached snapshot
 * (`fromCache`) does not prove the listener works, so it keeps the error of the
 * same subscription on screen; only a snapshot the server confirmed clears it.
 * Without this, a refused listener that answers from the cache before each
 * denial would raise a "new" error (and a new toast) on every retry.
 */
export const snapshotToState = <T>(key: string, value: T, metadata: LiveMetadata, previous?: LiveState<T>): LiveState<T> => ({
  key,
  status: 'ready',
  value,
  error: metadata.fromCache && previous?.key === key ? previous.error : null,
  fromCache: metadata.fromCache,
  hasPendingWrites: metadata.hasPendingWrites,
});

const errorCode = (error: unknown): unknown =>
  error && typeof error === 'object' && 'code' in error ? (error as { code?: unknown }).code : undefined;

/**
 * Whether two listener errors are the same failure: the same object, or errors
 * with the same Firestore `code` (each retry raises a new error object).
 */
export const sameListenerError = (a: unknown, b: unknown): boolean => {
  if (a === b) return true;
  const code = errorCode(a);
  return code !== undefined && code === errorCode(b);
};

/**
 * The state after a listener error: the last value stays on screen (a failed
 * listener never blanks the list), marked as an error until a retry succeeds.
 */
export const errorToState = <T>(previous: LiveState<T>, key: string, error: unknown, empty: T): LiveState<T> => (
  previous.key === key
    ? {
      ...previous,
      status: previous.status === 'ready' ? 'ready' : 'error',
      // The same failure again keeps the first error object, so the screens
      // (which report an error once, by identity) show one toast for a retry loop.
      error: sameListenerError(previous.error, error) ? previous.error : error,
      fromCache: true,
    }
    : { ...loadingState(key, empty), status: 'error', error }
);

/** What a consumer may show for `key`: the state, or loading when it belongs to another key. */
export const stateFor = <T>(state: LiveState<T>, key: string | null, empty: T): LiveState<T> => {
  if (!key) return { ...loadingState('', empty), status: 'ready', fromCache: false };
  return state.key === key ? state : loadingState(key, empty);
};

/** Maps query documents to `{ id, ...data }` records. */
export const docsToRecords = <T extends { id: string }>(docs: ReadonlyArray<{ id: string; data: () => unknown }>): T[] =>
  docs.map((entry) => ({ ...(entry.data() as object), id: entry.id } as T));

/** Needed / purchased counts of a list's items (anything not purchased is needed). */
export const countItems = (items: ReadonlyArray<{ status?: unknown }>): { needed: number; purchased: number } => {
  let purchased = 0;
  for (const item of items) if (item.status === 'purchased') purchased += 1;
  return { needed: items.length - purchased, purchased };
};

/** Most lists that get their own live items listener on the overview. */
export const LIVE_COUNT_LIMIT = 20;

/**
 * Which lists get a live items listener for their card counts (the first
 * `limit`, in the order shown) and which fall back to two count queries.
 */
export const planCountSources = (listIds: readonly string[], limit = LIVE_COUNT_LIMIT): { live: string[]; fallback: string[] } => {
  const unique = [...new Set(listIds)];
  const cap = Math.max(0, Math.floor(limit));
  return { live: unique.slice(0, cap), fallback: unique.slice(cap) };
};

/** Delay before retry `attempt` (0-based) of a failed listener: doubling from `base`, never above `max`. */
export const backoffDelay = (attempt: number, { base = 1000, max = 30_000 }: { base?: number; max?: number } = {}): number => {
  const safe = Number.isFinite(attempt) && attempt > 0 ? Math.floor(attempt) : 0;
  // 2 ** 30 is far past any max; capping the exponent avoids Infinity.
  return Math.min(max, base * 2 ** Math.min(safe, 30));
};

/** A listener hidden this long resubscribes when the page is shown again (a tablet that slept). */
export const STALE_AFTER_HIDDEN_MS = 30_000;

/**
 * Whether the open list was deleted while it was on screen: it was seen in the
 * lists snapshot for this household and is now missing, and this device did not
 * delete it itself. A list never seen (a stale `?list=` link) is "not found"
 * instead, which the overview handles.
 */
export const isOpenListDeleted = ({
  listId,
  seenListId,
  listIds,
  listsReady,
  deletingListId,
}: {
  listId: string | null;
  seenListId: string | null;
  listIds: readonly string[];
  listsReady: boolean;
  deletingListId: string | null;
}): boolean => Boolean(
  listId
  && listsReady
  && seenListId === listId
  && deletingListId !== listId
  && !listIds.includes(listId),
);

/**
 * Whether a `?list=` link names a list that does not exist: decided only from a
 * snapshot the server confirmed (or offline, from the cache), so a cache that has
 * not seen a new list yet never sends the member back to the overview.
 */
export const isListLinkMissing = ({
  listId,
  listIds,
  listsReady,
  fromCache,
  offline,
}: {
  listId: string | null;
  listIds: readonly string[];
  listsReady: boolean;
  fromCache: boolean;
  offline: boolean;
}): boolean => Boolean(listId && !listIds.includes(listId) && listsConfirmed({ listsReady, fromCache, offline }));

/**
 * Whether the lists on screen may drive a one-shot decision (a missing `?list=`
 * link, the `?quickAdd=1` shortcut): a snapshot the server confirmed, or the
 * cache when offline. Cached lists are drawn at once either way; only decisions
 * that consume a URL parameter wait, so a list deleted elsewhere but still in the
 * cache is never chosen.
 */
export const listsConfirmed = ({ listsReady, fromCache, offline }: { listsReady: boolean; fromCache: boolean; offline: boolean }): boolean =>
  listsReady && (!fromCache || offline);

export type QuickAddDecision =
  | { kind: 'wait' }
  | { kind: 'open'; listId: string }
  | { kind: 'choose' }
  | { kind: 'empty' }
  | { kind: 'read-only' };

/**
 * What the `?quickAdd=1` shortcut does with the lists: wait for confirmed lists;
 * then open the add dialog on the only list, or else the first Grocery list; ask
 * the member to choose when there are lists but no such target. A household
 * with no lists is `empty` (the screen explains and offers a Groceries list,
 * SH-10h) and a member who cannot edit is `read-only` (the screen says so):
 * the shortcut is never a silent no-op.
 */
export const quickAddDecision = ({
  requested,
  confirmed,
  canEdit,
  lists,
}: {
  requested: boolean;
  confirmed: boolean;
  canEdit: boolean;
  lists: ReadonlyArray<{ id: string; type?: unknown }>;
}): QuickAddDecision | null => {
  if (!requested) return null;
  if (!confirmed) return { kind: 'wait' };
  if (!canEdit) return { kind: 'read-only' };
  const target = lists.length === 1 ? lists[0] : lists.find((list) => list.type === 'Grocery');
  if (target) return { kind: 'open', listId: target.id };
  return lists.length > 0 ? { kind: 'choose' } : { kind: 'empty' };
};

/**
 * Tracks a tab's active flag across renders and reports the render where it
 * turned inactive, so the tab can close its portaled overlays in that same
 * render (a dialog's portal lives outside the hidden panel).
 */
export const deactivated = (previous: boolean, active: boolean): boolean => previous && !active;

/** The render or effect where a flag turned on (a dialog that just opened). */
export const justOpened = (previous: boolean, open: boolean): boolean => !previous && open;

/**
 * Whether this device's own list deletion has settled: the screen no longer has
 * the list open and the lists snapshot no longer holds it. Then the "deleting"
 * marker is cleared, so a list re-created under the same id and later deleted
 * elsewhere gets the deletion notice and the missing-link fallback again.
 */
export const deletionSettled = ({
  deletingListId,
  selectedListId,
  listIds,
}: {
  deletingListId: string | null;
  selectedListId: string | null;
  listIds: readonly string[];
}): boolean => Boolean(deletingListId && selectedListId !== deletingListId && !listIds.includes(deletingListId));

/** The purchased items captured when Clear was pressed, and the list they came from. */
export type ClearTarget = { householdId: string; listId: string; ids: readonly string[] };

/**
 * The ids a Clear confirmation may delete on the list now on screen: its captured
 * ids when it was opened on this household and list, else null (a confirmation
 * left open across Back and another list never clears that list).
 */
export const clearIdsFor = (
  target: ClearTarget | null,
  householdId: string | null | undefined,
  listId: string | null | undefined,
): readonly string[] | null => (
  target && householdId && listId && target.householdId === householdId && target.listId === listId ? target.ids : null
);

export const isHidden = () => typeof document !== 'undefined' && document.visibilityState === 'hidden';

/**
 * Keeps one listener alive: `open` starts it and returns its unsubscribe. After an
 * error it is reopened after `backoffDelay(attempt)`. Only a snapshot the server
 * confirmed (`healthy(false)`, from `!snapshot.metadata.fromCache`) resets the
 * backoff: Firestore answers each resubscribe from the cache before a denial, so
 * a cached answer resetting it would keep a refused listener retrying every
 * second forever (the dashboard's `resilientListener` does the same); while the page is hidden no retry is scheduled, and showing the page
 * or coming back online reopens it at once. A renewal starts the new listener
 * before stopping the old one, so the target never leaves Firestore's cache.
 * Returns the stop function.
 */
export function keepListening(open: (handlers: { healthy: (fromCache: boolean) => void; failed: () => void }) => Unsubscribe): () => void {
  let current: Unsubscribe | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let attempt = 0;
  let stopped = false;
  let hiddenAt: number | null = null;

  const clearTimer = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };

  const subscribe = () => {
    clearTimer();
    if (stopped) return;
    const previous = current;
    current = null;
    let active = true;
    let unsubscribe: Unsubscribe | null = null;
    const stop = () => {
      active = false;
      unsubscribe?.();
      unsubscribe = null;
    };
    unsubscribe = open({
      healthy: (fromCache) => {
        if (active && !fromCache) attempt = 0;
      },
      failed: () => {
        if (!active) return;
        // Also reached synchronously, before `open` returned: `unsubscribe` is
        // then still null and the listener is stopped right after.
        if (current === stop) current = null;
        stop();
        scheduleRetry();
      },
    });
    if (active) current = stop;
    else unsubscribe?.();
    previous?.();
  };

  const scheduleRetry = () => {
    if (stopped || timer !== null || isHidden()) return;
    const delay = backoffDelay(attempt);
    attempt += 1;
    timer = setTimeout(subscribe, delay);
  };

  const onOnline = () => subscribe();
  const onVisibility = () => {
    if (isHidden()) {
      hiddenAt = Date.now();
      return;
    }
    const hiddenFor = hiddenAt === null ? 0 : Date.now() - hiddenAt;
    hiddenAt = null;
    if (current === null || hiddenFor >= STALE_AFTER_HIDDEN_MS) subscribe();
  };

  subscribe();
  if (typeof window !== 'undefined') window.addEventListener('online', onOnline);
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility);

  return () => {
    stopped = true;
    clearTimer();
    current?.();
    current = null;
    if (typeof window !== 'undefined') window.removeEventListener('online', onOnline);
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility);
  };
}
