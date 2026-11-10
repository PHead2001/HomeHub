// Writes each member's protected contact document,
// `households/{id}/members/{uid}/private/contact` (`{ email, updatedAt }`),
// from the email on their membership record (household-governance README,
// "Member contact"). The server writes it on join, creation and approval from
// release B on; this script covers everyone who joined before. A contact
// document that already holds the record's email is left alone, one that holds
// another email is updated, and a record without an email is skipped, so the
// script can be stopped and re-run at any time. Run it after the rules and
// functions of release B are deployed, before any release stops writing the
// email to the membership record.
//
// Usage:
//   node scripts/ops/backfill-member-contact.mjs --project homehub-j91jb           # dry run: counts only
//   node scripts/ops/backfill-member-contact.mjs --project homehub-j91jb --apply   # writes the documents
//
// Auth: as scripts/ops/migrate-push-tokens.mjs (see ./credentials.mjs), including
// --firebase-tools-login. The account needs Firestore read/write.
//
// Output is counts only: never document contents, emails or IDs. Each write
// runs in its own transaction that re-reads the membership record and the
// contact document, so a member who left meanwhile gets no document and a
// document written meanwhile by the server is not overwritten with older data.
import { FieldPath } from 'firebase-admin/firestore';
import { parseOpsArgs } from './profile-privacy.mjs';
import { opsFirestore } from './credentials.mjs';
import { contactBackfillDecision, contactDocument } from './member-contact.mjs';

const PAGE_SIZE = 300;

const options = parseOpsArgs(process.argv.slice(2), process.env);
const { projectId, apply } = options;
const { db, label } = await opsFirestore(options);
const target = process.env.FIRESTORE_EMULATOR_HOST ? `emulator ${process.env.FIRESTORE_EMULATOR_HOST}` : 'live Firestore';
console.log(`Project ${projectId} (${target}, ${label}). Mode: ${apply ? 'APPLY (contact documents will be written)' : 'dry run (no writes)'}.`);

const totals = { households: 0, members: 0, 'no-email': 0, present: 0, missing: 0, different: 0, created: 0, updated: 0, skipped: 0 };

const contactRef = memberRef => memberRef.collection('private').doc('contact');

// Re-reads both documents and writes only if the decision still calls for it.
const writeContact = memberRef => db.runTransaction(async transaction => {
  const [member, contact] = await Promise.all([transaction.get(memberRef), transaction.get(contactRef(memberRef))]);
  if (!member.exists) return 'skipped';
  const decision = contactBackfillDecision(member.data(), contact.exists ? contact.data() : null);
  if (decision.kind !== 'missing' && decision.kind !== 'different') return 'skipped';
  const data = contactDocument(decision.email, new Date());
  if (decision.kind === 'missing') transaction.create(contactRef(memberRef), data);
  else transaction.set(contactRef(memberRef), data);
  return decision.kind === 'missing' ? 'created' : 'updated';
});

let householdCursor = null;
for (;;) {
  let page = db.collection('households').select().orderBy(FieldPath.documentId()).limit(PAGE_SIZE);
  if (householdCursor) page = page.startAfter(householdCursor);
  const snapshot = await page.get();
  if (snapshot.empty) break;
  for (const household of snapshot.docs) {
    totals.households += 1;
    const members = await household.ref.collection('members').select('email').get();
    if (members.empty) continue;
    const contacts = await db.getAll(...members.docs.map(member => contactRef(member.ref)));
    for (const [index, member] of members.docs.entries()) {
      totals.members += 1;
      const contact = contacts[index];
      const decision = contactBackfillDecision(member.data(), contact.exists ? contact.data() : null);
      totals[decision.kind] += 1;
      if (apply && (decision.kind === 'missing' || decision.kind === 'different')) {
        totals[await writeContact(member.ref)] += 1;
      }
    }
  }
  householdCursor = snapshot.docs[snapshot.docs.length - 1];
  if (snapshot.size < PAGE_SIZE) break;
}

console.log(`Households scanned: ${totals.households}`);
console.log(`Members scanned: ${totals.members}`);
console.log(`  contact document already right: ${totals.present}`);
console.log(`  no email on the membership record (left alone): ${totals['no-email']}`);
console.log(`  contact document missing: ${totals.missing}`);
console.log(`  contact document holds another email: ${totals.different}`);
if (apply) console.log(`  created: ${totals.created}; updated: ${totals.updated}; changed meanwhile and skipped: ${totals.skipped}`);
if (!apply) console.log('Dry run only. Re-run with --apply to write the documents.');
