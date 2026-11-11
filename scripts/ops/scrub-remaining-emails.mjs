// Removes the last email copies from documents housemates can read (member
// privacy release E; household-governance README, "Email copies"; chores,
// pets and maintenance-center READMEs):
// - chores and chore templates: any assignee or completer email still stored,
//   as scripts/ops/scrub-member-emails.mjs (for anything written since): a
//   completion credited to someone who has left gets their former-member key
//   (./former-member-key.mjs; the household's secret in
//   `households/{id}/ops/former-members`, stored before the first write that
//   needs one, the same secret that script uses);
// - labels that are an email (written before release A, or from a profile
//   whose name is an email): chores' `assignedToDisplayName` and
//   `completedByName`, templates' `assignedToDisplayName`, maintenance
//   attachments' `uploadedByName`, pet logs' `loggedByName` (feeding,
//   medication, care) and the feeding state's `lastFedByName` (also inside
//   `prev`). Each becomes the current public name of the uid next to it, else
//   "Member" ("Someone" on pet labels, "Unassigned" for an assignee label
//   without a uid);
// - membership records: a `displayName` that is an email, and an `avatarUrl`
//   in an email-named photo folder (`users/{email}/avatars/...`) are removed.
//   A record that still holds `email` is only counted: run
//   scripts/ops/backfill-member-contact.mjs, then scripts/ops/scrub-member-emails.mjs.
// Planners: ./remaining-email-scrub.mjs.
//
// Run it after the release E app and functions are live. Documents already
// clean are left alone, so the script can be stopped and re-run at any time.
//
// Usage:
//   node scripts/ops/scrub-remaining-emails.mjs --project homehub-j91jb           # dry run: counts only
//   node scripts/ops/scrub-remaining-emails.mjs --project homehub-j91jb --apply   # rewrites the fields
//
// Auth: as scripts/ops/migrate-push-tokens.mjs (see ./credentials.mjs), including
// --firebase-tools-login. The account needs Firestore read/write.
//
// Output is counts only: never document contents, emails or IDs. Writes are
// updates in batches of at most 400, each guarded by the document's update
// time: a document changed (or deleted) since it was read is skipped and
// counted, never overwritten; the next run picks it up.
import { FieldPath, FieldValue } from 'firebase-admin/firestore';
import { parseOpsArgs } from './profile-privacy.mjs';
import { opsFirestore } from './credentials.mjs';
import { householdUidsByEmail } from './shared-email-scrub.mjs';
import {
  choreRemainingEmailPlan,
  labelEmailPlan,
  memberRecordRemainingPlan,
  publicNamesByUid,
  templateRemainingEmailPlan,
} from './remaining-email-scrub.mjs';
import { formerMemberKey, formerMemberSecret } from './former-member-key.mjs';

const PAGE_SIZE = 400;
const NOT_FOUND = 5;
const FAILED_PRECONDITION = 9;

const options = parseOpsArgs(process.argv.slice(2), process.env);
const { projectId, apply } = options;
const { db, label } = await opsFirestore(options);
const target = process.env.FIRESTORE_EMULATOR_HOST ? `emulator ${process.env.FIRESTORE_EMULATOR_HOST}` : 'live Firestore';
console.log(`Project ${projectId} (${target}, ${label}). Mode: ${apply ? 'APPLY (email copies will be replaced)' : 'dry run (no writes)'}.`);

const CHORE_FIELDS = [
  'assignedToUid', 'assignedToEmail', 'assignedToDisplayName', 'recurrence', 'isCompleted',
  'completedByUid', 'completedByEmail', 'completedByName',
];
const SECTIONS = {
  chores: CHORE_FIELDS,
  'chore-templates': ['assignedToUid', 'assignedToEmail', 'assignedToDisplayName', 'recurrence'],
  'maintenance-attachments': ['uploadedByUid', 'uploadedByName'],
  'pet-logs': ['loggedByUid', 'loggedByName'],
  'feeding-state': ['lastFedByUid', 'lastFedByName', 'prev'],
};
const empty = () => ({ scanned: 0, clean: 0, scrub: 0, emails: 0, former: 0, labels: 0, written: 0, changed: 0 });
const totals = Object.fromEntries(Object.keys(SECTIONS).map(name => [name, empty()]));
totals.members = { scanned: 0, clean: 0, scrub: 0, displayName: 0, avatarUrl: 0, recordEmail: 0, written: 0, changed: 0 };

const skippable = error => error?.code === NOT_FOUND || error?.code === FAILED_PRECONDITION;

