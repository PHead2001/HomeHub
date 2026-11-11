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
  CategoryChangeDeclined,
  planListReorder,
  seededChangeOutcome,
  type CategoryChange,
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

/**
 * The first add or remove that introduces `ordered` (or the document), or an add
 * that must compact a full `ordered`, online: a transaction that re-reads the
 * document and writes `list` and `ordered` from what is stored then. Resolves
 * when written, or when it was already so (someone else made the same change);
 * rejects with `CategoryChangeDeclined` when the list is full or the change no
 * longer applies, so the save path reports it (never "saved").
 */
export function writeSeededCategoryChange(householdId: string, listId: string, change: CategoryChange): Promise<void> {
  const ref = categoriesRef(householdId, listId);
  return runTransaction(db, async (transaction) => {
    const snapshot = await transaction.get(ref);
    const outcome = seededChangeOutcome({ data: snapshot.data(), exists: snapshot.exists() }, DEFAULT_SHOPPING_CATEGORIES, change);
    if (outcome.kind === 'declined') throw new CategoryChangeDeclined(outcome.reason);
    if (outcome.kind === 'write') transaction.set(ref, outcome.plan, { merge: true });
  });
}

/**
 * Moves a category one step in the list's own order. Rejects with
 * `CategoryChangeDeclined('stale')` when it cannot move any more (gone, or
 * already at that end after someone else's change).
 */
export function reorderListCategory(householdId: string, listId: string, category: string, direction: MoveDirection): Promise<void> {
  const ref = categoriesRef(householdId, listId);
  return runTransaction(db, async (transaction) => {
    const snapshot = await transaction.get(ref);
    const plan = planListReorder({ data: snapshot.data(), exists: snapshot.exists() }, DEFAULT_SHOPPING_CATEGORIES, category, direction);
    if (!plan) throw new CategoryChangeDeclined('stale');
    transaction.set(ref, plan, { merge: true });
  });
}

/**
 * Moves a category one step in a store's aisle order (re-read in the
 * transaction). Aisles this list does not use keep their places. Rejects with
 * `CategoryChangeDeclined`: 'stale' when the store is gone or the category cannot
 * move any more, 'store-full' above 200 aisles.
 */
export function reorderStoreAisle(
  householdId: string,
  storeId: string,
  listOrder: readonly string[],
  category: string,
  direction: MoveDirection,
): Promise<void> {
  const ref = doc(storesCollection(householdId), storeId);
  return runTransaction(db, async (transaction) => {
    const snapshot = await transaction.get(ref);
    if (!snapshot.exists()) throw new CategoryChangeDeclined('stale');
    const stored = snapshot.data().aisleOrder;
    const next = planStoreReorder(Array.isArray(stored) ? stored : [], listOrder, category, direction);
    if (next === 'too-many') throw new CategoryChangeDeclined('store-full');
    if (!next) throw new CategoryChangeDeclined('stale');
    transaction.update(ref, { aisleOrder: next, updatedAt: serverTimestamp() });
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
