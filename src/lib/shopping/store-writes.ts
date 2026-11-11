/**
 * Firestore writes for renaming and deleting a store, and the delete's Undo.
 * The decisions are in `./store-manage.ts` (pure); this file only reads and
 * writes. Callers classify every returned write with `trackWrite`.
 */

import { doc, runTransaction, serverTimestamp, updateDoc } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { StoreChangeDeclined, planStoreDelete, planStoreRestore, type StoreRestore } from './store-manage';

const storeRef = (householdId: string, storeId: string) => doc(db, 'households', householdId, 'stores', storeId);
const listRef = (householdId: string, listId: string) => doc(db, 'households', householdId, 'shopping-lists', listId);

/**
 * Renames a store: `name` and the server's `updatedAt`, nothing else (the
 * rules' update shape). An update, so renaming a store deleted meanwhile is
 * refused instead of re-creating it. Queued offline like any write.
 */
export function renameStore(householdId: string, storeId: string, name: string): Promise<void> {
  return updateDoc(storeRef(householdId, storeId), { name, updatedAt: serverTimestamp() });
}

/**
 * Deletes a store and clears `storeId` on the lists that still follow it, in
 * one transaction (needs a connection): it re-reads the store and each list
 * the caller saw at the store, so a list moved elsewhere meanwhile is left
 * alone. Resolves with what its Undo needs; rejects with
 * `StoreChangeDeclined('gone')` when the store was already deleted.
 */
export function deleteStoreAndUnassign(
  householdId: string,
  storeId: string,
  { listIds, name }: { listIds: readonly string[]; name: string },
): Promise<StoreRestore> {
  return runTransaction(db, async (transaction) => {
    const store = await transaction.get(storeRef(householdId, storeId));
    const lists = await Promise.all(listIds.map(async (id) => {
      const snapshot = await transaction.get(listRef(householdId, id));
      return { id, exists: snapshot.exists(), storeId: snapshot.data()?.storeId };
    }));
    const plan = planStoreDelete({ storeId, store: { exists: store.exists(), data: store.data() }, lists, fallbackName: name });
    if (plan.kind === 'declined') throw new StoreChangeDeclined('gone', name);
    for (const id of plan.clearListIds) transaction.update(listRef(householdId, id), { storeId: null });
    transaction.delete(storeRef(householdId, storeId));
    return plan.restore;
  });
}

/**
 * The delete's Undo: re-creates the store with the same id (its name and aisle
 * order, the restorer as `createdByUid`, as the rules require on a create) and
 * points the lists it cleared back at it, in one transaction (needs a
 * connection). Resolves with whether the store is now listed as the
 * restorer's; rejects with `StoreChangeDeclined` when the store is back
 * already or its name was taken meanwhile.
 */
export function restoreDeletedStore(
  householdId: string,
  restore: StoreRestore,
  { uid, stores }: { uid: string; stores: readonly { id: string; name: string }[] },
): Promise<{ restoredAsYours: boolean }> {
  return runTransaction(db, async (transaction) => {
    const store = await transaction.get(storeRef(householdId, restore.storeId));
    const lists = await Promise.all(restore.listIds.map(async (id) => {
      const snapshot = await transaction.get(listRef(householdId, id));
      return { id, exists: snapshot.exists(), storeId: snapshot.data()?.storeId };
    }));
    const plan = planStoreRestore({ restore, uid, storeExists: store.exists(), lists, stores });
    if (plan.kind === 'declined') throw new StoreChangeDeclined(plan.reason, restore.name);
    transaction.set(storeRef(householdId, restore.storeId), { ...plan.store, updatedAt: serverTimestamp() });
    for (const id of plan.listIds) transaction.update(listRef(householdId, id), { storeId: restore.storeId });
    return { restoredAsYours: plan.restoredAsYours };
  });
}
