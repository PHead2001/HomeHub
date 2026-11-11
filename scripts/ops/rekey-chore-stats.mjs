// Re-keys yearly chore stats by account ID (member privacy release D; chores
// README, "Yearly stats"). `households/{id}/stats/chores-{year}` kept each
// person's purged completions under a key derived from their email (a slug of
// the local part plus a hash), which shows housemates the local part and lets
// them confirm a guessed address. Upkeep now writes `uid-<uid>` keys; this
// script moves the remaining legacy keys:
// - a current member's legacy key is folded into their uid key (their email
//   comes from their protected contact document, else, until the member-email
//   scrub runs, from their membership record);
// - any other legacy key (someone who has left) becomes an opaque `former-<n>`
//   key with the same count and label.
// Totals (`completed`) are unchanged. Planners: ./chore-stats-rekey.mjs.
//
// Run it after the release D app and functions are live, before
// scripts/ops/scrub-member-emails.mjs. Each stats document is re-read and
// written in its own transaction (upkeep writes the same documents in
// transactions), so a run can be stopped and repeated at any time; already
// re-keyed documents are left alone.
//
// Usage:
//   node scripts/ops/rekey-chore-stats.mjs --project homehub-j91jb           # dry run: counts only
//   node scripts/ops/rekey-chore-stats.mjs --project homehub-j91jb --apply   # re-keys the stats
//
// Auth: as scripts/ops/migrate-push-tokens.mjs (see ./credentials.mjs), including
// --firebase-tools-login. The account needs Firestore read/write.
//
// Output is counts only: never document contents, emails or IDs.
import { FieldPath } from 'firebase-admin/firestore';
import { parseOpsArgs } from './profile-privacy.mjs';
import { opsFirestore } from './credentials.mjs';
import { legacyKeyMap, statsRekeyPlan } from './chore-stats-rekey.mjs';

const PAGE_SIZE = 200;
const STATS_ID = /^chores-\d{4}$/;

const options = parseOpsArgs(process.argv.slice(2), process.env);
const { projectId, apply } = options;
const { db, label } = await opsFirestore(options);
const target = process.env.FIRESTORE_EMULATOR_HOST ? `emulator ${process.env.FIRESTORE_EMULATOR_HOST}` : 'live Firestore';
console.log(`Project ${projectId} (${target}, ${label}). Mode: ${apply ? 'APPLY (stats will be re-keyed)' : 'dry run (no writes)'}.`);

const totals = { households: 0, documents: 0, clean: 0, rekey: 0, memberKeys: 0, formerKeys: 0, written: 0 };

const householdMembers = async householdRef => {
  const members = await householdRef.collection('members').get();
  const contacts = members.empty ? [] : await db.getAll(...members.docs.map(member => member.ref.collection('private').doc('contact')));
  return members.docs.map((member, index) => {
    const contactEmail = contacts[index]?.exists ? contacts[index].get('email') : undefined;
    return { uid: member.id, email: typeof contactEmail === 'string' && contactEmail.trim() ? contactEmail : member.get('email') };
  });
};

let cursor = null;
for (;;) {
  let page = db.collection('households').select().orderBy(FieldPath.documentId()).limit(PAGE_SIZE);
  if (cursor) page = page.startAfter(cursor);
  const snapshot = await page.get();
  if (snapshot.empty) break;
  for (const household of snapshot.docs) {
    totals.households += 1;
    const stats = (await household.ref.collection('stats').get()).docs.filter(d => STATS_ID.test(d.id));
    if (stats.length === 0) continue;
    const byLegacy = legacyKeyMap(await householdMembers(household.ref));
    for (const statsDoc of stats) {
      totals.documents += 1;
      // Planned and (with --apply) written from the same transactional read.
      const plan = await db.runTransaction(async tx => {
        const fresh = await tx.get(statsDoc.ref);
        const decision = statsRekeyPlan(fresh.exists ? fresh.data() : null, byLegacy);
        if (apply && decision.kind === 'rekey') {
          tx.update(statsDoc.ref, { byAssignee: decision.byAssignee, names: decision.names });
        }
        return decision;
      });
      totals[plan.kind] += 1;
      if (plan.kind === 'rekey') {
        totals.memberKeys += plan.members;
        totals.formerKeys += plan.former;
        if (apply) totals.written += 1;
      }
    }
  }
  cursor = snapshot.docs[snapshot.docs.length - 1];
  if (snapshot.size < PAGE_SIZE) break;
}

console.log(`households: ${totals.households} scanned`);
console.log(`stats documents: ${totals.documents} scanned`);
console.log(`  already keyed by uid: ${totals.clean}`);
console.log(`  with legacy keys: ${totals.rekey}`);
console.log(`  legacy keys of current members folded into their uid key: ${totals.memberKeys}`);
console.log(`  legacy keys of people who left replaced with an opaque key: ${totals.formerKeys}`);
if (apply) console.log(`  updated: ${totals.written}`);
else console.log('Dry run only. Re-run with --apply to re-key the stats.');
