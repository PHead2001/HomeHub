// Removes the last email copies from documents housemates can read (member
// privacy release D; household-governance and chores READMEs). After it, a
// member's email is stored in the household only in their protected contact
// document (`members/{uid}/private/contact`):
// - membership records: `email`, once the member's contact document holds the
//   same email. Each record is re-read with its contact document and updated in
//   one transaction; a record without one keeps its email and is counted (run
//   scripts/ops/backfill-member-contact.mjs, then this again);
// - households: the legacy `memberEmails` list and `ownerEmail` (as release C's
//   scrub-shared-emails.mjs, for anything written since);
// - chores and chore templates: every `assignedToEmail` (completed chores
//   included: the yearly stats credit by uid now), after setting
//   `assignedToUid` where it was missing or stale, and the server-written
//   `completedByEmail` (after setting `completedByUid` if it was missing).
//   A completed chore whose credited person (its completer, else its assignee)
//   has left and is named only by that email is credited to that person's
//   identity instead (`completedByUid` or `assignedToUid`): their uid when the
//   chores pair their email with exactly one, else their former-member key
//   (./former-member-key.mjs; decisions and the per-household secret stored in
//   `households/{id}/ops/former-members`, which no client can read, before
//   use; a dry run stores nothing). Before any chore is changed, the yearly
//   stats' legacy keys of current members and of these people are moved to the
//   same identities, as scripts/ops/rekey-chore-stats.mjs does, so a departed
//   person's archived and retained completions stay one score.
// Planners: ./member-email-scrub.mjs; steps: ./member-privacy-household.mjs.
//
// Run it after the release D app, functions and rules are live, before or
// after scripts/ops/rekey-chore-stats.mjs (which re-keys whatever is left). Documents already clean are left alone, so the script can be stopped
// and re-run at any time. Live notifications were scrubbed by release C's
// script; the rules no longer accept an email in a notification.
//
// Usage:
//   node scripts/ops/scrub-member-emails.mjs --project homehub-j91jb           # dry run: counts only
//   node scripts/ops/scrub-member-emails.mjs --project homehub-j91jb --apply   # removes the fields
//
// Auth: as scripts/ops/migrate-push-tokens.mjs (see ./credentials.mjs), including
// --firebase-tools-login. The account needs Firestore read/write.
//
// Output is counts only: never document contents, emails or IDs. Chore and
// household writes are updates in batches of at most 400, each guarded by the
// document's update time: a document changed (or deleted) since it was read is
// skipped and counted, never overwritten; the next run picks it up.
import { FieldPath, FieldValue } from 'firebase-admin/firestore';
import { parseOpsArgs } from './profile-privacy.mjs';
import { opsFirestore } from './credentials.mjs';
import { householdEmailScrubPlan } from './shared-email-scrub.mjs';
import { memberRecordEmailPlan } from './member-email-scrub.mjs';
import {
  householdLegacyKeys,
  householdStats,
  readHouseholdPeople,
  rekeyHouseholdStats,
  scrubChoreCollection,
  settleHouseholdFormerPeople,
  writeGuardedPage,
} from './member-privacy-household.mjs';

const PAGE_SIZE = 400;
const NOT_FOUND = 5;
const FAILED_PRECONDITION = 9;

const options = parseOpsArgs(process.argv.slice(2), process.env);
const { projectId, apply } = options;
const { db, label } = await opsFirestore(options);
const target = process.env.FIRESTORE_EMULATOR_HOST ? `emulator ${process.env.FIRESTORE_EMULATOR_HOST}` : 'live Firestore';
console.log(`Project ${projectId} (${target}, ${label}). Mode: ${apply ? 'APPLY (email fields will be removed)' : 'dry run (no writes)'}.`);

const choreCounts = () => ({ scanned: 0, clean: 0, kept: 0, scrub: 0, assignee: 0, completer: 0, former: 0, written: 0, changed: 0 });
const totals = {
  members: { scanned: 0, clean: 0, scrub: 0, 'no-contact': 0, mismatch: 0, written: 0, changed: 0 },
  households: { scanned: 0, clean: 0, scrub: 0, 'no-owner-uid': 0, written: 0, changed: 0 },
  chores: choreCounts(),
  'chore-templates': choreCounts(),
};
const statsTotals = { documents: 0, rekey: 0, moved: 0, written: 0, identities: 0 };

const skippable = error => error?.code === NOT_FOUND || error?.code === FAILED_PRECONDITION;

