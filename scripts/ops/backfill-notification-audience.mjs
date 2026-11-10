// Adds `audience` to household notification documents written before the
// field existed (notifications README): `[targetUserUid]` for a notification
// aimed at one member, the member's uid looked up from the household's member
// documents for a legacy email-only target, `['*']` for a household-wide one,
// and `[]` when an email-only target is no longer a member. Documents that
// already have an audience are left alone, so the script can be stopped and
// re-run at any time. Run it by hand, after the release that writes the field
// and before the release that reads by it.
//
// Usage:
//   node scripts/ops/backfill-notification-audience.mjs --project homehub-j91jb           # dry run: counts only
//   node scripts/ops/backfill-notification-audience.mjs --project homehub-j91jb --apply   # writes the field
//
// Auth: as scripts/ops/migrate-push-tokens.mjs (see ./credentials.mjs). The
// account needs Firestore read/write.
//
// Output is counts only: never document contents, emails or IDs. Writes are
// updates of the one field, in batches of at most 400. A document deleted
// meanwhile (notifications expire after seven days) is skipped, never
// recreated.
import { FieldPath } from 'firebase-admin/firestore';
import { parseOpsArgs } from './profile-privacy.mjs';
import { opsFirestore } from './credentials.mjs';
import { backfillDecision, memberUidByEmail, needsMemberLookup } from './notification-audience.mjs';

const PAGE_SIZE = 400;
const NOT_FOUND = 5;

const options = parseOpsArgs(process.argv.slice(2), process.env);
const { projectId, apply } = options;
const { db, label } = await opsFirestore(options);
const target = process.env.FIRESTORE_EMULATOR_HOST ? `emulator ${process.env.FIRESTORE_EMULATOR_HOST}` : 'live Firestore';
console.log(`Project ${projectId} (${target}, ${label}). Mode: ${apply ? 'APPLY (audience will be written)' : 'dry run (no writes)'}.`);

const totals = { households: 0, scanned: 0, present: 0, uid: 0, email: 0, everyone: 0, unresolvable: 0, written: 0, gone: 0 };

// One batch per page. If it fails because a document expired meanwhile, each
// update is retried on its own so the rest of the page is not lost.
const writePage = async writes => {
  if (writes.length === 0) return;
  const batch = db.batch();
  for (const [ref, audience] of writes) batch.update(ref, { audience });
  try {
    await batch.commit();
    totals.written += writes.length;
    return;
  } catch (error) {
    if (error?.code !== NOT_FOUND) throw error;
  }
  for (const [ref, audience] of writes) {
    try {
      await ref.update({ audience });
      totals.written += 1;
    } catch (error) {
      if (error?.code !== NOT_FOUND) throw error;
      totals.gone += 1;
    }
  }
};

const backfillHousehold = async household => {
  let uidForEmail = null;
  let cursor = null;
  for (;;) {
    let page = household.ref.collection('notifications')
      .select('audience', 'targetUserUid', 'targetUserEmail')
      .orderBy(FieldPath.documentId()).limit(PAGE_SIZE);
    if (cursor) page = page.startAfter(cursor);
    const snapshot = await page.get();
    if (snapshot.empty) break;

    const writes = [];
    for (const notification of snapshot.docs) {
      const data = notification.data();
      totals.scanned += 1;
      if (needsMemberLookup(data) && !uidForEmail) {
        const members = await household.ref.collection('members').select('email').get();
        uidForEmail = memberUidByEmail(members.docs.map(member => ({ uid: member.id, email: member.get('email') })));
      }
      const decision = backfillDecision(data, uidForEmail ?? undefined);
      totals[decision.kind] += 1;
      if (decision.kind !== 'present') writes.push([notification.ref, decision.audience]);
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

const missing = totals.uid + totals.email + totals.everyone + totals.unresolvable;
console.log(`Households scanned: ${totals.households}`);
console.log(`Notifications scanned: ${totals.scanned}`);
console.log(`Already have an audience: ${totals.present}`);
console.log(`Missing an audience: ${missing}`);
console.log(`  targeted by uid: ${totals.uid}`);
console.log(`  targeted by email only, member found: ${totals.email}`);
console.log(`  household-wide: ${totals.everyone}`);
console.log(`  targeted by email only, no such member (audience left empty): ${totals.unresolvable}`);
console.log(apply
  ? `Notifications updated: ${totals.written}. Deleted meanwhile and skipped: ${totals.gone}.`
  : 'Dry run only. Re-run with --apply to write the field.');
