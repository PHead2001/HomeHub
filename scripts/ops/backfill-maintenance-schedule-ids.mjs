// Gives every maintenance schedule without an id a durable id (Maintenance Center
// README, "Schedule identity"): its legacy compatibility key `legacy-{index}-{slug}`,
// the same key reminders, deep links and open notifications already use, so nothing
// visible changes. The server assigns the same ids on the first completion, snooze or
// edit of a record (src/lib/server/maintenance-operations.ts); this script does it for
// records nobody touches. Only the schedule array of a record with id-less schedules is
// written, inside a transaction that re-reads the record, so the script is idempotent
// and can be stopped and re-run at any time; nothing else is ever changed.
//
// Usage:
//   node scripts/ops/backfill-maintenance-schedule-ids.mjs --project homehub-j91jb           # dry run: counts only
//   node scripts/ops/backfill-maintenance-schedule-ids.mjs --project homehub-j91jb --apply   # writes the ids
//
// Auth: as scripts/ops/migrate-push-tokens.mjs (see ./credentials.mjs), including
// --firebase-tools-login. The account needs Firestore read/write.
//
// Output is counts only: never document contents, names or IDs.
import { FieldPath } from 'firebase-admin/firestore';
import { parseOpsArgs } from './profile-privacy.mjs';
import { opsFirestore } from './credentials.mjs';
import { SCHEDULE_FIELDS, withScheduleIds } from './maintenance-schedule-ids.mjs';

const PAGE_SIZE = 300;

const options = parseOpsArgs(process.argv.slice(2), process.env);
const { projectId, apply } = options;
const { db, label } = await opsFirestore(options);
const target = process.env.FIRESTORE_EMULATOR_HOST ? `emulator ${process.env.FIRESTORE_EMULATOR_HOST}` : 'live Firestore';
console.log(`Project ${projectId} (${target}, ${label}). Mode: ${apply ? 'APPLY (schedule ids will be written)' : 'dry run (no writes)'}.`);

const totals = { households: 0, records: 0, needing: 0, schedules: 0, updated: 0, gone: 0, malformed: 0 };

// A list with an entry that is not an object is left exactly as it is (counted only).
const malformed = list => Array.isArray(list) && list.some(entry => !entry || typeof entry !== 'object');

const backfillRecord = async (ref, collection) => {
  const field = SCHEDULE_FIELDS[collection];
  totals.records += 1;
  const snapshot = await ref.get();
  if (malformed(snapshot.get(field))) {
    totals.malformed += 1;
    return;
  }
  const { assigned } = withScheduleIds(snapshot.get(field), collection);
  if (assigned === 0) return;
  totals.needing += 1;
  totals.schedules += assigned;
  if (!apply) return;
  // Re-read inside the transaction: a schedule edited or completed meanwhile wins.
  const outcome = await db.runTransaction(async tx => {
    const current = await tx.get(ref);
    if (!current.exists) return 'gone';
    if (malformed(current.get(field))) return 'done';
    const next = withScheduleIds(current.get(field), collection);
    if (next.assigned === 0) return 'done';
    tx.update(ref, { [field]: next.list });
    return 'updated';
  });
  if (outcome === 'updated') totals.updated += 1;
  if (outcome === 'gone') totals.gone += 1;
};

const backfillCollection = async (household, collection) => {
  let cursor = null;
  for (;;) {
    let page = household.ref.collection(collection).select().orderBy(FieldPath.documentId()).limit(PAGE_SIZE);
    if (cursor) page = page.startAfter(cursor);
    const snapshot = await page.get();
    if (snapshot.empty) break;
    for (const record of snapshot.docs) await backfillRecord(record.ref, collection);
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
    for (const collection of Object.keys(SCHEDULE_FIELDS)) await backfillCollection(household, collection);
  }
  householdCursor = snapshot.docs[snapshot.docs.length - 1];
  if (snapshot.size < PAGE_SIZE) break;
}

console.log(`Households scanned: ${totals.households}`);
console.log(`Assets and vehicles scanned: ${totals.records}`);
console.log(`Records with schedules lacking an id: ${totals.needing} (${totals.schedules} schedules)`);
console.log(`Records with a malformed schedule list (left unchanged): ${totals.malformed}`);
console.log(apply
  ? `Records updated: ${totals.updated}. Deleted meanwhile and skipped: ${totals.gone}.`
  : 'Dry run only. Re-run with --apply to write the ids.');