const updateArgs = plan => [
  ...plan.set.flatMap(([path, value]) => [new FieldPath(...path), value]),
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

let secretsCreated = 0;

// `former` (chores and templates only): the household's former-member secret
// ({ ref, secret, stored }). It is stored, or the one another run stored is
// adopted (and the page decided again), before the first write that uses a key.
const scrubCollection = async (query, name, decide, former) => {
  const counts = totals[name];
  let cursor = null;
  for (;;) {
    let page = query.select(...SECTIONS[name]).orderBy(FieldPath.documentId()).limit(PAGE_SIZE);
    if (cursor) page = page.startAfter(cursor);
    const snapshot = await page.get();
    if (snapshot.empty) break;
    let plans = snapshot.docs.map(record => decide(record.data()));
    if (apply && former && !former.stored && plans.some(plan => plan.former)) {
      const result = await formerMemberSecret(former.ref, { create: true, candidate: former.secret, now: () => FieldValue.serverTimestamp() });
      if (result.created) secretsCreated += 1;
      const adopted = result.secret !== former.secret;
      Object.assign(former, { secret: result.secret, stored: true });
      if (adopted) plans = snapshot.docs.map(record => decide(record.data()));
    }
    const writes = [];
    for (const [index, record] of snapshot.docs.entries()) {
      counts.scanned += 1;
      const plan = plans[index];
      counts[plan.kind] += 1;
      if (plan.kind !== 'scrub') continue;
      if (plan.emails) counts.emails += 1;
      if (plan.former) counts.former += 1;
      if (plan.labels) counts.labels += 1;
      writes.push({ ref: record.ref, plan, updateTime: record.updateTime });
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
    const members = await household.ref.collection('members').get();
    const contacts = members.empty ? [] : await db.getAll(...members.docs.map(member => member.ref.collection('private').doc('contact')));
    const uidByEmail = householdUidsByEmail(members.docs.map((member, index) => ({
      uid: member.id,
      recordEmail: member.get('email'),
      contactEmail: contacts[index]?.exists ? contacts[index].get('email') : undefined,
    })));
    const namesByUid = publicNamesByUid(members.docs.map(member => ({ uid: member.id, displayName: member.get('displayName') })));
    const formerRef = household.ref.collection('ops').doc('former-members');
    const former = { ref: formerRef, ...(await formerMemberSecret(formerRef, { create: false })) };
    const context = { uidByEmail, namesByUid, formerKeyOf: email => formerMemberKey(former.secret, email) };

    const memberWrites = [];
    for (const member of members.docs) {
      totals.members.scanned += 1;
      const plan = memberRecordRemainingPlan(member.data());
      totals.members[plan.kind] += 1;
      if (plan.email) totals.members.recordEmail += 1;
      if (plan.kind !== 'scrub') continue;
      if (plan.remove.some(path => path[0] === 'displayName')) totals.members.displayName += 1;
      if (plan.remove.some(path => path[0] === 'avatarUrl')) totals.members.avatarUrl += 1;
      memberWrites.push({ ref: member.ref, plan, updateTime: member.updateTime });
    }
    if (apply) await writePage(memberWrites, totals.members);

    await scrubCollection(household.ref.collection('chores'), 'chores', data => choreRemainingEmailPlan(data, context), former);
    await scrubCollection(household.ref.collection('chore-templates'), 'chore-templates', data => templateRemainingEmailPlan(data, context), former);
    await scrubCollection(household.ref.collection('maintenance-attachments'), 'maintenance-attachments',
      data => labelEmailPlan(data, 'maintenance-attachments', namesByUid));
    const pets = await household.ref.collection('pets').select().get();
    for (const pet of pets.docs) {
      for (const logs of ['feeding-logs', 'medication-logs', 'care-logs']) {
        await scrubCollection(pet.ref.collection(logs), 'pet-logs', data => labelEmailPlan(data, 'pet-logs', namesByUid));
      }
      await scrubCollection(pet.ref.collection('feeding-state'), 'feeding-state', data => labelEmailPlan(data, 'feeding-state', namesByUid));
    }
  }
  householdCursor = snapshot.docs[snapshot.docs.length - 1];
  if (snapshot.size < PAGE_SIZE) break;
}

for (const [name, counts] of Object.entries(totals)) {
  console.log(`${name}: ${counts.scanned} scanned; clean: ${counts.clean}; to rewrite: ${counts.scrub}`);
  if (name === 'members') {
    console.log(`  name that is an email (removed): ${counts.displayName}; photo in an email-named folder (removed): ${counts.avatarUrl}`);
    console.log(`  record still holding email (not changed here; run backfill-member-contact.mjs, then scrub-member-emails.mjs): ${counts.recordEmail}`);
  } else {
    console.log(`  with an assignee or completer email: ${counts.emails}; credited to someone who left, now under a former-member key: ${counts.former}; with an email label: ${counts.labels}`);
  }
  if (apply) console.log(`  updated: ${counts.written}; changed or deleted meanwhile and skipped: ${counts.changed}`);
}
if (apply) console.log(`former-member secrets created: ${secretsCreated}`);
if (!apply) console.log('Dry run only. Re-run with --apply to rewrite the fields.');
