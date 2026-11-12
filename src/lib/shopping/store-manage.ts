/**
 * Renaming and deleting a store (S6 follow-up to SH-34b), and the Undo of a
 * delete. The decisions live here, free of Firebase and UI, so they are unit
 * tested under Node (tests/unit/shopping-store-manage.test.ts); the writes are
 * in `./store-writes.ts`.
 *
 * What the deployed rules accept (`stores/{storeId}` in firestore.rules):
 * - an update with `shopping.edit` may change `name` (1 to 120 characters) and
 *   `aisleOrder`, must stamp `updatedAt` with the server time, and never
 *   changes `createdByUid`;
 * - a delete needs `shopping.delete`;
 * - a create (the Undo re-creates the same id) needs `shopping.edit`, and its
 *   `createdByUid` must be the writer, so a store restored by someone other
 *   than its creator is restored as the restorer's.
 * Lists point at a store through `storeId`; clearing it is a list update
 * (`shopping.edit`).
 */

import { MAX_STORE_AISLES, MAX_STORE_NAME, categoryKey, cleanCategoryName } from './category-order';

/** The rules' bound on a store name (the app keeps new names to `MAX_STORE_NAME`). */
export const RULES_STORE_NAME_MAX = 120;
/** The rules' bound on one aisle entry. */
export const MAX_AISLE_NAME = 100;

export type StoreRenameCheck =
  | { ok: true; name: string; unchanged: boolean }
  | { ok: false; error: string };

/**
 * A new name for `storeId`: required, at most `MAX_STORE_NAME` characters (as
 * for a new store), and not the name of another store (case and spacing
 * ignored). The store's own name in another case is a rename; exactly the same
 * name is `unchanged` (nothing to write).
 */
export function checkStoreRename(
  input: string,
  storeId: string,
  stores: readonly { id: string; name: string }[],
): StoreRenameCheck {
  const name = cleanCategoryName(input);
  if (!name) return { ok: false, error: 'Give the store a name.' };
  if (name.length > MAX_STORE_NAME) return { ok: false, error: `Keep the name under ${MAX_STORE_NAME} characters.` };
  const other = stores.find((store) => store.id !== storeId && categoryKey(store.name ?? '') === categoryKey(name));
  if (other) return { ok: false, error: `You already have a store called ${other.name}. Pick another name.` };
  const current = stores.find((store) => store.id === storeId);
  return { ok: true, name, unchanged: current?.name === name };
}

/** The ids of the lists (as the listener shows them) that follow `storeId`. */
export function listsUsingStore(storeId: string, lists: readonly { id: string; storeId?: unknown }[]): string[] {
  return lists.filter((list) => list.storeId === storeId).map((list) => list.id);
}

/** The confirmation's text: the store by name and how many lists use it. */
export function deleteStoreQuestion(storeName: string, listCount: number): { title: string; body: string } {
  const title = `Delete ${storeName}?`;
  const lists = listCount === 1 ? '1 list uses it' : `${listCount} lists use it`;
  const body = listCount === 0
    ? `No list uses it now. Its aisle order is deleted for everyone in the household.`
    : `${lists}. ${listCount === 1 ? 'It goes' : 'They go'} back to ${listCount === 1 ? 'its' : 'their'} own category order, and the store's aisle order is deleted for everyone in the household.`;
  return { title, body };
}

/** Why a store write ran but declined (said to the member, never "saved"). */
export type StoreDeclineReason = 'gone' | 'exists' | 'name-taken';

export class StoreChangeDeclined extends Error {
  readonly reason: StoreDeclineReason;
  readonly storeName: string;
  constructor(reason: StoreDeclineReason, storeName: string) {
    super(`store-change-declined:${reason}`);
    this.name = 'StoreChangeDeclined';
    this.reason = reason;
    this.storeName = storeName;
  }
}

export function storeDeclinedMessage(reason: StoreDeclineReason, storeName: string): string {
  switch (reason) {
    case 'gone': return `${storeName} was already deleted on another device.`;
    case 'exists': return `${storeName} is back already: nothing to undo.`;
    case 'name-taken': return `A store called ${storeName} was added meanwhile, so the deleted one was not restored.`;
  }
}

/** A list as the delete or restore transaction read it from the server. */
export type ListRead = { id: string; exists: boolean; storeId?: unknown };

/** What a delete removed, kept for its Undo. */
export type StoreRestore = {
  storeId: string;
  name: string;
  aisleOrder: string[];
  /** The store's creator before the delete (absent on stores without one). */
  createdByUid: string | null;
  /** The lists whose `storeId` the delete cleared. */
  listIds: string[];
};

export type StoreDeletePlan =
  | { kind: 'declined'; reason: 'gone' }
  | { kind: 'delete'; clearListIds: string[]; restore: StoreRestore };

