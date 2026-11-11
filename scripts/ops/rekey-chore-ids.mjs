// Moves generated chores to email-free document ids (member privacy release E;
// chores README, "Assignee identity"). Upkeep used to store each generated
// chore under `stableSlugify(templateId-roomId-day-<assignee>)`, where the
// assignee part was the template's email (or uid), so anyone who can list
// chores could read the slug of a housemate's email in the ids. From release E
// upkeep generates `stableSlugify(templateId-roomId-day)`; this script moves
// every stored chore that still has an assignee part to that id:
// - one transaction per chore: it re-reads the household, the chore and the
//   target ids, creates the same document under the new id and deletes the old
//   one. Every field is kept as stored (assignee, completion attribution,
//   `completedAtServer`, `occurrenceKey`, ...); `occurrenceKey` is added when
//   the chore had none and its id names it;
// - a chore changed or deleted since this run read it is skipped and counted
//   (the next run picks it up); nothing is written for a household being
//   deleted;
// - a day that already has a chore under the new id (two chores for one day,
//   from before upkeep checked occurrence keys) moves to `<id>-2` .. `<id>-9`;
// - one-time chores (auto ids) and chores whose id is not a generated id are
//   left alone and counted.
// Nothing else refers to a generated chore id: notifications name one-time
// chores (their own auto ids), templates or days, never a generated id. A page
// that listed a chore just before it moved acts on the old id once, like on a
// chore deleted meanwhile: completion, Undo and reopen report it missing and
// the page lists again; a direct edit (calendar move, sub-task tick) shows its
// error and changes nothing.
//
// Run it after the release E functions and app are live (upkeep then never
// generates the old shape again). Chores already moved are left alone, so the
// script can be stopped and re-run at any time.
//
// Usage:
//   node scripts/ops/rekey-chore-ids.mjs --project homehub-j91jb           # dry run: counts only
//   node scripts/ops/rekey-chore-ids.mjs --project homehub-j91jb --apply   # moves the chores
//
// Auth: as scripts/ops/migrate-push-tokens.mjs (see ./credentials.mjs), including
// --firebase-tools-login. The account needs Firestore read/write.
//
// Output is counts only: never document contents, emails or IDs.
import { FieldPath } from 'firebase-admin/firestore';
import { parseOpsArgs } from './profile-privacy.mjs';
import { opsFirestore } from './credentials.mjs';
import { stableSlugify } from './occurrence-key.mjs';
import { choreIdRekeyPlan } from './chore-id-rekey.mjs';
import { moveChoreToOccurrenceId } from './chore-id-move.mjs';

const PAGE_SIZE = 400;

const options = parseOpsArgs(process.argv.slice(2), process.env);
const { projectId, apply } = options;
const { db, label } = await opsFirestore(options);
const target = process.env.FIRESTORE_EMULATOR_HOST ? `emulator ${process.env.FIRESTORE_EMULATOR_HOST}` : 'live Firestore';
console.log(`Project ${projectId} (${target}, ${label}). Mode: ${apply ? 'APPLY (chores will be moved to new ids)' : 'dry run (no writes)'}.`);

const totals = {
  households: 0, scanned: 0, 'one-time': 0, current: 0, unrecognized: 0, rekey: 0, uid: 0, other: 0,
  moved: 0, duplicate: 0, changed: 0, 'no-free-id': 0, stopped: 0,
};

const rekeyHousehold = async householdRef => {
  const members = await householdRef.collection('members').select().get();
  const memberUidSlugs = new Set(members.docs.map(member => stableSlugify(member.id)));
  let cursor = null;
  for (;;) {
    let page = householdRef.collection('chores')
      .select('templateId', 'roomIds', 'sourceType', 'occurrenceKey')
      .orderBy(FieldPath.documentId()).limit(PAGE_SIZE);
    if (cursor) page = page.startAfter(cursor);
    const snapshot = await page.get();
    if (snapshot.empty) break;
    for (const chore of snapshot.docs) {
      totals.scanned += 1;
      const plan = choreIdRekeyPlan(chore.id, chore.data(), memberUidSlugs);
      totals[plan.kind] += 1;
      if (plan.kind !== 'rekey') continue;
      totals[plan.suffix] += 1;
      if (!apply) continue;
      const outcome = await moveChoreToOccurrenceId(db, chore.ref, chore.updateTime, plan);
      totals[outcome] += 1;
      if (outcome === 'stopped') return;
    }
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
    await rekeyHousehold(household.ref);
  }
  householdCursor = snapshot.docs[snapshot.docs.length - 1];
  if (snapshot.size < PAGE_SIZE) break;
}

console.log(`Households: ${totals.households}. Chores scanned: ${totals.scanned}.`);
console.log(`  one-time or not generated (left alone): ${totals['one-time']}`);
console.log(`  already under an email-free id: ${totals.current}`);
console.log(`  generated, id not recognized (left alone): ${totals.unrecognized}`);
console.log(`  to move: ${totals.rekey} (assignee part a member's uid: ${totals.uid}; an email or a former member: ${totals.other})`);
if (apply) {
  console.log(`  moved: ${totals.moved}; moved to a numbered id (day already had a chore): ${totals.duplicate}`);
  console.log(`  changed or deleted meanwhile and skipped: ${totals.changed}; no free id: ${totals['no-free-id']}; household being deleted: ${totals.stopped}`);
} else {
  console.log('Dry run only. Re-run with --apply to move the chores.');
}
