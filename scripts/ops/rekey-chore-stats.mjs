// Re-keys yearly chore stats by account ID (member privacy release D; chores
// README, "Yearly stats"). `households/{id}/stats/chores-{year}` kept each
// person's purged completions under a key derived from their email (a slug of
// the local part plus a hash), which shows housemates the local part and lets
// them confirm a guessed address. Upkeep now writes `uid-<uid>` keys; this
// script moves the remaining legacy keys:
// - a current member's legacy key is folded into their uid key (their email
//   comes from their protected contact document, else, until the member-email
//   scrub runs, from their membership record);
// - a departed person's legacy key goes to their identity, the one
//   scripts/ops/scrub-member-emails.mjs gives their chores (their uid when the
//   chores pair their email with exactly one, else their former-member key;
//   ./former-member-key.mjs, decisions stored in households/{id}/ops/former-members
//   before use), so their archived and retained completions are one score;
// - a legacy key whose email no chore names any more goes to an opaque key of
//   its own (`unknownLegacyKey`), the same in every run.
// Totals (`completed`) are unchanged. Planners: ./chore-stats-rekey.mjs; steps:
// ./member-privacy-household.mjs.
//
// Run it after the release D app and functions are live, before or after
// scripts/ops/scrub-member-emails.mjs (which re-keys the stats of the people it
// scrubs the same way). Each stats document is re-read and written in its own
// transaction (upkeep writes the same documents in transactions), so a run can
// be stopped and repeated at any time; already re-keyed documents are left alone.
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
import {
  hasLegacyKeys,
  householdLegacyKeys,
  householdStats,
  readHouseholdPeople,
  rekeyHouseholdStats,
  settleHouseholdFormerPeople,
} from './member-privacy-household.mjs';

const PAGE_SIZE = 200;

const options = parseOpsArgs(process.argv.slice(2), process.env);
const { projectId, apply } = options;
const { db, label } = await opsFirestore(options);
const target = process.env.FIRESTORE_EMULATOR_HOST ? `emulator ${process.env.FIRESTORE_EMULATOR_HOST}` : 'live Firestore';
console.log(`Project ${projectId} (${target}, ${label}). Mode: ${apply ? 'APPLY (stats will be re-keyed)' : 'dry run (no writes)'}.`);

const totals = { households: 0, documents: 0, clean: 0, rekey: 0, moved: 0, unknown: 0, written: 0, identities: 0 };

let cursor = null;
for (;;) {
  let page = db.collection('households').select().orderBy(FieldPath.documentId()).limit(PAGE_SIZE);
  if (cursor) page = page.startAfter(cursor);
  const snapshot = await page.get();
  if (snapshot.empty) break;
  for (const household of snapshot.docs) {
    totals.households += 1;
    const stats = await householdStats(household.ref);
    if (!hasLegacyKeys(stats)) {
      totals.documents += stats.length;
      totals.clean += stats.length;
      continue;
    }
    const people = await readHouseholdPeople(db, household.ref);
    const former = await settleHouseholdFormerPeople(db, household.ref, people, { apply, needSecret: true });
    totals.identities += former.added;
    const counts = await rekeyHouseholdStats(db, stats, { apply, byLegacy: householdLegacyKeys(people, former), unknownKeyOf: former.unknownKeyOf });
    for (const [key, value] of Object.entries(counts)) totals[key] += value;
  }
  cursor = snapshot.docs[snapshot.docs.length - 1];
  if (snapshot.size < PAGE_SIZE) break;
}

console.log(`households: ${totals.households} scanned`);
console.log(`stats documents: ${totals.documents} scanned`);
console.log(`  already keyed by uid: ${totals.clean}`);
console.log(`  with legacy keys: ${totals.rekey}`);
console.log(`  legacy keys of current members or of people who left (named on chores) moved to their identity: ${totals.moved}`);
console.log(`  legacy keys of nobody named any more moved to an opaque key: ${totals.unknown}`);
if (apply) console.log(`  updated: ${totals.written}; identities of people who left stored: ${totals.identities}`);
else console.log('Dry run only. Re-run with --apply to re-key the stats.');
