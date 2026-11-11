/**
 * Pantry v2 writes from the Inventory tab (audit 17.3, SH-22, SH-29, SH-6). The
 * shapes come from the pure helpers in `./pantry-batches`; this file only adds
 * Firestore increments, attribution (`addedByUid` on create, `updatedByUid` on
 * every write) and server time (`updatedAt`).
 *
 * Package changes on a v2 batch are `increment()`s (they queue offline and two
 * members' taps add up); the rules keep `packages` between 0 and 10000, so a
 * second "used one" on a batch someone else just emptied is refused and rolled
 * back by the listener. A batch still in the legacy shape has no `packages` to
 * increment, so its first change needs absolute values: those are computed only
 * online, inside a transaction that re-reads the document (`planLegacyUpgrade`),
 * and refused offline (`packageChangeRoute`); the migration,
 * scripts/ops/migrate-pantry-v2.mjs, removes this case.
 */
import {
  collection, deleteDoc, doc, getDocs, increment, query, runTransaction, serverTimestamp, setDoc, updateDoc, where, writeBatch,
} from 'firebase/firestore';
import { categorizeGroceryItem } from '@/ai/flows/categorize-grocery-item-flow';
import { getAiActionContext, unwrapAiActionResult } from '@/ai/client';
import { db } from '@/lib/firebase';
import { notifyDataChanged } from '@/lib/data-changed';
import { awaitWriteUnlessOffline, getDocOfflineAware, getDocsOfflineAware, isBrowserOffline } from '@/lib/firestore-offline';
import { resolveShoppingCategory } from '@/lib/shopping-categorization';
import { DEFAULT_SHOPPING_CATEGORIES, buildShoppingListItem, normalizeStoredCategories } from '@/lib/shopping-items';
import type { PantryItemLocation, ShoppingList, ShoppingListItem } from '@/lib/types';
import { slugify } from '@/lib/utils';
import { findMergeTarget } from './items';
import { mergeIntoNeededItem } from './item-transactions';
import {
  BATCH_GONE_MESSAGE, PantryChangeRefused, decidePantryMerge, isCountUnit, packageChangeRoute, pantryBatchFields, planLegacyUpgrade,
  planMergeAdd, readPantryBatch, shoppingWriteNotice, shouldDeleteEmptyBatch, undoFits,
  type PantryBatch, type PantryBatchInput,
} from './pantry-batches';

const pantryCollection = (householdId: string) => collection(db, 'households', householdId, 'pantry-inventory');
const touched = (uid: string) => ({ updatedByUid: uid, updatedAt: serverTimestamp() });

/** The increment that changes a v2 batch's package count by `delta` (negative to use, positive to add or undo). */
export function packageChange(batch: Pick<PantryBatch, 'unit'>, delta: number, uid: string) {
  // Counted units dual-write quantity = packages; measured ones keep quantity = package size.
  return isCountUnit(batch.unit)
    ? { packages: increment(delta), quantity: increment(delta), ...touched(uid) }
    : { packages: increment(delta), ...touched(uid) };
}

export type PackageChangeResult = {
  outcome: 'saved' | 'queued';
  /** Undo (`increment(-delta)` on each document) still fits the rules' 10,000 per batch. */
  undoable: boolean;
};

/**
 * Changes several batches' packages together ("used one", "One more", "Out of
 * this" across a product's batches, and its Undo): either every change commits
 * or none does, so a refused write never leaves part of a product used up with
 * no Undo. Each batch is routed by `packageChangeRoute`:
 * - all v2: ONE write batch of increments (queued as one unit offline);
 * - any legacy, online: ONE transaction that re-reads every document and writes
 *   increments for those now v2 and `planLegacyUpgrade` values (plus split-off
 *   batches above 10,000) for those still legacy, so two devices' taps both
 *   count and nothing on screen overwrites newer stock;
 * - any legacy offline, or any batch that needs repair: refused with a
 *   `PantryChangeRefused` before anything is written.
 */
