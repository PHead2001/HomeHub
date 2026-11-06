import { collection, doc, getDocs, increment, runTransaction } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { slugify } from '@/lib/utils';
import type { PantryItem } from '@/lib/types';
import { confirmedHandoffChoices, pantryMergeStillValid, planPantryHandoff, type PantryHandoffChoice } from './pantry';
import { isStillPurchased } from './items';

export type PantryHandoffResult = {
  /** Pantry entries written (incremented or created). */
  written: number;
  /** Shopping item ids deleted by "then clear". */
  cleared: string[];
  /** Names of chosen items that were no longer purchased, so not credited. */
  skipped: string[];
};

/**
 * Credits purchased shopping items to `households/{id}/pantry-inventory` in one
 * Firestore transaction, structured so every read happens before any write and a
 * retry recomputes everything from fresh reads:
 *
 * 1. Read every chosen shopping item and every item to clear.
 * 2. Keep only the choices confirmed still `purchased` (`confirmedHandoffChoices`),
 *    using their confirmed name and quantity, and plan the pantry writes from those.
 * 3. Read each planned merge target and re-check it (`pantryMergeStillValid`).
 * 4. Write: increment valid targets atomically, create the rest, and with
 *    `clearItemIds` delete exactly those items confirmed still purchased.
 *
 * So the pantry is credited only for purchases this transaction confirms: with
 * "then clear", every credited item is also deleted in the same commit, and a
 * second member doing the same at the same time finds the items gone and credits
 * nothing. Without clear the items stay purchased on the list, so the handoff can
 * be repeated on purpose; it still skips items no longer purchased.
 *
 * Merge candidates come from one pantry read made before the transaction (Firestore
 * web transactions cannot run queries); each is re-validated inside it. An entry
 * created by someone else after that read is not merged into, so a same-name entry
 * may be created instead (a harmless duplicate). Online only.
 */
export async function addPurchasesToPantry(
  householdId: string,
  listId: string,
  choices: readonly PantryHandoffChoice[],
  { clearItemIds = [] }: { clearItemIds?: readonly string[] } = {},
): Promise<PantryHandoffResult> {
  const pantry = collection(db, 'households', householdId, 'pantry-inventory');
  const itemRef = (id: string) => doc(db, 'households', householdId, 'shopping-lists', listId, 'items', id);
  const snapshot = await getDocs(pantry);
  const existing = snapshot.docs.map((pantryDoc) => ({ id: pantryDoc.id, ...pantryDoc.data() } as PantryItem));
  const readIds = [...new Set([...choices.map((choice) => choice.itemId), ...clearItemIds])];
  if (readIds.length === 0) return { written: 0, cleared: [], skipped: [] };

  const create = (name: string, quantity: number, location: PantryItem['location']) => ({
    ref: doc(pantry, slugify(name)),
    data: { name, quantity, unit: 'items', location, expiryDate: null },
  });

  return runTransaction(db, async (transaction) => {
    // --- Reads (all before any write; recomputed on every retry) ---
    const shopping = await Promise.all(readIds.map((id) => transaction.get(itemRef(id))));
    const confirmed = new Map(readIds.map((id, index) => [id, shopping[index].exists() ? shopping[index].data() : undefined]));
    const { credited, skipped } = confirmedHandoffChoices(choices, confirmed);
    const plans = planPantryHandoff(credited, existing);
    const increments = plans.filter((plan) => plan.kind === 'increment');
    const targets = await Promise.all(increments.map((plan) => transaction.get(doc(pantry, plan.id))));

    // --- Writes ---
    increments.forEach((plan, index) => {
      const read = targets[index];
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
    const cleared: string[] = [];
    for (const id of new Set(clearItemIds)) {
      if (isStillPurchased(confirmed.get(id))) {
        transaction.delete(itemRef(id));
        cleared.push(id);
      }
    }
    return { written: plans.length, cleared, skipped: skipped.map((choice) => choice.item.name) };
  });
}
