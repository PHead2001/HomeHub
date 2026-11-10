import 'server-only';

import type { CollectionReference, DocumentReference, Firestore } from 'firebase-admin/firestore';
import { purgeOrphanList } from '../../../scripts/ops/shopping-orphans.mjs';

/** Cleanup passes before giving up; each pass purges and then re-checks. */
export const LIST_DELETE_MAX_PASSES = 5;

export type ListDeleteOutcome = 'deleted' | 'recreated' | 'incomplete';

export type ListDeleteHooks = {
  /** Runs once the list document is gone, before anything under it is read. */
  afterBarrier?: () => Promise<void>;
  /** Runs after each cleanup pass, before the emptiness check. */
  afterPass?: (pass: number) => Promise<void>;
};

const purgeStore = (db: Firestore) => ({
  subcollections: (ref: unknown) => (ref as DocumentReference).listCollections(),
  documentRefs: (collection: unknown) => (collection as CollectionReference).listDocuments(),
  deletePage: (listRef: unknown, collection: unknown, pageSize: number) => db.runTransaction(async transaction => {
    // Reading the list document in the transaction serializes the page with a
    // member re-creating the list under the same (slug-derived) id.
    if ((await transaction.get(listRef as DocumentReference)).exists) return { listExists: true, deleted: 0 };
    const page = await transaction.get((collection as CollectionReference).select().limit(pageSize));
    for (const doc of page.docs) transaction.delete(doc.ref);
    return { listExists: false, deleted: page.size };
  }),
});

/** True when no document is left anywhere under `ref` (any depth). */
async function nothingUnder(ref: DocumentReference): Promise<boolean> {
  for (const collection of await ref.listCollections()) {
    for (const doc of await collection.listDocuments()) {
      if ((await doc.get()).exists) return false;
      if (!(await nothingUnder(doc))) return false;
    }
  }
  return true;
}

/**
 * Deletes a shopping list and everything under it (SH-9) without leaving a
 * window for orphans. The list document goes first: from then on the rules'
 * `shoppingListExists()` refuses every item and category create or update, so
 * nothing new can land under it while the subcollections are scanned. The
 * subcollections are then purged with the orphan purge plan (pages that re-read
 * the list and stop if it was re-created) and re-checked until empty, at most
 * `LIST_DELETE_MAX_PASSES` times.
 *
 * - `deleted`: the list and everything under it are gone.
 * - `recreated`: a member re-created a list with the same id meanwhile; what is
 *   under it now belongs to that list and is left alone.
 * - `incomplete`: documents were still found after the last pass.
 */
export async function deleteListTree(db: Firestore, listRef: DocumentReference, hooks: ListDeleteHooks = {}): Promise<ListDeleteOutcome> {
  await listRef.delete();
  await hooks.afterBarrier?.();
  const store = purgeStore(db);
  for (let pass = 1; pass <= LIST_DELETE_MAX_PASSES; pass += 1) {
    const { outcome } = await purgeOrphanList(store, listRef);
    if (outcome === 'recreated') return 'recreated';
    await hooks.afterPass?.(pass);
    if ((await listRef.get()).exists) return 'recreated';
    if (await nothingUnder(listRef)) return 'deleted';
  }
  return 'incomplete';
}
