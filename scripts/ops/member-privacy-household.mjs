// Per-household steps of release D's ops scripts (rekey-chore-stats.mjs and
// scrub-member-emails.mjs), separate from the scripts so
// tests/server/member-privacy-ops.test.ts can run them against the Firestore
// emulator. Both scripts settle departed people's identities first
// (./former-member-key.mjs) and re-key the yearly stats with them, so they can
// run in either order, be stopped and be re-run.

import { FieldPath, FieldValue } from 'firebase-admin/firestore';
import { householdUidsByEmail } from './shared-email-scrub.mjs';
import { choreMemberEmailPlan } from './member-email-scrub.mjs';
import { addFormerLegacyKeys, choreStatsAssigneeKeyJs, isLegacyStatsKey, legacyKeyMap, statsRekeyPlan } from './chore-stats-rekey.mjs';
import { formerEvidence, settleFormerIdentities } from './former-member-key.mjs';

const PAGE_SIZE = 400;
const NOT_FOUND = 5;
const FAILED_PRECONDITION = 9;
const STATS_ID = /^chores-\d{4}$/;
const CHORE_FIELDS = ['assignedToUid', 'assignedToEmail', 'recurrence', 'isCompleted', 'completedByUid', 'completedByEmail'];

const text = value => (typeof value === 'string' ? value.trim() : '');
const skippable = error => error?.code === NOT_FOUND || error?.code === FAILED_PRECONDITION;

/**
 * The household's members with their emails (contact document first, else the
 * record's), as the scrub and the re-key use them.
 * @param {import('firebase-admin/firestore').Firestore} db
 * @param {import('firebase-admin/firestore').DocumentReference} householdRef
 */
export async function readHouseholdPeople(db, householdRef) {
  const members = await householdRef.collection('members').get();
  const contacts = members.empty ? [] : await db.getAll(...members.docs.map(member => member.ref.collection('private').doc('contact')));
  const people = members.docs.map((member, index) => ({
    uid: member.id,
    recordEmail: member.get('email'),
    contactEmail: contacts[index]?.exists ? contacts[index].get('email') : undefined,
  }));
  const uidByEmail = householdUidsByEmail(people);
  const withEmail = people.map(person => ({ uid: person.uid, email: text(person.contactEmail) || text(person.recordEmail) }));
  return {
    members,
    uidByEmail,
    legacyMembers: withEmail,
    current: { uids: new Set(people.map(person => person.uid)), emails: new Set(uidByEmail.keys()) },
  };
}

/**
 * Departed people named on the household's chores and templates, settled to one
 * identity each (stored before use when `apply`).
 * @param {import('firebase-admin/firestore').Firestore} db
 * @param {import('firebase-admin/firestore').DocumentReference} householdRef
 * @param {Awaited<ReturnType<typeof readHouseholdPeople>>} people
 * @param {{ apply: boolean, needSecret?: boolean }} options
 */
export async function settleHouseholdFormerPeople(db, householdRef, people, { apply, needSecret = false }) {
  const records = [];
  for (const name of ['chores', 'chore-templates']) {
    const snapshot = await householdRef.collection(name).select(...CHORE_FIELDS).get();
    for (const doc of snapshot.docs) records.push(doc.data());
  }
  const evidence = formerEvidence(records, people.current);
  // Departure aliases (uid -> legacy key, release C) name the uid of an email whose legacy key they hold.
  const uidByLegacy = new Map();
  for (const statsDoc of await householdStats(householdRef)) {
    const aliases = statsDoc.get('aliases');
    if (!aliases || typeof aliases !== 'object') continue;
    for (const [uid, legacyKey] of Object.entries(aliases)) if (uid && typeof legacyKey === 'string') uidByLegacy.set(legacyKey, uid);
  }
  evidence.aliasUids = new Map([...evidence.emails].flatMap(email => {
    const uid = uidByLegacy.get(choreStatsAssigneeKeyJs(email));
    return uid ? [[email, uid]] : [];
  }));
  const settled = await settleFormerIdentities(db, householdRef, { apply, evidence, needSecret, now: () => FieldValue.serverTimestamp() });
  return { evidence, ...settled };
}

