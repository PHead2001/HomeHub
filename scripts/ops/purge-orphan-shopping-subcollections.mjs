// Removes what older clients left behind when they deleted a shopping list
// (shopping README, SH-9): those clients deleted only the list document, so its
// `items/*` and `config/*` stayed under a list reference with no document. Since
// release 2.1 lists are deleted with everything under them (deleteShoppingList)
// and the rules refuse item and category writes to a missing list, so nothing
// new can be orphaned. Run it by hand, once every client is on that release.
//
// Usage:
//   node scripts/ops/purge-orphan-shopping-subcollections.mjs --project homehub-j91jb           # dry run: counts only
//   node scripts/ops/purge-orphan-shopping-subcollections.mjs --project homehub-j91jb --apply   # deletes the orphans
//
// Auth: as scripts/ops/migrate-push-tokens.mjs (see ./credentials.mjs): Application
// Default Credentials, or --firebase-tools-login [--firebase-tools-from <dir>].
// The account needs Firestore read/write.
//
// It finds list references whose document is missing with listDocuments() (which
// also returns references that only have subcollections) and deletes only what
// is under them, never a list document. With --apply, while members keep using
// Shopping, a member can re-create a list under the same id (ids derive from the
// name) at any moment, so every delete goes through purgeOrphanList
// (./shopping-orphans.mjs): pages of at most 200 documents, each one Firestore
// transaction that re-reads the list document and deletes nothing if the list
// exists, in which case the rest of that list is left alone and counted as
// re-created. No document under an existing list is ever deleted. Output is
// counts only: never names, ids or contents. Everything it deletes is gone for
// good, so a stopped run is resumed by running it again; a re-run finds only
// what is left.
import { FieldPath } from 'firebase-admin/firestore';
import { parseOpsArgs } from './profile-privacy.mjs';
import { opsFirestore } from './credentials.mjs';
import { purgeOrphanList } from './shopping-orphans.mjs';

const PAGE_SIZE = 400;
const GET_ALL_CHUNK = 100;

const options = parseOpsArgs(process.argv.slice(2), process.env);
const { projectId, apply } = options;
const { db, label } = await opsFirestore(options);
const target = process.env.FIRESTORE_EMULATOR_HOST ? `emulator ${process.env.FIRESTORE_EMULATOR_HOST}` : 'live Firestore';
console.log(`Project ${projectId} (${target}, ${label}). Mode: ${apply ? 'APPLY (orphaned items and categories will be deleted)' : 'dry run (no writes)'}.`);

const totals = { households: 0, listRefs: 0, lists: 0, orphans: 0, orphanItems: 0, orphanConfig: 0, otherDocs: 0, purged: 0, recreated: 0, deleted: 0 };

const countOf = async collection => (await collection.count().get()).data().count;

/** List references of a household whose document does not exist. */
const missingLists = async household => {
  const refs = await household.collection('shopping-lists').listDocuments();
  totals.listRefs += refs.length;
  const missing = [];
  for (let index = 0; index < refs.length; index += GET_ALL_CHUNK) {
    const chunk = refs.slice(index, index + GET_ALL_CHUNK);
    const snapshots = await db.getAll(...chunk, { fieldMask: [] });
    for (const snapshot of snapshots) {
      if (snapshot.exists) totals.lists += 1;
      else missing.push(snapshot.ref);
    }
  }
  return missing;
};

const purgeOrphan = async listRef => {
  const collections = await listRef.listCollections();
  if (collections.length === 0) return;
  totals.orphans += 1;
  for (const collection of collections) {
    const size = await countOf(collection);
    if (collection.id === 'items') totals.orphanItems += size;
    else if (collection.id === 'config') totals.orphanConfig += size;
    else totals.otherDocs += size;
  }
  if (!apply) return;
  const result = await purgeOrphanList(store, listRef);
  totals.deleted += result.deleted;
  if (result.outcome === 'recreated') totals.recreated += 1;
  else totals.purged += 1;
};

/** Firestore calls for purgeOrphanList; each deletePage is one transaction. */
const store = {
  subcollections: ref => ref.listCollections(),
  documentRefs: collection => collection.listDocuments(),
  deletePage: (listRef, collection, pageSize) => db.runTransaction(async transaction => {
    // Reading the list document inside the transaction serializes this page with
    // a member re-creating the list: either the page sees the list and deletes
    // nothing, or the re-creation commits after the page.
    if ((await transaction.get(listRef)).exists) return { listExists: true, deleted: 0 };
    const page = await transaction.get(collection.select().limit(pageSize));
    for (const doc of page.docs) transaction.delete(doc.ref);
    return { listExists: false, deleted: page.size };
  }),
};

let householdCursor = null;
for (;;) {
  let page = db.collection('households').select().orderBy(FieldPath.documentId()).limit(PAGE_SIZE);
  if (householdCursor) page = page.startAfter(householdCursor);
  const snapshot = await page.get();
  if (snapshot.empty) break;
  for (const household of snapshot.docs) {
    totals.households += 1;
    for (const listRef of await missingLists(household.ref)) await purgeOrphan(listRef);
  }
  householdCursor = snapshot.docs[snapshot.docs.length - 1];
  if (snapshot.size < PAGE_SIZE) break;
}

console.log(`Households scanned: ${totals.households}`);
console.log(`List references found: ${totals.listRefs} (lists with a document: ${totals.lists})`);
console.log(`Deleted lists with documents left under them: ${totals.orphans}`);
console.log(`  orphaned items: ${totals.orphanItems}`);
console.log(`  orphaned category documents: ${totals.orphanConfig}`);
console.log(`  other orphaned documents: ${totals.otherDocs}`);
console.log(apply
  ? `Orphaned lists purged: ${totals.purged} (documents deleted: ${totals.deleted}). Re-created meanwhile and left alone: ${totals.recreated}.`
  : 'Dry run only. Re-run with --apply to delete them.');
