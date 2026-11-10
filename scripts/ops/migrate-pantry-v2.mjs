// Converts household pantry documents to the Pantry v2 shape (pantry-recipes
// README, audit 17.3): legacy documents (`quantity` + an ISO `expiryDate`) get
// `packages`, `packageSize`, `nameKey`, a date-only `expiryDate` in the
// household's zone, the dual-written `quantity` and `schemaVersion: 2`; v2
// documents an older page later gave an ISO expiry get only that expiry
// rewritten. Documents already in v2 shape are left alone, so the script can be
// stopped and re-run at any time (it resumes by skipping what is done). Run it
// by hand, after the release with rules stage S4a and the v2 client, and before
// rules stage S4b (date-only expiry only).
//
// Usage:
//   node scripts/ops/migrate-pantry-v2.mjs --project homehub-j91jb           # dry run: counts only
//   node scripts/ops/migrate-pantry-v2.mjs --project homehub-j91jb --apply   # writes
//
// Auth: as scripts/ops/migrate-push-tokens.mjs (see ./credentials.mjs; also
// --firebase-tools-login). The account needs Firestore read/write.
//
// Output is counts only: never document contents, names or IDs. Each write is an
// update guarded by the document's last update time, so an edit made by a member
// while the script runs is never overwritten: the document is re-read and its
// mapping recomputed (up to three times). A document deleted meanwhile is
// skipped, never recreated.
//
// Stock is never truncated. A legacy counted document above 10,000 (the rules'
// limit per batch) is split: the document keeps the first 10,000 and new batch
// documents (ids `<id>-v2-<n>`) take the rest, in one atomic batch with the
// guarded update, so a retry or re-run never splits twice. A legacy measured
// document above 100,000 cannot be one package: it is left unconverted and
// counted ("oversized") for a person to fix.
import { FieldPath } from 'firebase-admin/firestore';
import { parseOpsArgs } from './profile-privacy.mjs';
import { opsFirestore } from './credentials.mjs';
import { pantryMigrationDecision } from './pantry-v2.mjs';

const PAGE_SIZE = 400;
const NOT_FOUND = 5;
const ALREADY_EXISTS = 6;
const FAILED_PRECONDITION = 9;
const MAX_ATTEMPTS = 3;

const options = parseOpsArgs(process.argv.slice(2), process.env);
const { projectId, apply } = options;
const { db, label } = await opsFirestore(options);
const target = process.env.FIRESTORE_EMULATOR_HOST ? `emulator ${process.env.FIRESTORE_EMULATOR_HOST}` : 'live Firestore';
console.log(`Project ${projectId} (${target}, ${label}). Mode: ${apply ? 'APPLY (pantry documents will be converted)' : 'dry run (no writes)'}.`);

const totals = { households: 0, scanned: 0, current: 0, legacy: 0, split: 0, oversized: 0, expiry: 0, written: 0, created: 0, retried: 0, gone: 0, gaveUp: 0 };

// Writes one decision with the snapshot's update time as a precondition. On a
// concurrent edit the document is re-read and the mapping recomputed from it.
const convert = async (snapshot, timeZone) => {
  let current = snapshot;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const decision = pantryMigrationDecision(current.data(), timeZone);
    if (decision.kind === 'current' || decision.kind === 'oversized') return;
    try {
      if (decision.kind === 'split') {
        // The update and the new batches commit together or not at all.
        const batch = db.batch();
        batch.update(current.ref, decision.update, { lastUpdateTime: current.updateTime });
        decision.newBatches.forEach((data, index) => batch.create(current.ref.parent.doc(`${current.ref.id}-v2-${index + 1}`), data));
        await batch.commit();
        totals.created += decision.newBatches.length;
      } else {
        await current.ref.update(decision.update, { lastUpdateTime: current.updateTime });
      }
      totals.written += 1;
      return;
    } catch (error) {
      if (error?.code === NOT_FOUND) {
        totals.gone += 1;
        return;
      }
      if (error?.code === ALREADY_EXISTS) break;
      if (error?.code !== FAILED_PRECONDITION) throw error;
      totals.retried += 1;
      current = await current.ref.get();
      if (!current.exists) {
        totals.gone += 1;
        return;
      }
    }
  }
  totals.gaveUp += 1;
};

const migrateHousehold = async household => {
  const timeZone = household.get('timeZone');
  let cursor = null;
  for (;;) {
    let page = household.ref.collection('pantry-inventory').orderBy(FieldPath.documentId()).limit(PAGE_SIZE);
    if (cursor) page = page.startAfter(cursor);
    const snapshot = await page.get();
    if (snapshot.empty) break;
    for (const entry of snapshot.docs) {
      totals.scanned += 1;
      const decision = pantryMigrationDecision(entry.data(), timeZone);
      totals[decision.kind] += 1;
      if (apply && decision.kind !== 'current' && decision.kind !== 'oversized') await convert(entry, timeZone);
    }
    cursor = snapshot.docs[snapshot.docs.length - 1];
    if (snapshot.size < PAGE_SIZE) break;
  }
};

let householdCursor = null;
for (;;) {
  let page = db.collection('households').select('timeZone').orderBy(FieldPath.documentId()).limit(PAGE_SIZE);
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
console.log(`Pantry documents scanned: ${totals.scanned}`);
console.log(`Already Pantry v2: ${totals.current}`);
console.log(`Legacy documents to convert: ${totals.legacy}`);
console.log(`Legacy counted documents above 10,000 to split across batches: ${totals.split}`);
console.log(`Legacy measured documents above 100,000 left unconverted (fix by hand, then re-run): ${totals.oversized}`);
console.log(`v2 documents with an ISO expiry to rewrite: ${totals.expiry}`);
console.log(apply
  ? `Documents updated: ${totals.written} (new batches for split stock: ${totals.created}). Re-read after a concurrent edit: ${totals.retried}. Deleted meanwhile and skipped: ${totals.gone}. Still changing after ${MAX_ATTEMPTS} tries (re-run later): ${totals.gaveUp}.`
  : 'Dry run only. Re-run with --apply to convert.');