// Each record is decided and written from one transactional read of the record
// and its contact document, so the email is never removed from a member whose
// contact document is missing or holds another address.
const scrubMembers = async members => {
  const counts = totals.members;
  for (const member of members.docs) {
    counts.scanned += 1;
    try {
      const kind = await db.runTransaction(async tx => {
        const contactRef = member.ref.collection('private').doc('contact');
        const [record, contact] = await tx.getAll(member.ref, contactRef);
        if (!record.exists) return 'changed';
        const plan = memberRecordEmailPlan(record.data(), contact.exists ? contact.data() : null);
        if (apply && plan.kind === 'scrub') tx.update(member.ref, { email: FieldValue.delete() });
        return plan.kind;
      });
      if (kind === 'changed') counts.changed += 1;
      else {
        counts[kind] += 1;
        if (apply && kind === 'scrub') counts.written += 1;
      }
    } catch (error) {
      if (!skippable(error)) throw error;
      counts.changed += 1;
    }
  }
};

let householdCursor = null;
for (;;) {
  let page = db.collection('households').select('memberEmails', 'ownerEmail', 'ownerUid').orderBy(FieldPath.documentId()).limit(PAGE_SIZE);
  if (householdCursor) page = page.startAfter(householdCursor);
  const snapshot = await page.get();
  if (snapshot.empty) break;
  const householdWrites = [];
  for (const household of snapshot.docs) {
    totals.households.scanned += 1;
    // Emails (contact document first, else the record) to repair uids before removal.
    const people = await readHouseholdPeople(db, household.ref);
    const former = await settleHouseholdFormerPeople(db, household.ref, people, { apply });
    statsTotals.identities += former.added;
    // The stats first: once a chore's email is gone, its legacy key can no longer be matched.
    const stats = await rekeyHouseholdStats(db, await householdStats(household.ref), { apply, byLegacy: householdLegacyKeys(people, former) });
    for (const key of ['documents', 'rekey', 'moved', 'written']) statsTotals[key] += stats[key];
    const context = { apply, uidByEmail: people.uidByEmail, formerKeyOf: former.identityOf };
    await scrubChoreCollection(db, household.ref.collection('chores'), { ...context, counts: totals.chores });
    await scrubChoreCollection(db, household.ref.collection('chore-templates'), { ...context, counts: totals['chore-templates'] });
    await scrubMembers(people.members);
    const plan = householdEmailScrubPlan(household.data());
    totals.households[plan.kind] += 1;
    if (plan.kind === 'scrub') householdWrites.push({ ref: household.ref, plan, updateTime: household.updateTime });
  }
  if (apply) await writeGuardedPage(db, householdWrites, totals.households);
  householdCursor = snapshot.docs[snapshot.docs.length - 1];
  if (snapshot.size < PAGE_SIZE) break;
}

const report = {
  members: {
    clean: 'no email on the record',
    scrub: 'email removed (the contact document holds it)',
    'no-contact': 'kept: no contact document email (run backfill-member-contact.mjs, then this again)',
    mismatch: 'kept: the contact document holds another email (check by hand)',
  },
  households: { clean: 'no email stored', scrub: 'memberEmails / ownerEmail removed', 'no-owner-uid': 'no ownerUid (ownerEmail kept)' },
  chores: {
    clean: 'no email stored',
    scrub: 'emails removed',
    assignee: '  of which an assignee email (uid set or cleared first where needed)',
    completer: '  of which completedByEmail (completedByUid set first where missing)',
    former: '  of which credited to someone who left, now under their identity',
    kept: 'kept: credited to someone who left whose identity is not settled yet (re-run)',
  },
};
report['chore-templates'] = report.chores;
console.log(`yearly stats: ${statsTotals.documents} scanned; with legacy keys of members or people who left: ${statsTotals.rekey} (${statsTotals.moved} keys)`);
if (apply) console.log(`  updated: ${statsTotals.written}; identities of people who left stored: ${statsTotals.identities}`);
for (const [name, counts] of Object.entries(totals)) {
  console.log(`${name}: ${counts.scanned} scanned`);
  for (const [kind, text] of Object.entries(report[name])) console.log(`  ${text}: ${counts[kind]}`);
  if (apply) console.log(`  updated: ${counts.written}; changed or deleted meanwhile and skipped: ${counts.changed}`);
}
if (!apply) console.log('Dry run only. Re-run with --apply to remove the fields.');
