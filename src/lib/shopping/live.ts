'use client';

import { useEffect, useRef, useState } from 'react';
import {
  collection,
  doc,
  getCountFromServer,
  onSnapshot,
  orderBy,
  query,
  where,
  type Unsubscribe,
} from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { onDataChanged } from '@/lib/data-changed';
import { DEFAULT_SHOPPING_CATEGORIES } from '@/lib/shopping-items';
import type { PantryItem, ShoppingList, ShoppingListItem, ShoppingStore } from '@/lib/types';
import { readCategoryConfig, type CategoryConfig } from './category-order';
import {
  countItems,
  docsToRecords,
  errorToState,
  isHidden,
  keepListening,
  liveKey,
  loadingState,
  planCountSources,
  snapshotToState,
  stateFor,
  type LiveMetadata,
  type LiveState,
} from './live-state';

/**
 * Live Shopping and Pantry data (SH-1). Every hook here is an `onSnapshot`
 * listener with metadata changes, so the screen also learns when it shows the
 * cache (`fromCache`) or this device's unsent writes (`hasPendingWrites`).
 * Firestore applies this device's own writes to the listener at once (also
 * offline, from its queue), and rolls them back in the listener when the server
 * rejects them, so the screens never re-read after a write. A listener that
 * fails retries with bounded backoff (reset only by a snapshot the server
 * confirmed, and the same error code is reported once); it resubscribes at once when the browser
 * comes back online or the page is shown again, and a listener left hidden for
 * a while is renewed when shown (a wall tablet that slept). Each hook's state is
 * keyed by household (and list): a switch shows loading, never the previous
 * list's data.
 */

export type Listen<T> = (next: (value: T, metadata: LiveMetadata) => void, fail: (error: unknown) => void) => Unsubscribe;

/** One kept-alive listener as React state, scoped to `key` (null: nothing to listen to). */
export function useLive<T>(key: string | null, empty: T, listen: Listen<T>): LiveState<T> {
  const [state, setState] = useState<LiveState<T>>(() => loadingState(key ?? '', empty));
  const listenRef = useRef(listen);
  const emptyRef = useRef(empty);
  useEffect(() => {
    listenRef.current = listen;
    emptyRef.current = empty;
  });

  useEffect(() => {
    if (!key) return;
    return keepListening(({ healthy, failed }) => listenRef.current(
      (value, metadata) => {
        healthy(metadata.fromCache);
        setState((previous) => snapshotToState(key, value, metadata, previous));
      },
      (error) => {
        setState((previous) => errorToState(previous, key, error, emptyRef.current));
        failed();
      },
    ));
  }, [key]);

  return stateFor(state, key, empty);
}

const NO_LISTS: ShoppingList[] = [];
const NO_ITEMS: ShoppingListItem[] = [];
const NO_PANTRY: PantryItem[] = [];

const listsCollection = (householdId: string) => collection(db, 'households', householdId, 'shopping-lists');
const itemsCollection = (householdId: string, listId: string) => collection(db, 'households', householdId, 'shopping-lists', listId, 'items');

/** The household's shopping lists, sorted by name. */
export function useLiveShoppingLists(householdId: string | null | undefined): LiveState<ShoppingList[]> {
  const key = liveKey('lists', householdId);
  return useLive(key, NO_LISTS, (next, fail) => onSnapshot(
    listsCollection(householdId as string),
    { includeMetadataChanges: true },
    (snapshot) => next(
      docsToRecords<ShoppingList>(snapshot.docs).sort((a, b) => String(a.name ?? '').localeCompare(String(b.name ?? ''))),
      snapshot.metadata,
    ),
    fail,
  ));
}

/** The items of one list (null list: nothing). */
export function useLiveListItems(householdId: string | null | undefined, listId: string | null | undefined): LiveState<ShoppingListItem[]> {
  const key = liveKey('items', householdId, listId);
  return useLive(key, NO_ITEMS, (next, fail) => onSnapshot(
    itemsCollection(householdId as string, listId as string),
    { includeMetadataChanges: true },
    (snapshot) => next(docsToRecords<ShoppingListItem>(snapshot.docs), snapshot.metadata),
    fail,
  ));
}

const NO_CONFIG: CategoryConfig = readCategoryConfig(null, false, DEFAULT_SHOPPING_CATEGORIES);

/**
 * One list's category configuration (`config/categories`): the categories in
 * display order (`list`, the defaults when there is no document), the stored
 * spellings and whether the member's order is kept (`ordered`, S6).
 */
export function useLiveCategoryConfig(householdId: string | null | undefined, listId: string | null | undefined): LiveState<CategoryConfig> {
  const key = liveKey('categories', householdId, listId);
  return useLive(key, NO_CONFIG, (next, fail) => onSnapshot(
    doc(db, 'households', householdId as string, 'shopping-lists', listId as string, 'config', 'categories'),
    { includeMetadataChanges: true },
    (snapshot) => next(readCategoryConfig(snapshot.data(), snapshot.exists(), DEFAULT_SHOPPING_CATEGORIES), snapshot.metadata),
    fail,
  ));
}

const NO_STORES: ShoppingStore[] = [];

