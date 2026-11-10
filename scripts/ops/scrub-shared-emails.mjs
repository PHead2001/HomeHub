// Removes email copies from documents every household member can read (member
// privacy release C; household-governance, chores and notifications READMEs):
// - chores and chore templates: `assignedToEmail` (and a template's
//   `recurrence.assignedToEmail`), after setting `assignedToUid` to the member
//   the email names where it was missing or stale. A completed chore without a
//   recorded completer keeps its email until upkeep moves it into the yearly
//   stats (90 days), which still credit it by email. Templates then generate by
//   uid; days already generated are never generated again (occurrence keys);
// - live notifications: `targetUserEmail` (after naming the member by
//   `targetUserUid`; a target who is no longer a member keeps it, as removing it
//   would address the notification to everyone; notifications expire within
//   seven days) and the emails in `readBy`, `dismissedBy` and `resolvedBy`;
// - households: the legacy `memberEmails` list and `ownerEmail`;
// - yearly chore stats: `names` labels that are an email.
// Membership records keep their `email` until release D's rules no longer
// require it. Planners: ./shared-email-scrub.mjs.
//
// Run it after the release C app and functions are live (nothing writes these
// fields any more), and once more a few days later for documents written by
// browsers still on older builds. Documents already clean are left alone, so
// the script can be stopped and re-run at any time.
//
// Usage:
//   node scripts/ops/scrub-shared-emails.mjs --project homehub-j91jb           # dry run: counts only
//   node scripts/ops/scrub-shared-emails.mjs --project homehub-j91jb --apply   # removes the fields
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
import {
  choreEmailScrubPlan,
  householdEmailScrubPlan,
  householdUidsByEmail,
  notificationEmailScrubPlan,
  statsEmailScrubPlan,
} from './shared-email-scrub.mjs';

const PAGE_SIZE = 400;
const NOT_FOUND = 5;
const FAILED_PRECONDITION = 9;

const options = parseOpsArgs(process.argv.slice(2), process.env);
const { projectId, apply } = options;
const { db, label } = await opsFirestore(options);
const target = process.env.FIRESTORE_EMULATOR_HOST ? `emulator ${process.env.FIRESTORE_EMULATOR_HOST}` : 'live Firestore';
console.log(`Project ${projectId} (${target}, ${label}). Mode: ${apply ? 'APPLY (email fields will be removed)' : 'dry run (no writes)'}.`);

const SECTIONS = {
  chores: { kinds: ['clean', 'credit', 'scrub', 'repaired', 'cleared'], fields: ['assignedToUid', 'assignedToEmail', 'recurrence', 'isCompleted', 'completedByEmail'] },
  'chore-templates': { kinds: ['clean', 'scrub', 'repaired', 'cleared'], fields: ['assignedToUid', 'assignedToEmail', 'recurrence'] },
  notifications: { kinds: ['clean', 'scrub', 'retargeted', 'unresolvable'], fields: ['audience', 'targetUserUid', 'targetUserEmail', 'readBy', 'dismissedBy', 'resolvedBy'] },
  stats: { kinds: ['clean', 'scrub'], fields: ['names'] },
  households: { kinds: ['clean', 'scrub', 'no-owner-uid'] },
};
const totals = Object.fromEntries(Object.entries(SECTIONS).map(([name, { kinds }]) => [
  name, { scanned: 0, ...Object.fromEntries(kinds.map(kind => [kind, 0])), written: 0, changed: 0 },
]));

const skippable = error => error?.code === NOT_FOUND || error?.code === FAILED_PRECONDITION;

// Field/value pairs for one update: sets first, then deletions.
const updateArgs = plan => [
  ...Object.entries(plan.set ?? {}).flatMap(([field, value]) => [new FieldPath(field), value]),
  ...plan.remove.flatMap(path => [new FieldPath(...path), FieldValue.delete()]),
];
const writable = plan => Array.isArray(plan.remove) && (plan.remove.length > 0 || Object.keys(plan.set ?? {}).length > 0);

// One batch per page. If it fails because a document changed or was deleted
// meanwhile, each update is retried on its own so the rest of the page is kept.
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

const scrubCollection = async (collectionRef, name, decide) => {
  const counts = totals[name];
  let cursor = null;
  for (;;) {
    let page = collectionRef.select(...SECTIONS[name].fields).orderBy(FieldPath.documentId()).limit(PAGE_SIZE);
    if (cursor) page = page.startAfter(cursor);
    const snapshot = await page.get();
    if (snapshot.empty) break;
    const writes = [];
    for (const record of snapshot.docs) {
      counts.scanned += 1;
      const plan = decide(record.data());
      counts[plan.kind] += 1;
      if (writable(plan)) writes.push({ ref: record.ref, plan, updateTime: record.updateTime });
    }
    if (apply) await writePage(writes, counts);
    cursor = snapshot.docs[snapshot.docs.length - 1];
    if (snapshot.size < PAGE_SIZE) break;
  }
};

// Members' emails: the protected contact document first, else the record.
const memberEmails = async householdRef => {
  const members = await householdRef.collection('members').select('email').get();
  const contacts = members.empty ? [] : await db.getAll(...members.docs.map(member => member.ref.collection('private').doc('contact')));
  return householdUidsByEmail(members.docs.map((member, index) => ({
    uid: member.id,
    recordEmail: member.get('email'),
    contactEmail: contacts[index]?.exists ? contacts[index].get('email') : undefined,
  })));
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
    const uidByEmail = await memberEmails(household.ref);
    await scrubCollection(household.ref.collection('chores'), 'chores', data => choreEmailScrubPlan(data, uidByEmail));
    await scrubCollection(household.ref.collection('chore-templates'), 'chore-templates', data => choreEmailScrubPlan(data, uidByEmail));
    await scrubCollection(household.ref.collection('notifications'), 'notifications', data => notificationEmailScrubPlan(data, uidByEmail));
    await scrubCollection(household.ref.collection('stats'), 'stats', statsEmailScrubPlan);
    const plan = householdEmailScrubPlan(household.data());
    totals.households[plan.kind] += 1;
    if (writable(plan)) householdWrites.push({ ref: household.ref, plan, updateTime: household.updateTime });
  }
  if (apply) await writePage(householdWrites, totals.households);
  householdCursor = snapshot.docs[snapshot.docs.length - 1];
  if (snapshot.size < PAGE_SIZE) break;
}

const LABELS = {
  clean: 'no email stored',
  credit: 'completed without a recorded completer (email kept for the yearly stats)',
  scrub: 'email removed',
  repaired: 'email removed after setting the uid it names',
  cleared: 'email of a former member removed and a leftover uid cleared',
  retargeted: 'email-only target named by uid, then email removed',
  unresolvable: 'email-only target no longer a member (target kept; expires within 7 days)',
  'no-owner-uid': 'no ownerUid (ownerEmail kept)',
};
for (const [name, counts] of Object.entries(totals)) {
  console.log(`${name}: ${counts.scanned} scanned`);
  for (const kind of SECTIONS[name].kinds) console.log(`  ${LABELS[kind]}: ${counts[kind]}`);
  if (apply) console.log(`  updated: ${counts.written}; changed or deleted meanwhile and skipped: ${counts.changed}`);
}
if (!apply) console.log('Dry run only. Re-run with --apply to remove the fields.');