/** The household's yearly stats documents. */
export async function householdStats(householdRef) {
  return (await householdRef.collection('stats').get()).docs.filter(doc => STATS_ID.test(doc.id));
}

/** Whether any stats document still holds a legacy (email-derived) key. */
export const hasLegacyKeys = statsDocs => statsDocs.some(doc =>
  [...Object.keys(doc.get('byAssignee') ?? {}), ...Object.keys(doc.get('names') ?? {})].some(isLegacyStatsKey));

/**
 * Re-keys each stats document in its own transaction: current members' legacy
 * keys to their uid key, departed people's to their settled identity, and (with
 * `unknownKeyOf`) any other legacy key to an opaque one.
 * @param {import('firebase-admin/firestore').Firestore} db
 * @param {Array<import('firebase-admin/firestore').QueryDocumentSnapshot>} statsDocs
 * @param {{ apply: boolean, byLegacy: Map<string, string>, unknownKeyOf?: (legacyKey: string) => string }} options
 * @returns {Promise<{ documents: number, clean: number, rekey: number, moved: number, unknown: number, written: number }>}
 */
export async function rekeyHouseholdStats(db, statsDocs, { apply, byLegacy, unknownKeyOf }) {
  const counts = { documents: 0, clean: 0, rekey: 0, moved: 0, unknown: 0, written: 0 };
  for (const statsDoc of statsDocs) {
    counts.documents += 1;
    const plan = await db.runTransaction(async tx => {
      const fresh = await tx.get(statsDoc.ref);
      const decision = statsRekeyPlan(fresh.exists ? fresh.data() : null, byLegacy, unknownKeyOf);
      if (apply && decision.kind === 'rekey') tx.update(statsDoc.ref, { byAssignee: decision.byAssignee, names: decision.names });
      return decision;
    });
    counts[plan.kind] += 1;
    if (plan.kind === 'rekey') {
      counts.moved += plan.moved;
      counts.unknown += plan.unknown;
      if (apply) counts.written += 1;
    }
  }
  return counts;
}

/** Legacy key to stats key for current members and the settled departed people. */
export const householdLegacyKeys = (people, former) =>
  addFormerLegacyKeys(legacyKeyMap(people.legacyMembers), former.evidence.emails, former.identityOf);

const updateArgs = plan => [
  ...Object.entries(plan.set ?? {}).flatMap(([field, value]) => [new FieldPath(field), value]),
  ...plan.remove.flatMap(path => [new FieldPath(...path), FieldValue.delete()]),
];

// One batch per page; if a document changed or was deleted meanwhile, each
// update is retried on its own so the rest of the page is kept.
const writePage = async (db, writes, counts) => {
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

/**
 * Scrubs one collection of chores or templates (choreMemberEmailPlan), page by
 * page, each update guarded by the document's update time.
 * @param {{ scanned: number, clean: number, kept: number, scrub: number, assignee: number, completer: number, former: number, written: number, changed: number }} counts
 */
export async function scrubChoreCollection(db, collectionRef, { apply, uidByEmail, formerKeyOf, counts }) {
  let cursor = null;
  for (;;) {
    let page = collectionRef.select(...CHORE_FIELDS).orderBy(FieldPath.documentId()).limit(PAGE_SIZE);
    if (cursor) page = page.startAfter(cursor);
    const snapshot = await page.get();
    if (snapshot.empty) break;
    const writes = [];
    for (const record of snapshot.docs) {
      counts.scanned += 1;
      const plan = choreMemberEmailPlan(record.data(), uidByEmail, formerKeyOf);
      counts[plan.kind] += 1;
      if (plan.kind !== 'scrub') continue;
      if (plan.assignee !== 'clean') counts.assignee += 1;
      if (plan.completer !== 'none' && plan.completer !== 'kept') counts.completer += 1;
      if (plan.assignee === 'former' || plan.completer === 'former') counts.former += 1;
      writes.push({ ref: record.ref, plan, updateTime: record.updateTime });
    }
    if (apply) await writePage(db, writes, counts);
    cursor = snapshot.docs[snapshot.docs.length - 1];
    if (snapshot.size < PAGE_SIZE) break;
  }
}

export { writePage as writeGuardedPage };