/** The household's stores (`stores/{storeId}`, S6: SH-34b), sorted by name. */
export function useLiveStores(householdId: string | null | undefined): LiveState<ShoppingStore[]> {
  const key = liveKey('stores', householdId);
  return useLive(key, NO_STORES, (next, fail) => onSnapshot(
    collection(db, 'households', householdId as string, 'stores'),
    { includeMetadataChanges: true },
    (snapshot) => next(
      docsToRecords<ShoppingStore>(snapshot.docs)
        .map((store) => ({ ...store, name: String(store.name ?? ''), aisleOrder: Array.isArray(store.aisleOrder) ? store.aisleOrder : [] }))
        .sort((a, b) => a.name.localeCompare(b.name)),
      snapshot.metadata,
    ),
    fail,
  ));
}

export type ShoppingPreferences = { defaultGroceryListId: string | null };
const NO_PREFERENCES: ShoppingPreferences = { defaultGroceryListId: null };

/**
 * The household's shopping preferences (`shopping-settings/preferences`): only
 * `defaultGroceryListId` is read here (the Grocery list the overview shows, S8a).
 * No document reads as no default.
 */
export function useLiveShoppingPreferences(householdId: string | null | undefined): LiveState<ShoppingPreferences> {
  const key = liveKey('shopping-preferences', householdId);
  return useLive(key, NO_PREFERENCES, (next, fail) => onSnapshot(
    doc(db, 'households', householdId as string, 'shopping-settings', 'preferences'),
    { includeMetadataChanges: true },
    (snapshot) => {
      const value = snapshot.get('defaultGroceryListId');
      next({ defaultGroceryListId: typeof value === 'string' && value ? value : null }, snapshot.metadata);
    },
    fail,
  ));
}

/** The household's pantry, ordered by name. */
export function useLivePantry(householdId: string | null | undefined): LiveState<PantryItem[]> {
  const key = liveKey('pantry', householdId);
  return useLive(key, NO_PANTRY, (next, fail) => onSnapshot(
    query(collection(db, 'households', householdId as string, 'pantry-inventory'), orderBy('name')),
    { includeMetadataChanges: true },
    (snapshot) => next(docsToRecords<PantryItem>(snapshot.docs), snapshot.metadata),
    fail,
  ));
}

export type ListCounts = { needed: number; purchased: number };

/** Two count queries (one read each per 1000 items): the server's needed and purchased counts. */
export async function countListItemsOnServer(householdId: string, listId: string): Promise<ListCounts> {
  const items = itemsCollection(householdId, listId);
  const [total, purchased] = await Promise.all([
    getCountFromServer(items),
    getCountFromServer(query(items, where('status', '==', 'purchased'))),
  ]);
  const bought = purchased.data().count;
  return { needed: Math.max(0, total.data().count - bought), purchased: bought };
}

/** The server's count of still-needed items (trip complete when 0). */
export async function countNeededOnServer(householdId: string, listId: string): Promise<number> {
  const snapshot = await getCountFromServer(query(itemsCollection(householdId, listId), where('status', '==', 'needed')));
  return snapshot.data().count;
}

/** The server's count of all items in a list (empty when 0). */
export async function countAllOnServer(householdId: string, listId: string): Promise<number> {
  const snapshot = await getCountFromServer(itemsCollection(householdId, listId));
  return snapshot.data().count;
}

/**
 * Card counts for the overview (SH-27b). The first `LIVE_COUNT_LIMIT` lists get
 * one items listener each while this hook is mounted; lists beyond that use two
 * count queries, refreshed when `refreshKey` changes, when the page is shown and
 * when another screen announces a shopping change. Counts are keyed by household
 * and list, so another household's numbers never show.
 */
export function useLiveListCounts(
  householdId: string | null | undefined,
  listIds: readonly string[],
  refreshKey = '',
): Record<string, ListCounts> {
  const { live, fallback } = planCountSources(listIds);
  const liveSignature = live.join('\n');
  const fallbackSignature = fallback.join('\n');
  const [counts, setCounts] = useState<Record<string, ListCounts>>({});

  useEffect(() => {
    if (!householdId || !liveSignature) return;
    const stops = liveSignature.split('\n').map((listId) => keepListening(({ healthy, failed }) => onSnapshot(
      itemsCollection(householdId, listId),
      (snapshot) => {
        healthy(snapshot.metadata.fromCache);
        const next = countItems(snapshot.docs.map((entry) => entry.data()));
        setCounts((previous) => ({ ...previous, [`${householdId}/${listId}`]: next }));
      },
      () => failed(),
    )));
    return () => stops.forEach((stop) => stop());
  }, [householdId, liveSignature]);

  useEffect(() => {
    if (!householdId || !fallbackSignature) return;
    let cancelled = false;
    const ids = fallbackSignature.split('\n');
    const refresh = () => {
      for (const listId of ids) {
        countListItemsOnServer(householdId, listId)
          .then((next) => {
            if (!cancelled) setCounts((previous) => ({ ...previous, [`${householdId}/${listId}`]: next }));
          })
          // Offline or denied: the card keeps its last count (or none).
          .catch(() => undefined);
      }
    };
    refresh();
    const onVisible = () => {
      if (!isHidden()) refresh();
    };
    document.addEventListener('visibilitychange', onVisible);
    const stopChanged = onDataChanged('shopping', householdId, refresh);
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisible);
      stopChanged();
    };
  }, [householdId, fallbackSignature, refreshKey]);

  if (!householdId) return {};
  const scoped: Record<string, ListCounts> = {};
  for (const listId of listIds) {
    const value = counts[`${householdId}/${listId}`];
    if (value) scoped[listId] = value;
  }
  return scoped;
}