/** A stored name the rules would accept again on a create. */
function restorableName(value: unknown, fallback: string): string {
  const name = typeof value === 'string' ? cleanCategoryName(value).slice(0, RULES_STORE_NAME_MAX) : '';
  return name || fallback;
}

/** A stored aisle order the rules would accept again (strings, each bounded, at most 200). */
function restorableAisles(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0 && entry.length <= MAX_AISLE_NAME)
    .slice(0, MAX_STORE_AISLES);
}

/**
 * The delete, decided on what the transaction read: the store (absent:
 * already deleted, declined) and each list the listener showed at the store.
 * Only lists that still exist and still name this store are cleared; a list
 * someone moved elsewhere meanwhile is left alone, and one moved to the store
 * meanwhile but not yet on this screen keeps the dangling id (it falls back
 * to its own order, `assignedStore` state `missing`).
 */
export function planStoreDelete({
  storeId,
  store,
  lists,
  fallbackName,
}: {
  storeId: string;
  store: { exists: boolean; data?: Record<string, unknown> };
  lists: readonly ListRead[];
  /** The name on screen, used only when the stored one is unusable. */
  fallbackName: string;
}): StoreDeletePlan {
  if (!store.exists) return { kind: 'declined', reason: 'gone' };
  const clearListIds = lists.filter((list) => list.exists && list.storeId === storeId).map((list) => list.id);
  const data = store.data ?? {};
  return {
    kind: 'delete',
    clearListIds,
    restore: {
      storeId,
      name: restorableName(data.name, restorableName(fallbackName, 'Store')),
      aisleOrder: restorableAisles(data.aisleOrder),
      createdByUid: typeof data.createdByUid === 'string' && data.createdByUid ? data.createdByUid : null,
      listIds: clearListIds,
    },
  };
}

export type StoreRestorePlan =
  | { kind: 'declined'; reason: 'exists' | 'name-taken' }
  | {
    kind: 'restore';
    /** The store document to create (with `updatedAt` added by the write). */
    store: { name: string; aisleOrder: string[]; createdByUid: string };
    /** The lists to point at the store again. */
    listIds: string[];
    /** The restorer is not the creator, so the rules make the restored store theirs. */
    restoredAsYours: boolean;
  };

/**
 * The Undo, decided on what its transaction read. The store id must be free
 * (otherwise it is back already), no other store may have taken the name, and
 * the creator is the restorer (the rules' create condition). A list is pointed
 * back only while it still exists and names no store; a list someone assigned
 * to another store meanwhile keeps that store.
 */
export function planStoreRestore({
  restore,
  uid,
  storeExists,
  lists,
  stores,
}: {
  restore: StoreRestore;
  uid: string;
  storeExists: boolean;
  lists: readonly ListRead[];
  /** The household's stores as read from the server when the Undo runs (never the screen's copy). */
  stores: readonly { id: string; name: string }[];
}): StoreRestorePlan {
  if (storeExists) return { kind: 'declined', reason: 'exists' };
  if (stores.some((store) => store.id !== restore.storeId && categoryKey(store.name ?? '') === categoryKey(restore.name))) {
    return { kind: 'declined', reason: 'name-taken' };
  }
  const wanted = new Set(restore.listIds);
  const listIds = lists
    .filter((list) => wanted.has(list.id) && list.exists && (list.storeId === null || list.storeId === undefined || list.storeId === ''))
    .map((list) => list.id);
  return {
    kind: 'restore',
    store: { name: restore.name, aisleOrder: restore.aisleOrder, createdByUid: uid },
    listIds,
    restoredAsYours: restore.createdByUid !== uid,
  };
}

/** The status subject after a rename: it names both, so it reads right whichever store is selected by then. */
export function storeRenamedSubject(from: string, to: string): string {
  return `${from} renamed to ${to}`;
}

/**
 * Whether a late outcome of a write submitted for `submittedFor` may touch the
 * controls now showing `current` (give back a rejected draft): only while the
 * same store is still the one selected.
 */
export function outcomeAppliesTo(submittedFor: string, current: string | null): boolean {
  return current === submittedFor;
}

/** The status subject after a delete. */
export function storeDeletedSubject(storeName: string, listCount: number): string {
  if (listCount === 0) return `${storeName} deleted`;
  return `${storeName} deleted, ${listCount === 1 ? '1 list' : `${listCount} lists`} back to ${listCount === 1 ? 'its' : 'their'} own order`;
}

/** The status subject after an Undo. */
export function storeRestoredSubject(storeName: string, restoredAsYours: boolean): string {
  return restoredAsYours ? `${storeName} restored (now listed as created by you)` : `${storeName} restored`;
}

/** Remaining Undo time for a delete confirmed at `at`. */
export function undoRemaining(at: number, now: number, windowMs: number): number {
  return Math.max(0, at + windowMs - now);
}
