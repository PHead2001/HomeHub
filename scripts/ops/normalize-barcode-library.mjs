// Moves Barcode Library products to their normalised document ID (BL-12,
// docs/modules/barcode-library/README.md): "012345 678905", the UPC-A
// "012345678905" and the EAN-13 "0012345678905" become "0012345678905", the ID
// the app now writes and looks up first. A product is re-created under the new
// ID with every field kept (name, photo, createdAt, createdByUid, counts) and
// the old document deleted, in one transaction that re-reads both, so a member's
// edit meanwhile is carried over and an ID taken meanwhile is never overwritten.
// IDs that are not barcodes, or whose check digit does not match, are left as
// they are (the app keeps them as typed). When the normalised ID is already
// taken (the same product saved twice), both are left alone and counted for a
// person to merge in the library. Until this runs, lookup also tries the old ID.
//
// Usage:
//   node scripts/ops/normalize-barcode-library.mjs --project homehub-j91jb           # dry run: counts only
//   node scripts/ops/normalize-barcode-library.mjs --project homehub-j91jb --apply   # writes
//
// Auth: as scripts/ops/migrate-pantry-v2.mjs (./credentials.mjs). Output is counts
// only, never product names or codes. Safe to stop and re-run.
import { FieldPath } from 'firebase-admin/firestore';
import { parseOpsArgs } from './profile-privacy.mjs';
import { opsFirestore } from './credentials.mjs';
import { barcodeMoveDecision } from './barcode-library-ids.mjs';

const PAGE_SIZE = 400;

const options = parseOpsArgs(process.argv.slice(2), process.env);
const { projectId, apply } = options;
const { db, label } = await opsFirestore(options);
const target = process.env.FIRESTORE_EMULATOR_HOST ? `emulator ${process.env.FIRESTORE_EMULATOR_HOST}` : 'live Firestore';
console.log(`Project ${projectId} (${target}, ${label}). Mode: ${apply ? 'APPLY (products will be moved)' : 'dry run (no writes)'}.`);

const totals = { households: 0, scanned: 0, current: 0, move: 0, collision: 0, moved: 0, gone: 0, takenMeanwhile: 0 };

const move = async (from, to) => {
  const outcome = await db.runTransaction(async (transaction) => {
    const [source, existing] = await Promise.all([transaction.get(from), transaction.get(to)]);
    if (!source.exists) return 'gone';
    if (existing.exists) return 'taken';
    transaction.create(to, source.data());
    transaction.delete(from);
    return 'moved';
  });
  if (outcome === 'moved') totals.moved += 1;
  else if (outcome === 'gone') totals.gone += 1;
  else totals.takenMeanwhile += 1;
};

const migrateHousehold = async (household) => {
  const library = household.ref.collection('barcode-library');
  const ids = [];
  let cursor = null;
  for (;;) {
    let page = library.orderBy(FieldPath.documentId()).select().limit(PAGE_SIZE);
    if (cursor) page = page.startAfter(cursor);
    const snapshot = await page.get();
    if (snapshot.empty) break;
    snapshot.docs.forEach((entry) => ids.push(entry.id));
    cursor = snapshot.docs[snapshot.docs.length - 1];
    if (snapshot.size < PAGE_SIZE) break;
  }
  const existing = new Set(ids);
  for (const id of ids) {
    totals.scanned += 1;
    const decision = barcodeMoveDecision(id, existing);
    totals[decision.kind] += 1;
    if (apply && decision.kind === 'move') {
      await move(library.doc(id), library.doc(decision.to));
      existing.add(decision.to);
    }
  }
};

let householdCursor = null;
for (;;) {
  let page = db.collection('households').select().orderBy(FieldPath.documentId()).limit(PAGE_SIZE);
  if (householdCursor) page = page.startAfter(householdCursor);
  const snapshot = await page.get();
  if (snapshot.empty) break;
  for (const household of snapshot.docs) {
    totals.households += 1;
    await migrateHousehold(household);
  }
  householdCursor = snapshot.docs[snapshot.docs.length - 1];
  if (snapshot.size < PAGE_SIZE) break;
}

console.log(`Households scanned: ${totals.households}`);
console.log(`Products scanned: ${totals.scanned}`);
console.log(`Already normalised (or not a barcode): ${totals.current}`);
console.log(`To move to the normalised ID: ${totals.move}`);
console.log(`Saved twice (normalised ID taken; merge by hand in the library): ${totals.collision}`);
console.log(apply
  ? `Moved: ${totals.moved}. Deleted meanwhile: ${totals.gone}. ID taken meanwhile (left alone): ${totals.takenMeanwhile}.`
  : 'Dry run only. Re-run with --apply to move.');
