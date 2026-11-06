import { doc, runTransaction, type DocumentReference } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { quantityIncrement } from './item-writes';
import { canMergeInto, isStillPurchased } from './items';

/**
 * Online only (transactions need the server). The list on screen comes from
 * one-time reads, so an item's status there can be stale: another member may have
 * bought or deleted it since. These helpers re-read the documents inside a
 * transaction and act on the confirmed status, never on the cached one.
 */

/**
 * Raises a still-needed item's quantity by `add`. Resolves false (and writes
 * nothing) when the item is gone or no longer needed, so the caller creates a new
 * needed item instead of folding the addition into one that was already bought.
 */
export function mergeIntoNeededItem(itemRef: DocumentReference, add: number): Promise<boolean> {
  return runTransaction(db, async (transaction) => {
    const snapshot = await transaction.get(itemRef);
    if (!canMergeInto(snapshot.exists() ? snapshot.data() : undefined)) return false;
    transaction.update(itemRef, quantityIncrement(add));
    return true;
  });
}

/**
 * Deletes those of `itemIds` that are still purchased on the server and resolves
 * with the ids actually deleted. An item another member un-ticked (or deleted)
 * since this device last read the list is left alone.
 */
export function deleteStillPurchasedItems(householdId: string, listId: string, itemIds: readonly string[]): Promise<string[]> {
  return runTransaction(db, async (transaction) => {
    const refs = itemIds.map((id) => doc(db, 'households', householdId, 'shopping-lists', listId, 'items', id));
    const snapshots = await Promise.all(refs.map((ref) => transaction.get(ref)));
    const deleted: string[] = [];
    snapshots.forEach((snapshot, index) => {
      if (snapshot.exists() && isStillPurchased(snapshot.data())) {
        transaction.delete(refs[index]);
        deleted.push(itemIds[index]);
      }
    });
    return deleted;
  });
}
