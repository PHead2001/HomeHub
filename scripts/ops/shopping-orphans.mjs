// Deletion plan for purge-orphan-shopping-subcollections.mjs. No Firebase
// imports: the Firestore calls come in through `store`, so
// tests/unit/shopping-orphan-purge.test.ts can drive it with a fake.
//
// The guarantee: no document under a list that exists is ever deleted. Every
// delete happens in a page of at most `pageSize` documents, and each page is
// one Firestore transaction that first re-reads the list document and deletes
// nothing if the list exists (see `deletePage`). A member who re-creates the
// list (slug-derived ids are reused) either commits before a page, so that page
// and every later one see the list and stop, or after it, so the page only
// removed documents that were orphans when it committed; the transaction's read
// of the list document makes the two serialize.

/** Documents deleted per transaction (well under Firestore's write limits). */
export const ORPHAN_DELETE_PAGE_SIZE = 200;

/**
 * @typedef {object} OrphanStore
 * @property {(ref: unknown) => Promise<unknown[]>} subcollections
 *   Subcollections directly under a document reference.
 * @property {(collection: unknown) => Promise<unknown[]>} documentRefs
 *   Every document reference in a collection, including missing documents that
 *   only have subcollections (Firestore `listDocuments()`).
 * @property {(listRef: unknown, collection: unknown, pageSize: number) => Promise<{ listExists: boolean, deleted: number }>} deletePage
 *   One transaction: read the list document; if it exists delete nothing and
 *   return `listExists: true`; otherwise delete up to `pageSize` documents of
 *   `collection` and return how many.
 */

/**
 * What to do after one page.
 * @param {{ listExists: boolean, deleted: number }} page
 * @param {number} pageSize
 * @returns {'stop' | 'next' | 'done'} `stop`: the list exists again, leave it
 *   alone; `next`: a full page was deleted, there may be more; `done`: the
 *   collection is empty.
 */
export function afterPage(page, pageSize) {
  if (page.listExists) return 'stop';
  return page.deleted >= pageSize ? 'next' : 'done';
}

/**
 * Deletes every document under an orphaned list reference (its subcollections,
 * deepest first), never the list document, stopping at the first page that
 * finds the list exists.
 * @param {OrphanStore} store
 * @param {unknown} listRef
 * @param {{ pageSize?: number }} [options]
 * @returns {Promise<{ outcome: 'purged' | 'recreated', deleted: number }>}
 */
export async function purgeOrphanList(store, listRef, { pageSize = ORPHAN_DELETE_PAGE_SIZE } = {}) {
  if (!Number.isInteger(pageSize) || pageSize < 1) throw new RangeError('pageSize must be a positive integer');
  let deleted = 0;

  /** @returns {Promise<boolean>} false when the list exists again. */
  const purgeCollection = async collection => {
    for (const doc of await store.documentRefs(collection)) {
      for (const sub of await store.subcollections(doc)) {
        if (!(await purgeCollection(sub))) return false;
      }
    }
    for (;;) {
      const page = await store.deletePage(listRef, collection, pageSize);
      const next = afterPage(page, pageSize);
      if (next === 'stop') return false;
      deleted += page.deleted;
      if (next === 'done') return true;
    }
  };

  for (const collection of await store.subcollections(listRef)) {
    if (!(await purgeCollection(collection))) return { outcome: 'recreated', deleted };
  }
  return { outcome: 'purged', deleted };
}
