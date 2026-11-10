// Adds `assignedToUid` to chores and chore templates that only name their
// assignee by email (chores README, "Assignee identity"), and repairs a uid
// that an older build left behind when it reassigned a chore by email only.
// The uid comes from the household's member documents (email to uid). Records
// that are unassigned, already agree, or name someone who is no longer a member
// are left alone, so the script can be stopped and re-run at any time. Run it
// by hand after the release that dual-writes the field (release A), and again
// once browsers on older builds have aged out, before any release reads the uid
// alone.
//
// Usage:
//   node scripts/ops/backfill-chore-assignee-uid.mjs --project homehub-j91jb           # dry run: counts only
//   node scripts/ops/backfill-chore-assignee-uid.mjs --project homehub-j91jb --apply   # writes the field
//
// Auth: as scripts/ops/migrate-push-tokens.mjs (see ./credentials.mjs), including
// --firebase-tools-login. The account needs Firestore read/write.
//
// Output is counts only: never document contents, emails or IDs. Writes are
// updates of the one field, in batches of at most 400, each guarded by the
// document's update time: a document changed (or deleted) since it was read is
// skipped and counted, never overwritten; the next run picks it up.
import { FieldPath } from 'firebase-admin/firestore';
import { parseOpsArgs } from './profile-privacy.mjs';
import { opsFirestore } from './credentials.mjs';
import { assigneeBackfillDecision, memberUidsByEmail } from './chore-assignee.mjs';

const PAGE_SIZE = 400;
const NOT_FOUND = 5;
const FAILED_PRECONDITION = 9;
const COLLECTIONS = ['chores', 'chore-templates'];

const options = parseOpsArgs(process.argv.slice(2), process.env);
const { projectId, apply } = options;
const { db, label } = await opsFirestore(options);
const target = process.env.FIRESTORE_EMULATOR_HOST ? `emulator ${process.env.FIRESTORE_EMULATOR_HOST}` : 'live Firestore';
console.log(`Project ${projectId} (${target}, ${label}). Mode: ${apply ? 'APPLY (assignedToUid will be written)' : 'dry run (no writes)'}.`);

const empty = () => ({ scanned: 0, present: 0, unassigned: 0, former: 0, missing: 0, mismatch: 0, written: 0, changed: 0 });
const totals = { households: 0, chores: empty(), 'chore-templates': empty() };

const skippable = error => error?.code === NOT_FOUND || error?.code === FAILED_PRECONDITION;

// One batch per page. If it fails because a document changed or was deleted
// meanwhile, each update is retried on its own so the rest of the page is kept.
const writePage = async (writes, counts) => {
  if (writes.length === 0) return;
  const batch = db.batch();
  for (const { ref, assignedToUid, updateTime } of writes) batch.update(ref, { assignedToUid }, { lastUpdateTime: updateTime });
  try {
    await batch.commit();
    counts.written += writes.length;
    return;
  } catch (error) {
    if (!skippable(error)) throw error;
  }
  for (const { ref, assignedToUid, updateTime } of writes) {
    try {
      await ref.update({ assignedToUid }, { lastUpdateTime: updateTime });
      counts.written += 1;
    } catch (error) {
      if (!skippable(error)) throw error;
      counts.changed += 1;
    }
  }
};

const backfillCollection = async (household, name, uidByEmail) => {
  const counts = totals[name];
  let cursor = null;
  for (;;) {
    let page = household.ref.collection(name)
      .select('assignedToUid', 'assignedToEmail', 'recurrence')
      .orderBy(FieldPath.documentId()).limit(PAGE_SIZE);
    if (cursor) page = page.startAfter(cursor);
    const snapshot = await page.get();
    if (snapshot.empty) break;

    const writes = [];
    for (const record of snapshot.docs) {
      counts.scanned += 1;
      const decision = assigneeBackfillDecision(record.data(), uidByEmail);
      counts[decision.kind] += 1;
      if (decision.kind === 'missing' || decision.kind === 'mismatch') {
        writes.push({ ref: record.ref, assignedToUid: decision.assignedToUid, updateTime: record.updateTime });
      }
    }
    if (apply) await writePage(writes, counts);
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
    const members = await household.ref.collection('members').select('email').get();
    const uidByEmail = memberUidsByEmail(members.docs.map(member => ({ uid: member.id, email: member.get('email') })));
    for (const name of COLLECTIONS) await backfillCollection(household, name, uidByEmail);
  }
  householdCursor = snapshot.docs[snapshot.docs.length - 1];
  if (snapshot.size < PAGE_SIZE) break;
}

console.log(`Households scanned: ${totals.households}`);
for (const name of COLLECTIONS) {
  const counts = totals[name];
  console.log(`${name}: ${counts.scanned} scanned`);
  console.log(`  uid already right: ${counts.present}`);
  console.log(`  unassigned: ${counts.unassigned}`);
  console.log(`  email names no current member (left alone): ${counts.former}`);
  console.log(`  uid missing: ${counts.missing}`);
  console.log(`  uid disagrees with the email (reassigned by an older build): ${counts.mismatch}`);
  if (apply) console.log(`  updated: ${counts.written}; changed or deleted meanwhile and skipped: ${counts.changed}`);
}
if (!apply) console.log('Dry run only. Re-run with --apply to write the field.');
