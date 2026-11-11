// One identity per person who has left a household, shared by the yearly stats
// re-key (rekey-chore-stats.mjs) and the chore email scrub (scrub-member-emails.mjs,
// and release E's scrub-remaining-emails.mjs), so a departed person's archived
// and retained completions add up to one score whichever script runs first.
//
// A departed person is known only by an email on older chores. Their identity is:
// - their account uid, when the household's chores and templates pair that email
//   with exactly one uid that is not a current member's, and that uid with no
//   other email (an older build's email-only reassignment can pair an email with
//   someone else's uid, so anything less certain is not trusted);
// - otherwise an opaque former-member key: `former-` and 24 hex characters, an
//   HMAC-SHA-256 of the lower-cased email under a random per-household secret.
// Stats key it as any uid (`choreStatsMemberKey`); chores carry it as
// `assignedToUid` or `completedByUid`.
//
// The secret and every decision made (former-member key -> identity, no email)
// are kept in `households/{id}/ops/former-members` (`{ secret, createdAt,
// identities }`), which only the server can read (the rules deny every client
// read and write under `ops`). A decision is stored before anything is written
// with it and never changes afterwards, so later runs, partial runs and either
// script order reuse it even when the evidence has since been scrubbed. No
// Firebase imports: Firestore is used through the instances passed in.

import { createHmac, randomBytes } from 'node:crypto';
import { assigneeEmailOfJs } from './chore-assignee.mjs';

/** Prefix of every former-member key. Firebase Auth uids never contain "-". */
export const FORMER_KEY_PREFIX = 'former-';

const text = value => (typeof value === 'string' ? value.trim() : '');
const lower = value => text(value).toLowerCase();
const isMap = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/**
 * The former-member key for one email in one household.
 * @param {string} secret The household's secret.
 * @param {string} email The email the chore names.
 * @returns {string} `former-` and 24 hex characters; '' for an empty email or secret.
 */
export function formerMemberKey(secret, email) {
  const normalized = lower(email);
  if (!normalized || !secret) return '';
  return FORMER_KEY_PREFIX + createHmac('sha256', secret).update(normalized).digest('hex').slice(0, 24);
}

/**
 * The identity a legacy stats key of nobody known is moved to (no chore names its
 * email any more): opaque, and the same in every run.
 * @param {string} secret The household's secret.
 * @param {string} legacyKey The legacy key.
 * @returns {string}
 */
export function unknownLegacyKey(secret, legacyKey) {
  return secret && legacyKey
    ? FORMER_KEY_PREFIX + createHmac('sha256', secret).update(`stats-key:${legacyKey}`).digest('hex').slice(0, 24)
    : '';
}

/**
 * Emails of people who are not current members, and the uids the household's
 * chores and templates pair each with, from assignee (email and `assignedToUid`)
 * and completer (`completedByEmail` and `completedByUid`) fields. Uids of
 * current members never count as evidence.
 * @param {Iterable<Record<string, unknown>>} records Chore and template data.
 * @param {{ uids: Set<string>, emails: Set<string> }} current Current members' uids and lower-cased emails.
 * @returns {{ emails: Set<string>, uidsByEmail: Map<string, Set<string>>, emailsByUid: Map<string, Set<string>> }}
 */
export function formerEvidence(records, current) {
  const emails = new Set();
  const uidsByEmail = new Map();
  const emailsByUid = new Map();
  const pair = (email, uid) => {
    if (!email || current.emails.has(email)) return;
    emails.add(email);
    if (!uid || current.uids.has(uid)) return;
    if (!uidsByEmail.has(email)) uidsByEmail.set(email, new Set());
    if (!emailsByUid.has(uid)) emailsByUid.set(uid, new Set());
    uidsByEmail.get(email).add(uid);
    emailsByUid.get(uid).add(email);
  };
  for (const data of records) {
    pair(assigneeEmailOfJs(data), text(data?.assignedToUid));
    pair(lower(data?.completedByEmail), text(data?.completedByUid));
  }
  return { emails, uidsByEmail, emailsByUid };
}

/**
 * The identity proposed for a departed person's email (see the module comment).
 * @param {string} email Lower-cased email.
 * @param {ReturnType<typeof formerEvidence>} evidence
 * @param {string} secret The household's secret.
 * @returns {string} Their uid, or their former-member key.
 */
export function proposeFormerIdentity(email, evidence, secret) {
  const uids = evidence.uidsByEmail.get(email);
  if (uids?.size === 1) {
    const [uid] = uids;
    if (evidence.emailsByUid.get(uid)?.size === 1) return uid;
  }
  return formerMemberKey(secret, email);
}

/**
 * Settles the identities of `evidence.emails` against the household's stored
 * decisions: a stored decision wins; any other is proposed now and, when
 * `apply`, stored (with the secret, on first use) in one transaction before it
 * is used. A dry run stores nothing and uses a throwaway secret if none is stored.
 * @param {import('firebase-admin/firestore').Firestore} db
 * @param {import('firebase-admin/firestore').DocumentReference} householdRef
 * @param {{ apply: boolean, evidence: ReturnType<typeof formerEvidence>, needSecret?: boolean, now?: () => unknown }} options
 *   `needSecret`: store a secret even without departed emails (legacy stats keys of nobody known).
 * @returns {Promise<{ identityOf: (email: string) => string, unknownKeyOf: (legacyKey: string) => string, added: number, created: boolean }>}
 */
export async function settleFormerIdentities(db, householdRef, { apply, evidence, needSecret = false, now = () => new Date() }) {
  const ref = householdRef.collection('ops').doc('former-members');
  const candidate = randomBytes(32).toString('base64');
  const decide = snapshot => {
    const storedSecret = snapshot.exists ? text(snapshot.get('secret')) : '';
    const secret = storedSecret || candidate;
    const stored = snapshot.exists && isMap(snapshot.get('identities')) ? snapshot.get('identities') : {};
    const identities = { ...stored };
    const added = {};
    for (const email of evidence.emails) {
      const key = formerMemberKey(secret, email);
      if (typeof identities[key] === 'string' && identities[key]) continue;
      identities[key] = added[key] = proposeFormerIdentity(email, evidence, secret);
    }
    return { storedSecret, secret, identities, added };
  };
  const writes = apply && (evidence.emails.size > 0 || needSecret);
  const result = !writes ? decide(await ref.get()) : await db.runTransaction(async tx => {
    const decision = decide(await tx.get(ref));
    if (!decision.storedSecret) {
      tx.set(ref, { secret: decision.secret, createdAt: now(), identities: decision.added });
    } else if (Object.keys(decision.added).length > 0) {
      tx.set(ref, { identities: decision.added }, { merge: true });
    }
    return decision;
  });
  return {
    identityOf: email => result.identities[formerMemberKey(result.secret, email)] ?? '',
    unknownKeyOf: legacyKey => unknownLegacyKey(result.secret, legacyKey),
    added: writes ? Object.keys(result.added).length : 0,
    created: writes && !result.storedSecret,
  };
}
