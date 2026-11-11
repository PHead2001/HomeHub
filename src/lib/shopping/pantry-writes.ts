import { collection, doc, getDocs, increment, runTransaction, serverTimestamp } from 'firebase/firestore';
import { auth, db } from '@/lib/firebase';
import { slugify } from '@/lib/utils';
import type { PantryItem } from '@/lib/types';
import { confirmedHandoffChoices, pantryMergeStillValid, planPantryHandoff, type PantryHandoffChoice } from './pantry';
import { isStillPurchased } from './items';
import { fillBatch, pantryBatchFields, planLegacyUpgrade, readPantryBatch, splitPackages } from './pantry-batches';

/**
 * The most documents one handoff writes (Firestore allows 500 per transaction,
 * and the clear's deletes count too). A handoff above it is refused before
 * anything is written, so nothing is cleared.
 */
export const MAX_HANDOFF_WRITES = 450;

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
 * Pantry v2: a purchase is a batch counted in `items` (packages = quantity bought,
 * no package size, no expiry). A v2 target grows by `increment()` on both
 * `packages` and the dual-written `quantity`; a legacy target (no `packages` yet)
 * is upgraded with absolute values computed from this transaction's own read
 * (`planLegacyUpgrade`; `fillBatch` keeps its total within 10,000, so nothing splits).
 * A batch holds at most 10,000 packages (the rules' limit), so a larger amount is
 * never clamped: what fits goes to the merge target (`fillBatch`) and the rest,
 * or a new purchase above 10,000, is split across new batches of at most 10,000
 * (`splitPackages`). Every purchased package is stored before any shopping item
 * is cleared; a handoff needing more than `MAX_HANDOFF_WRITES` writes is refused
 * with a message and writes and clears nothing.
 * New batches carry `addedByUid`/`updatedByUid` (the signed-in member) and
 * `updatedAt` (server time).
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

  // Every v2 write carries the writer and server time (the rules check the resulting batch).
  const uid = auth.currentUser?.uid;
  if (!uid) throw new Error('Sign in to add to the pantry.');
  const stamp = () => ({ updatedByUid: uid, updatedAt: serverTimestamp() });
  const create = (name: string, quantity: number, location: PantryItem['location']) => ({
    ref: doc(pantry, slugify(name)),
    data: {
      ...pantryBatchFields({ name, location, unit: 'items', packages: quantity, packageSize: null, expiryDate: null }),
      addedByUid: uid,
      ...stamp(),
    },
  });

  return runTransaction(db, async (transaction) => {
    // --- Reads (all before any write; recomputed on every retry) ---
    const shopping = await Promise.all(readIds.map((id) => transaction.get(itemRef(id))));
    const confirmed = new Map(readIds.map((id, index) => [id, shopping[index].exists() ? shopping[index].data() : undefined]));
    const { credited, skipped } = confirmedHandoffChoices(choices, confirmed);
    const plans = planPantryHandoff(credited, existing);
    const increments = plans.filter((plan) => plan.kind === 'increment');
    const targets = await Promise.all(increments.map((plan) => transaction.get(doc(pantry, plan.id))));

    // --- Plan every write from those reads (no batch above MAX_PACKAGES, nothing dropped) ---
    // Each entry is one document write, applied only after the size check below.
    const writes: Array<() => void> = [];
    const createOne = (name: string, packages: number, location: PantryItem['location']) => writes.push(() => {
      const fresh = create(name, packages, location);
      transaction.set(fresh.ref, fresh.data);
    });
    const createAll = (name: string, total: number, location: PantryItem['location']) => {
      for (const packages of splitPackages(total)) createOne(name, packages, location);
    };
    increments.forEach((plan, index) => {
      const read = targets[index];
      const data = read.exists() ? read.data() : undefined;
      if (!pantryMergeStillValid(data, plan, plan.location)) {
        createAll(plan.name, plan.add, plan.location);
        return;
      }
      const batch = readPantryBatch(read.id, data);
      const { toTarget, newBatches } = fillBatch(plan.add, batch.packages);
      if (toTarget > 0) {
        writes.push(() => transaction.update(read.ref, batch.legacy
          ? { ...planLegacyUpgrade(batch, toTarget).fields, ...stamp() }
          : { packages: increment(toTarget), quantity: increment(toTarget), ...stamp() }));
      }
      for (const packages of newBatches) createOne(plan.name, packages, plan.location);
    });
    for (const plan of plans) {
      if (plan.kind === 'create') createAll(plan.name, plan.quantity, plan.location);
    }
    const clearIds = [...new Set(clearItemIds)].filter((id) => isStillPurchased(confirmed.get(id)));
    if (writes.length + clearIds.length > MAX_HANDOFF_WRITES) {
      // Thrown before any write is applied: the transaction commits nothing and clears nothing.
      throw new Error('That is too much to add to the pantry at once. Add the purchases in smaller groups; nothing was added or cleared.');
    }

    // --- Writes ---
    for (const write of writes) write();
    const cleared: string[] = [];
    for (const id of clearIds) {
      transaction.delete(itemRef(id));
      cleared.push(id);
    }
    return { written: plans.length, cleared, skipped: skipped.map((choice) => choice.item.name) };
  });
}
