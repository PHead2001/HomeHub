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
//   has left and is named only by that email gets the person's opaque
//   former-member key instead (`completedByUid` or `assignedToUid`;
//   ./former-member-key.mjs), so their yearly credit is kept. The key comes
//   from a random per-household secret the script stores in
//   `households/{id}/ops/former-members` (which no client can read) before
//   the first --apply write that needs one; a dry run uses a throwaway secret
//   and stores nothing.
// Planners: ./member-email-scrub.mjs.
//
// Run it after the release D app, functions and rules are live and after
// scripts/ops/rekey-chore-stats.mjs (which reads members' emails to re-key the
// stats). Documents already clean are left alone, so the script can be stopped
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
import { householdEmailScrubPlan, householdUidsByEmail } from './shared-email-scrub.mjs';
import { choreMemberEmailPlan, memberRecordEmailPlan } from './member-email-scrub.mjs';
import { formerMemberKey, formerMemberSecret } from './former-member-key.mjs';

const PAGE_SIZE = 400;
const NOT_FOUND = 5;
const FAILED_PRECONDITION = 9;

const options = parseOpsArgs(process.argv.slice(2), process.env);
const { projectId, apply } = options;
const { db, label } = await opsFirestore(options);
const target = process.env.FIRESTORE_EMULATOR_HOST ? `emulator ${process.env.FIRESTORE_EMULATOR_HOST}` : 'live Firestore';
console.log(`Project ${projectId} (${target}, ${label}). Mode: ${apply ? 'APPLY (email fields will be removed)' : 'dry run (no writes)'}.`);

const CHORE_FIELDS = ['assignedToUid', 'assignedToEmail', 'recurrence', 'isCompleted', 'completedByUid', 'completedByEmail'];
const totals = {
  members: { scanned: 0, clean: 0, scrub: 0, 'no-contact': 0, mismatch: 0, written: 0, changed: 0 },
  households: { scanned: 0, clean: 0, scrub: 0, 'no-owner-uid': 0, written: 0, changed: 0 },
  chores: { scanned: 0, clean: 0, scrub: 0, assignee: 0, completer: 0, former: 0, written: 0, changed: 0 },
  'chore-templates': { scanned: 0, clean: 0, scrub: 0, assignee: 0, completer: 0, former: 0, written: 0, changed: 0 },
};
let secretsCreated = 0;

const skippable = error => error?.code === NOT_FOUND || error?.code === FAILED_PRECONDITION;

const updateArgs = plan => [
  ...Object.entries(plan.set ?? {}).flatMap(([field, value]) => [new FieldPath(field), value]),
  ...plan.remove.flatMap(path => [new FieldPath(...path), FieldValue.delete()]),
];

// One batch per page; if a document changed or was deleted meanwhile, each
// update is retried on its own so the rest of the page is kept.
const writePage = async (writes, counts) => {
  if (writes.length === 0) return;
  const batch = db.batch();
  for (const { ref, plan, updateTime } of writes) batch.update(ref, ...updateArgs(plan), { lastUpdateTime: updateTime });
  try {
    await batch.commit();
    counts.written += writes.length;
    return;
  } catch (error) {
    if (!skippable(error)) throw error;
  }
  for (const { ref, plan, updateTime } of writes) {
    try {
      await ref.update(...updateArgs(plan), { lastUpdateTime: updateTime });
      counts.written += 1;
    } catch (error) {
      if (!skippable(error)) throw error;
      counts.changed += 1;
    }
  }
};

const usesFormerKey = plan => plan.kind === 'scrub' && (plan.assignee === 'former' || plan.completer === 'former');

// `former`: the household's former-member secret ({ ref, secret, stored }). It is
// stored (or the one another run stored is adopted) before the first write that
// uses a key, so every key written is reproducible by later runs.
const scrubChores = async (collectionRef, name, uidByEmail, former) => {
  const counts = totals[name];
  let cursor = null;
  for (;;) {
    let page = collectionRef.select(...CHORE_FIELDS).orderBy(FieldPath.documentId()).limit(PAGE_SIZE);
    if (cursor) page = page.startAfter(cursor);
    const snapshot = await page.get();
    if (snapshot.empty) break;
    const planAll = () => snapshot.docs.map(record =>
      choreMemberEmailPlan(record.data(), uidByEmail, email => formerMemberKey(former.secret, email)));
    let plans = planAll();
    if (apply && !former.stored && plans.some(usesFormerKey)) {
      const result = await formerMemberSecret(former.ref, { create: true, candidate: former.secret, now: () => FieldValue.serverTimestamp() });
      if (result.created) secretsCreated += 1;
      const adopted = result.secret !== former.secret;
      Object.assign(former, { secret: result.secret, stored: true });
      if (adopted) plans = planAll();
    }
    const writes = [];
    for (const [index, record] of snapshot.docs.entries()) {
      counts.scanned += 1;
      const plan = plans[index];
      // With a key function every email is removable, so `kept` never occurs.
      if (plan.kind === 'kept') throw new Error('unexpected kept plan');
      counts[plan.kind] += 1;
      if (plan.kind !== 'scrub') continue;
      if (plan.assignee !== 'clean') counts.assignee += 1;
      if (plan.completer !== 'none' && plan.completer !== 'kept') counts.completer += 1;
      if (usesFormerKey(plan)) counts.former += 1;
      writes.push({ ref: record.ref, plan, updateTime: record.updateTime });
    }
    if (apply) await writePage(writes, counts);
    cursor = snapshot.docs[snapshot.docs.length - 1];
    if (snapshot.size < PAGE_SIZE) break;
  }
};

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
    const members = await household.ref.collection('members').get();
    const contacts = members.empty ? [] : await db.getAll(...members.docs.map(member => member.ref.collection('private').doc('contact')));
    const uidByEmail = householdUidsByEmail(members.docs.map((member, index) => ({
      uid: member.id,
      recordEmail: member.get('email'),
      contactEmail: contacts[index]?.exists ? contacts[index].get('email') : undefined,
    })));
    // Read only; stored once a chore of this household needs a key (scrubChores).
    const formerRef = household.ref.collection('ops').doc('former-members');
    const former = { ref: formerRef, ...(await formerMemberSecret(formerRef, { create: false })) };
    await scrubChores(household.ref.collection('chores'), 'chores', uidByEmail, former);
    await scrubChores(household.ref.collection('chore-templates'), 'chore-templates', uidByEmail, former);
    await scrubMembers(members);
    const plan = householdEmailScrubPlan(household.data());
    totals.households[plan.kind] += 1;
    if (plan.kind === 'scrub') householdWrites.push({ ref: household.ref, plan, updateTime: household.updateTime });
  }
  if (apply) await writePage(householdWrites, totals.households);
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
    former: '  of which credited to someone who left, now under a former-member key',
  },
};
report['chore-templates'] = report.chores;
for (const [name, counts] of Object.entries(totals)) {
  console.log(`${name}: ${counts.scanned} scanned`);
  for (const [kind, text] of Object.entries(report[name])) console.log(`  ${text}: ${counts[kind]}`);
  if (apply) console.log(`  updated: ${counts.written}; changed or deleted meanwhile and skipped: ${counts.changed}`);
}
if (apply) console.log(`former-member secrets created: ${secretsCreated}`);
if (!apply) console.log('Dry run only. Re-run with --apply to remove the fields.');
