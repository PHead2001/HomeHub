// Adds `occurrenceKey` ("templateId|roomId|day", chores README) to generated
// chores written before upkeep stored it: chores with a `templateId` and an
// `originalDueDate` and no `sourceType`. The day comes from the chore's
// deterministic id (`recurringChoreId` embeds the occurrence's original day),
// so a chore that was moved to another day keeps the identity of the day it
// was generated for. Chores whose id is not a generated id are left alone and
// counted. Upkeep already recovers the same key from the id when the field is
// missing, so this only makes the stored data say it; chores that already have
// a key are skipped, so the script can be stopped and re-run at any time.
//
// Usage:
//   node scripts/ops/backfill-occurrence-key.mjs --project homehub-j91jb           # dry run: counts only
//   node scripts/ops/backfill-occurrence-key.mjs --project homehub-j91jb --apply   # writes the field
//
// Auth: as scripts/ops/migrate-push-tokens.mjs (see ./credentials.mjs; also
// --firebase-tools-login). The account needs Firestore read/write.
//
// Output is counts only: never document contents, emails or IDs. Writes are
// updates of the one field, in batches of at most 400. A chore deleted
// meanwhile is skipped, never recreated.
import { FieldPath } from 'firebase-admin/firestore';
import { parseOpsArgs } from './profile-privacy.mjs';
import { opsFirestore } from './credentials.mjs';
import { occurrenceKeyDecision } from './occurrence-key.mjs';

const PAGE_SIZE = 400;
const NOT_FOUND = 5;

const options = parseOpsArgs(process.argv.slice(2), process.env);
const { projectId, apply } = options;
const { db, label } = await opsFirestore(options);
const target = process.env.FIRESTORE_EMULATOR_HOST ? `emulator ${process.env.FIRESTORE_EMULATOR_HOST}` : 'live Firestore';
console.log(`Project ${projectId} (${target}, ${label}). Mode: ${apply ? 'APPLY (occurrenceKey will be written)' : 'dry run (no writes)'}.`);

const totals = { households: 0, scanned: 0, present: 0, oneTime: 0, unrecognized: 0, write: 0, written: 0, gone: 0 };

// One batch per page. If it fails because a chore was deleted meanwhile, each
// update is retried on its own so the rest of the page is not lost.
const writePage = async writes => {
  if (writes.length === 0) return;
  const batch = db.batch();
  for (const [ref, occurrenceKey] of writes) batch.update(ref, { occurrenceKey });
  try {
    await batch.commit();
    totals.written += writes.length;
    return;
  } catch (error) {
    if (error?.code !== NOT_FOUND) throw error;
  }
  for (const [ref, occurrenceKey] of writes) {
    try {
      await ref.update({ occurrenceKey });
      totals.written += 1;
    } catch (error) {
      if (error?.code !== NOT_FOUND) throw error;
      totals.gone += 1;
    }
  }
};

const backfillHousehold = async household => {
  let cursor = null;
  for (;;) {
    let page = household.ref.collection('chores')
      .select('occurrenceKey', 'templateId', 'originalDueDate', 'roomIds', 'sourceType')
      .orderBy(FieldPath.documentId()).limit(PAGE_SIZE);
    if (cursor) page = page.startAfter(cursor);
    const snapshot = await page.get();
    if (snapshot.empty) break;

    const writes = [];
    for (const chore of snapshot.docs) {
      totals.scanned += 1;
      const decision = occurrenceKeyDecision(chore.id, chore.data());
      totals[decision.kind] += 1;
      if (decision.kind === 'write') writes.push([chore.ref, decision.occurrenceKey]);
    }
    if (apply) await writePage(writes);
    cursor = snapshot.docs[snapshot.docs.length - 1];
    if (snapshot.size < PAGE_SIZE) break;
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
    await backfillHousehold(household);
  }
  householdCursor = snapshot.docs[snapshot.docs.length - 1];
  if (snapshot.size < PAGE_SIZE) break;
}

console.log(`Households scanned: ${totals.households}`);
console.log(`Chores scanned: ${totals.scanned}`);
console.log(`Already have an occurrenceKey: ${totals.present}`);
console.log(`One-time or not generated (left alone): ${totals.oneTime}`);
console.log(`Generated, but the id is not a generated id (left alone): ${totals.unrecognized}`);
console.log(`Missing an occurrenceKey: ${totals.write}`);
console.log(apply
  ? `Chores updated: ${totals.written}. Deleted meanwhile and skipped: ${totals.gone}.`
  : 'Dry run only. Re-run with --apply to write the field.');
