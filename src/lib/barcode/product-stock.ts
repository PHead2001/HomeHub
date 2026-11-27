/**
 * Personal-account writes for a library product or a scanned code (BL-13 "Add to
 * list" / "Add to pantry", BL-20 kitchen scan station, BL-21 "scan to mark
 * used"). The decisions are pure (`./pantry-by-barcode`); the writes reuse the
 * pantry's own paths (`changePackagesTogether`, `saveBatch`) and the shopping
 * list's merge path (`addToGroceryList`), so the rules, attribution, offline
 * queueing and the 10,000-per-batch limit hold exactly as on the Pantry tab.
 * Registered wall tablets never use this file: they send device actions.
 */
import { collection } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { getDocsOfflineAware } from '@/lib/firestore-offline';
import type { ShoppingList } from '@/lib/types';
import {
  addToGroceryList,
  changePackagesTogether,
  createGroceriesList,
  readShoppingLists,
  saveBatch,
  type AddToListResult,
} from '@/lib/shopping/pantry-batch-writes';
import { findPantryMergeTarget, groceryListChoice, pantryBatchFields, readPantryBatch, type PantryBatch } from '@/lib/shopping/pantry-batches';
import { readRecentList, rememberRecentList } from '@/lib/shopping/recent-list';
import { planRestock, planUsedUp, type ScannedProductRef } from './pantry-by-barcode';

export type PackageDelta = { batch: PantryBatch; delta: number };

type Context = {
  householdId: string;
  uid: string;
  timeZone?: string | null;
  onLateError: (error: unknown) => void;
};

/** The household's pantry batches (offline: from the cache). */
export async function readPantryBatches(householdId: string, timeZone?: string | null): Promise<PantryBatch[]> {
  const snapshot = await getDocsOfflineAware(collection(db, 'households', householdId, 'pantry-inventory'));
  return snapshot.docs.map((entry) => readPantryBatch(entry.id, entry.data(), timeZone));
}

export type UseOneResult =
  | { kind: 'not-stocked' }
  | { kind: 'nothing-left'; name: string }
  | {
      kind: 'used';
      name: string;
      remaining: number;
      /** D-8: ask "Add to list?" (nothing is added without the tap). */
      askAddToList: boolean;
      outcome: 'saved' | 'queued';
      /** The change to reverse for Undo (only offered for a change the server acknowledged). */
      changes: PackageDelta[];
      undoable: boolean;
    };

/** "Used up": one package of the scanned product, from its soonest-expiring batch. */
export async function takeOneOf(scanned: ScannedProductRef, context: Context): Promise<UseOneResult> {
  const batches = await readPantryBatches(context.householdId, context.timeZone);
  const plan = planUsedUp(batches, scanned);
  if (plan.kind === 'not-stocked') return plan;
  if (plan.kind === 'nothing-left') return { kind: 'nothing-left', name: plan.product.name };
  const changes = [{ batch: plan.batch, delta: -1 }];
  const { outcome, undoable } = await changePackagesTogether(context.householdId, changes, context.uid, context.onLateError, context.timeZone);
  return { kind: 'used', name: plan.product.name, remaining: plan.remaining, askAddToList: plan.askAddToList, outcome, changes, undoable };
}

export type RestockResult = {
  name: string;
  outcome: 'saved' | 'queued';
  /** Added to stock already on a shelf (an Undo is the reverse increment); false: a new batch. */
  merged: boolean;
  changes: PackageDelta[];
  undoable: boolean;
};

/** "Restock" / "Add to pantry": one more package, or a new batch of one item on the Pantry shelf. */
export async function restockOne(scanned: ScannedProductRef, context: Context): Promise<RestockResult> {
  const batches = await readPantryBatches(context.householdId, context.timeZone);
  const plan = planRestock(batches, scanned);
  if (plan.kind === 'add-one' && plan.plan.kind === 'increment') {
    const changes = [{ batch: plan.plan.batch, delta: 1 }];
    const { outcome, undoable } = await changePackagesTogether(context.householdId, changes, context.uid, context.onLateError, context.timeZone);
    return { name: plan.product.name, outcome, merged: true, changes, undoable };
  }
  const input = plan.kind === 'add-one' && plan.plan.kind === 'create' ? plan.plan.input : plan.kind === 'new' ? plan.input : null;
  if (!input) throw new Error('No pantry plan.');
  const mergeInto = plan.kind === 'add-one' && plan.plan.kind === 'create' ? plan.plan.full : findPantryMergeTarget(batches, pantryBatchFields(input));
  const saved = await saveBatch(context.householdId, input, context.uid, { mergeInto, timeZone: context.timeZone }, context.onLateError);
  return { name: input.name, outcome: saved.outcome, merged: saved.merged, changes: [], undoable: false };
}

/** Undo of a "Used up" or "Restock" increment: the same packages back, as increments. */
export async function undoPackageChanges(changes: readonly PackageDelta[], context: Context): Promise<void> {
  await changePackagesTogether(
    context.householdId,
    changes.map(({ batch, delta }) => ({ batch: { ...batch, legacy: false, needsRepair: false }, delta: -delta })),
    context.uid,
    context.onLateError,
    context.timeZone,
  );
}

export type ListTarget = Pick<ShoppingList, 'id' | 'name'>;

export type PutOnListResult =
  | { kind: 'pick'; lists: ShoppingList[]; preselectId: string }
  | { kind: 'added'; result: AddToListResult };

/**
 * "Add to list": one of the product onto the household's Grocery list (the one
 * Grocery list, the list picked, or a new "Groceries"), through the list's merge
 * path (a name already needed gets one more). Several Grocery lists and no
 * `list` given: the caller shows a picker (`pick`).
 */
export async function putOnList(name: string, context: Omit<Context, 'timeZone'> & { list?: ListTarget }): Promise<PutOnListResult> {
  let list = context.list;
  if (!list) {
    const lists = await readShoppingLists(context.householdId);
    const choice = groceryListChoice(lists, readRecentList(context.householdId));
    if (choice.kind === 'pick') return { kind: 'pick', lists: choice.lists, preselectId: choice.preselectId };
    list = choice.kind === 'direct' ? choice.list : await createGroceriesList(context.householdId, context.onLateError);
  }
  const target = list;
  const result = await addToGroceryList({
    householdId: context.householdId,
    uid: context.uid,
    list: target,
    name,
    quantity: 1,
    active: () => ({ householdId: context.householdId, listId: target.id }),
    onLateError: context.onLateError,
  });
  if (result.state === 'failed') throw result.error ?? new Error('save-failed');
  rememberRecentList(context.householdId, target.id);
  return { kind: 'added', result };
}

/** The toast after "Add to list" (only what is known, SH-4). */
export function onListCopy(name: string, result: AddToListResult): { title: string; description: string } {
  const where = result.listName;
  if (result.state === 'saved') {
    return { title: 'On the list', description: result.merged ? `${result.name} was already on ${where}; it now needs 1 more.` : `${name} is on ${where}.` };
  }
  if (result.state === 'stored-locally') return { title: 'Saved, will sync', description: `${name} is saved on this device and reaches ${where} when the connection is back.` };
  return { title: 'Still sending…', description: `${name} has not reached ${where} yet. An error shows here if it fails.` };
}