export async function changePackagesTogether(
  householdId: string,
  changes: readonly { batch: PantryBatch; delta: number }[],
  uid: string,
  onLateError: (error: unknown) => void,
  timeZone?: string | null,
): Promise<PackageChangeResult> {
  const pantry = pantryCollection(householdId);
  const offline = isBrowserOffline();
  const routes = changes.map(({ batch }) => packageChangeRoute(batch, offline));
  const refused = routes.find((route) => route.kind === 'refuse');
  if (refused?.kind === 'refuse') throw new PantryChangeRefused(refused.message);
  if (routes.every((route) => route.kind === 'increment')) {
    const batch = writeBatch(db);
    for (const { batch: entry, delta } of changes) batch.update(doc(pantry, entry.id), packageChange(entry, delta, uid));
    return { outcome: await awaitWriteUnlessOffline(batch.commit(), onLateError), undoable: true };
  }
  const undoable = await runTransaction(db, async (transaction) => {
    const refs = changes.map(({ batch }) => doc(pantry, batch.id));
    const snapshots = await Promise.all(refs.map((ref) => transaction.get(ref)));
    let fits = true;
    // Every read happens before any write; a retry recomputes from fresh reads.
    const writes = snapshots.map((snapshot, index) => {
      if (!snapshot.exists()) throw new PantryChangeRefused(BATCH_GONE_MESSAGE);
      const stored = readPantryBatch(snapshot.id, snapshot.data(), timeZone);
      const { delta } = changes[index];
      if (!stored.legacy && !stored.needsRepair) return () => transaction.update(refs[index], packageChange(stored, delta, uid));
      const plan = planLegacyUpgrade(stored, delta);
      fits &&= undoFits(plan.fields.packages, delta);
      return () => {
        transaction.update(refs[index], { ...plan.fields, ...touched(uid) });
        for (const extra of plan.newBatches) transaction.set(doc(pantry, slugify(extra.name)), { ...extra, addedByUid: uid, ...touched(uid) });
      };
    });
    for (const write of writes) write();
    return fits;
  });
  return { outcome: 'saved', undoable };
}

export type SaveBatchResult = {
  outcome: 'saved' | 'queued';
  /** The packages were added to the matched batch; false when a new batch was created. */
  merged: boolean;
};

const isUnavailable = (error: unknown) =>
  typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'unavailable';

/**
 * Saves the add/edit form. Editing writes the batch by id. Adding with a merge
 * target (`mergeInto`, found by the caller with `findPantryMergeTarget` from what
 * is on screen) re-reads that batch in a transaction and adds the packages only
 * while its merge key (name, shelf, package size, unit, expiry) still matches
 * (`decidePantryMerge`); otherwise, offline, or when the server cannot be reached
 * to verify it, a separate batch is created instead. A merge never takes the
 * target above 10,000 packages (the rules' limit): the combined count is checked
 * in the transaction and the overflow goes to new batches (`planMergeAdd`).
 */
export async function saveBatch(
  householdId: string,
  input: PantryBatchInput,
  uid: string,
  { editId, mergeInto, timeZone }: { editId?: string; mergeInto?: PantryBatch; timeZone?: string | null } = {},
  onLateError: (error: unknown) => void = () => undefined,
): Promise<SaveBatchResult> {
  const pantry = pantryCollection(householdId);
  const fields = pantryBatchFields(input);
  const created = () => ({ ...fields, addedByUid: uid, ...touched(uid) });
  if (editId) {
    return { outcome: await awaitWriteUnlessOffline(updateDoc(doc(pantry, editId), { ...fields, ...touched(uid) }), onLateError), merged: false };
  }
  if (mergeInto && !isBrowserOffline()) {
    const ref = doc(pantry, mergeInto.id);
    try {
      const merged = await runTransaction(db, async (transaction) => {
        const snapshot = await transaction.get(ref);
        const decision = decidePantryMerge({
          offline: false, targetId: mergeInto.id, stored: snapshot.exists() ? snapshot.data() : null, incoming: fields, timeZone,
        });
        if (decision.kind === 'merge') {
          // The rules cap a batch at 10,000: fill the target up to that and put
          // the rest in new batches, so a nearly full target never refuses the add.
          const plan = planMergeAdd(decision.target.packages, input);
          if (plan.toTarget > 0 && decision.target.legacy) {
            // A legacy target is upgraded from this transaction's own read (its count fits: planMergeAdd).
            transaction.update(ref, { ...planLegacyUpgrade(decision.target, plan.toTarget).fields, ...touched(uid) });
          } else if (plan.toTarget > 0) {
            transaction.update(ref, packageChange(decision.target, plan.toTarget, uid));
          }
          for (const extra of plan.newBatches) {
            transaction.set(doc(pantry, slugify(extra.name)), { ...extra, addedByUid: uid, ...touched(uid) });
          }
          return plan.toTarget > 0 || plan.newBatches.length === 0;
        }
        transaction.set(doc(pantry, slugify(fields.name)), created());
        return false;
      });
      return { outcome: 'saved', merged };
    } catch (error) {
      // Could not reach the server to verify the target (nothing was committed):
      // fall through and create a separate batch, which queues if need be.
      if (!isUnavailable(error)) throw error;
    }
  }
  return { outcome: await awaitWriteUnlessOffline(setDoc(doc(pantry, slugify(fields.name)), created()), onLateError), merged: false };
}

/** Moves every batch of a product to another shelf in one batch write. */
export function moveBatches(householdId: string, batches: readonly PantryBatch[], location: PantryItemLocation, uid: string, onLateError: (error: unknown) => void) {
  const batch = writeBatch(db);
  for (const entry of batches) batch.update(doc(pantryCollection(householdId), entry.id), { location, ...touched(uid) });
  return awaitWriteUnlessOffline(batch.commit(), onLateError);
}

