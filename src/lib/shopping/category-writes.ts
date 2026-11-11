/**
 * Firestore writes for list categories and stores (S6). The decisions live in
 * `./category-order.ts`; this file only turns them into writes:
 * - adding and removing categories are `arrayUnion` / `arrayRemove` updates of
 *   `ordered` (and of the older `list`, kept in step), so
 *   two members editing at once never overwrite each other (SH-10c), and they
 *   queue offline like any write;
 * - a reorder is a transaction that re-reads the order on the server and merges
 *   the one move into `ordered` (it needs a connection);
 * - a store is `households/{householdId}/stores/{storeId}` with `name`,
 *   `aisleOrder`, `createdByUid` and `updatedAt`; a list follows it through its
 *   `storeId` (null: the list's own order).
 * Callers classify every returned write with `trackWrite` (save-status.ts).
 */

import { arrayRemove, arrayUnion, collection, doc, runTransaction, serverTimestamp, setDoc, updateDoc, type FieldValue } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { DEFAULT_SHOPPING_CATEGORIES } from '@/lib/shopping-items';
import {
  planListReorder,
  planStoreReorder,
  type CategoryWritePlan,
  type MoveDirection,
} from './category-order';

const categoriesRef = (householdId: string, listId: string) =>
  doc(db, 'households', householdId, 'shopping-lists', listId, 'config', 'categories');
const listRef = (householdId: string, listId: string) => doc(db, 'households', householdId, 'shopping-lists', listId);
const storesCollection = (householdId: string) => collection(db, 'households', householdId, 'stores');

/** Writes an add or remove plan (never a whole list: each field is one arrayUnion or arrayRemove). */
export function writeCategoryPlan(householdId: string, listId: string, plan: CategoryWritePlan): Promise<void> {
  const ref = categoriesRef(householdId, listId);
  const data: Record<string, FieldValue> = {};
  if (plan.unionList?.length) data.list = arrayUnion(...plan.unionList);
  if (plan.removeList?.length) data.list = arrayRemove(...plan.removeList);
  if (plan.unionOrdered?.length) data.ordered = arrayUnion(...plan.unionOrdered);
  if (plan.removeOrdered?.length) data.ordered = arrayRemove(...plan.removeOrdered);
  // A remove needs the document; arrayUnion on a missing document creates it with exactly these values.
  if (plan.removeList?.length || plan.removeOrdered?.length) return updateDoc(ref, data);
  return setDoc(ref, data, { merge: true });
}

/** Moves a category one step in the list's own order. Resolves false when nothing moved. */
export function reorderListCategory(householdId: string, listId: string, category: string, direction: MoveDirection): Promise<boolean> {
  const ref = categoriesRef(householdId, listId);
  return runTransaction(db, async (transaction) => {
    const snapshot = await transaction.get(ref);
    const plan = planListReorder({ data: snapshot.data(), exists: snapshot.exists() }, DEFAULT_SHOPPING_CATEGORIES, category, direction);
    if (!plan) return false;
    transaction.set(ref, plan, { merge: true });
    return true;
  });
}

export class TooManyAislesError extends Error {
  constructor() {
    super('too-many-aisles');
    this.name = 'TooManyAislesError';
  }
}

/**
 * Moves a category one step in a store's aisle order (re-read in the
 * transaction). Aisles this list does not use keep their places. Resolves false
 * when nothing moved or the store is gone.
 */
export function reorderStoreAisle(
  householdId: string,
  storeId: string,
  listOrder: readonly string[],
  category: string,
  direction: MoveDirection,
): Promise<boolean> {
  const ref = doc(storesCollection(householdId), storeId);
  return runTransaction(db, async (transaction) => {
    const snapshot = await transaction.get(ref);
    if (!snapshot.exists()) return false;
    const stored = snapshot.data().aisleOrder;
    const next = planStoreReorder(Array.isArray(stored) ? stored : [], listOrder, category, direction);
    if (next === 'too-many') throw new TooManyAislesError();
    if (!next) return false;
    transaction.update(ref, { aisleOrder: next, updatedAt: serverTimestamp() });
    return true;
  });
}

/**
 * Creates a store with a first aisle order and points the list at it. Two queued
 * writes in order (the store, then the list's `storeId`), so the list never
 * names a store the server has not accepted first.
 */
export function createStoreForList(
  householdId: string,
  listId: string,
  { name, aisleOrder, uid }: { name: string; aisleOrder: string[]; uid: string },
): { storeId: string; write: Promise<void> } {
  const ref = doc(storesCollection(householdId));
  const created = setDoc(ref, { name, aisleOrder, createdByUid: uid, updatedAt: serverTimestamp() });
  const assigned = assignListStore(householdId, listId, ref.id);
  return { storeId: ref.id, write: Promise.all([created, assigned]).then(() => undefined) };
}

/** Points a list at a store, or back to its own order (null). */
export function assignListStore(householdId: string, listId: string, storeId: string | null): Promise<void> {
  return updateDoc(listRef(householdId, listId), { storeId });
}
