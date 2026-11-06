import { collection, doc, getDocs, increment, runTransaction } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { slugify } from '@/lib/utils';
import type { PantryItem } from '@/lib/types';
import { pantryMergeStillValid, planPantryHandoff, type PantryHandoffChoice } from './pantry';
import { isStillPurchased } from './items';

/**
 * Writes purchased items into `households/{id}/pantry-inventory` in one Firestore
 * transaction. Merge targets are planned from a fresh read, then re-read inside the
 * transaction: an entry that still exists on the same shelf, counted in `items`,
 * with the same name grows by an atomic `increment()`; if another member deleted,
 * moved or re-unitted it meanwhile, the purchase becomes a new entry instead.
 * New entries get the fields the pantry form writes (`name`, `quantity`,
 * `unit: 'items'`, `location`, `expiryDate: null`). Online only: the caller hides
 * the action offline.
 *
 * With `clear`, the same transaction also deletes those shopping items (of
 * `clear.itemIds`) that are still purchased, so "Add to pantry, then clear" is
 * all-or-nothing: a failure leaves both the pantry and the list unchanged, and a
 * retry can never add to the pantry twice. Resolves with the number of pantry
 * entries written and the shopping item ids deleted.
 */
export async function addPurchasesToPantry(
  householdId: string,
  choices: readonly PantryHandoffChoice[],
  clear?: { listId: string; itemIds: readonly string[] },
): Promise<{ written: number; cleared: string[] }> {
  const pantry = collection(db, 'households', householdId, 'pantry-inventory');
  const snapshot = await getDocs(pantry);
  const existing = snapshot.docs.map((pantryDoc) => ({ id: pantryDoc.id, ...pantryDoc.data() } as PantryItem));
  const plans = planPantryHandoff(choices, existing);
  if (plans.length === 0 && !clear?.itemIds.length) return { written: 0, cleared: [] };
  const clearRefs = (clear?.itemIds ?? []).map((id) => doc(db, 'households', householdId, 'shopping-lists', clear!.listId, 'items', id));

  const create = (name: string, quantity: number, location: PantryItem['location']) => ({
    ref: doc(pantry, slugify(name)),
    data: { name, quantity, unit: 'items', location, expiryDate: null },
  });

  const cleared = await runTransaction(db, async (transaction) => {
    // Every read happens before any write.
    const increments = plans.filter((plan) => plan.kind === 'increment');
    const current = await Promise.all(increments.map((plan) => transaction.get(doc(pantry, plan.id))));
    const shopping = await Promise.all(clearRefs.map((ref) => transaction.get(ref)));
    increments.forEach((plan, index) => {
      const read = current[index];
      if (pantryMergeStillValid(read.exists() ? read.data() : undefined, plan, plan.location)) {
        transaction.update(read.ref, { quantity: increment(plan.add) });
      } else {
        const fresh = create(plan.name, plan.add, plan.location);
        transaction.set(fresh.ref, fresh.data);
      }
    });
    for (const plan of plans) {
      if (plan.kind !== 'create') continue;
      const fresh = create(plan.name, plan.quantity, plan.location);
      transaction.set(fresh.ref, fresh.data);
    }
    const deleted: string[] = [];
    shopping.forEach((snapshot, index) => {
      if (snapshot.exists() && isStillPurchased(snapshot.data())) {
        transaction.delete(clearRefs[index]);
        deleted.push(clear!.itemIds[index]);
      }
    });
    return deleted;
  });
  return { written: plans.length, cleared };
}