/** Deletes the given batch documents (one product, or the list view's selection). */
export function deleteBatches(householdId: string, ids: readonly string[]) {
  if (ids.length === 1) return deleteDoc(doc(pantryCollection(householdId), ids[0]));
  const batch = writeBatch(db);
  for (const id of ids) batch.delete(doc(pantryCollection(householdId), id));
  return batch.commit();
}

/**
 * Deletes a used-up batch, online only: a transaction re-reads it and deletes it
 * only if it still has no packages and nobody touched it in the last minute (an
 * Undo, a +1 or a hand-off revives it instead). A batch that needs repair is
 * never deleted (`shouldDeleteEmptyBatch`). Resolves whether it was deleted.
 */
export function deleteEmptyBatchIfIdle(householdId: string, id: string, timeZone?: string | null): Promise<boolean> {
  const ref = doc(pantryCollection(householdId), id);
  return runTransaction(db, async (transaction) => {
    const snapshot = await transaction.get(ref);
    if (!snapshot.exists()) return false;
    const batch = readPantryBatch(id, snapshot.data(), timeZone);
    if (!shouldDeleteEmptyBatch(batch, Date.now())) return false;
    transaction.delete(ref);
    return true;
  });
}

/** The household's shopping lists (offline: from the cache). */
export async function readShoppingLists(householdId: string): Promise<ShoppingList[]> {
  const listsRef = collection(db, 'households', householdId, 'shopping-lists');
  return (await getDocsOfflineAware(query(listsRef))).docs.map((entry) => ({ ...(entry.data() as Omit<ShoppingList, 'id'>), id: entry.id }));
}

/** Creates the "Groceries" list used when a household has no Grocery list. */
export async function createGroceriesList(householdId: string, onLateError: (error: unknown) => void): Promise<Pick<ShoppingList, 'id' | 'name'>> {
  const id = slugify('Groceries');
  await awaitWriteUnlessOffline(
    setDoc(doc(db, 'households', householdId, 'shopping-lists', id), { name: 'Groceries', icon: 'ShoppingCart', type: 'Grocery', description: '' }),
    onLateError,
  );
  return { id, name: 'Groceries' };
}

export type AddToListResult = {
  listName: string;
  outcome: 'merged' | 'saved' | 'queued';
  /** The new item went under Other because categorization was unavailable (online only). */
  usedFallback: boolean;
};

/**
 * Puts a pantry product on a Grocery list (SH-6, SH-29b). Online, a still-needed
 * item with the same name is raised by `quantity` through the Shopping list's own
 * merge path (`findMergeTarget` + `mergeIntoNeededItem`, which re-checks it is
 * still needed), so "we're out of milk" never adds a second Milk. Otherwise (or
 * offline, where nothing merges) a new needed item is created with the shared
 * category resolution. A write the server confirmed (merged or saved) is
 * announced with `notifyDataChanged` (`shoppingWriteNotice`), so the Lists tab's
 * fallback counts (lists beyond the first 20 live ones) refresh.
 */
export async function addToGroceryList(
  householdId: string,
  list: Pick<ShoppingList, 'id' | 'name'>,
  name: string,
  quantity: number,
  onLateError: (error: unknown) => void,
): Promise<AddToListResult> {
  const listRef = doc(db, 'households', householdId, 'shopping-lists', list.id);
  const itemsRef = collection(listRef, 'items');
  const offline = isBrowserOffline();
  if (!offline) {
    const needed = (await getDocs(query(itemsRef, where('status', '==', 'needed'))).catch(() => null))
      ?.docs.map((entry) => ({ ...(entry.data() as Omit<ShoppingListItem, 'id'>), id: entry.id })) ?? [];
    const target = findMergeTarget(needed, name);
    if (target && await mergeIntoNeededItem(doc(itemsRef, target.id), quantity)) {
      announceShoppingWrite(householdId, list.id, 'merged');
      return { listName: list.name, outcome: 'merged', usedFallback: false };
    }
  }
  const categoriesSnapshot = await getDocOfflineAware(doc(listRef, 'config', 'categories')).catch(() => null);
  const categories = (categoriesSnapshot?.exists() ? normalizeStoredCategories(categoriesSnapshot.data()) : null) ?? DEFAULT_SHOPPING_CATEGORIES;
  const { category, usedFallback } = await resolveShoppingCategory({
    itemName: name,
    categories,
    selectedCategory: offline ? 'Other' : undefined,
    categorize: async (input) => unwrapAiActionResult(await categorizeGroceryItem(input, await getAiActionContext(householdId))),
  });
  const { itemId, data } = buildShoppingListItem({ name, quantity, category });
  const outcome = await awaitWriteUnlessOffline(setDoc(doc(itemsRef, itemId), data), onLateError);
  announceShoppingWrite(householdId, list.id, outcome);
  return { listName: list.name, outcome, usedFallback: usedFallback && !offline };
}

function announceShoppingWrite(householdId: string, listId: string, outcome: AddToListResult['outcome']) {
  const notice = shoppingWriteNotice(householdId, listId, outcome);
  if (notice) notifyDataChanged(notice);
}
