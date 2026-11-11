// Pure decisions for scrub-remaining-emails.mjs (member privacy release E). No
// Firebase imports, so tests/unit/remaining-email-scrub.test.ts can cover them.
//
// After releases C and D, the copies of a member's email that housemates can
// still read are display labels written before release A, or by a profile
// whose name is an email (a name fell back to the email, or someone typed it):
// chores' `assignedToDisplayName` and `completedByName`, templates'
// `assignedToDisplayName`, maintenance attachments' `uploadedByName`, pet logs'
// `loggedByName` and the feeding state's `lastFedByName`; membership records'
// `displayName` and an `avatarUrl` that points into an email-named photo
// folder (`users/{email}/avatars/...`, uploads before release B whose move was
// not possible); and a completed chore's `completedByEmail` that names someone
// who has left (release D kept it so the chore is not credited to its
// assignee). A write is a list of field paths (arrays of segments) to delete
// plus `[path, value]` pairs to set.

import { parseStorageDownloadUrl } from './avatar-path.mjs';
import { choreMemberEmailPlan } from './member-email-scrub.mjs';

/** Same test as `publicDisplayName` (src/lib/member-directory.ts). */
const EMAIL_LIKE = /\S+@\S+/;

/**
 * `completedByUid` given to a completion whose completer has left and was known
 * only by email. It names nobody, so the chore is credited to no one, as it was
 * with the email (`creditedPerson` in functions/src/shared/chore-stats.ts and the
 * Chores page's points); `completedByName` keeps the label. Twin of
 * `FORMER_MEMBER_UID` in functions/src/shared/chore-stats.ts.
 */
export const FORMER_MEMBER_UID = 'former-member';

const text = value => (typeof value === 'string' ? value.trim() : '');
const isMap = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** Whether a stored label is (or contains) an email address. */
export const containsEmail = value => typeof value === 'string' && EMAIL_LIKE.test(value);

/**
 * Whether a photo URL is a Storage download URL of a file in an email-named
 * folder (`users/{email}/avatars/...`), which carries the email.
 * @param {unknown} url
 * @returns {boolean}
 */
export function isEmailFolderPhotoUrl(url) {
  const location = parseStorageDownloadUrl(url);
  return Boolean(location) && /^users\/[^/]*@[^/]*\//.test(location.path);
}

/**
 * Public display names by uid, from membership records (never an email).
 * @param {Array<{ uid: string, displayName?: unknown }>} members
 * @returns {Map<string, string>}
 */
export function publicNamesByUid(members) {
  const names = new Map();
  for (const member of members) {
    const name = text(member?.displayName);
    if (text(member?.uid) && name && !containsEmail(name)) names.set(member.uid, name.slice(0, 80));
  }
  return names;
}

const valueAt = (data, path) => path.reduce((value, key) => (isMap(value) ? value[key] : undefined), data);

/**
 * Label fields per collection: the label, the uid it belongs to, the label used
 * when that uid names nobody here, and whether the label is a first name only
 * (pet logs, as `loggerName`).
 */
export const LABEL_FIELDS = {
  chores: [
    { path: ['assignedToDisplayName'], uid: ['assignedToUid'], fallback: 'Member', unassigned: 'Unassigned' },
    { path: ['completedByName'], uid: ['completedByUid'], fallback: 'Member' },
  ],
  'chore-templates': [
    { path: ['assignedToDisplayName'], uid: ['assignedToUid'], fallback: 'Member', unassigned: 'Unassigned' },
  ],
  'maintenance-attachments': [
    { path: ['uploadedByName'], uid: ['uploadedByUid'], fallback: 'Member' },
  ],
  'pet-logs': [
    { path: ['loggedByName'], uid: ['loggedByUid'], fallback: 'Someone', firstName: true },
  ],
  'feeding-state': [
    { path: ['lastFedByName'], uid: ['lastFedByUid'], fallback: 'Someone', firstName: true },
    { path: ['prev', 'lastFedByName'], uid: ['prev', 'lastFedByUid'], fallback: 'Someone', firstName: true },
  ],
};

/**
 * Replacements for every label in `fields` that holds an email: the current
 * public name of the uid next to it (first word for first-name labels), else
 * the fallback ("Unassigned" for an assignee label without a uid).
 * @param {Record<string, unknown> | null | undefined} data
 * @param {Array<{ path: string[], uid: string[], fallback: string, unassigned?: string, firstName?: boolean }>} fields
 * @param {Map<string, string>} namesByUid From publicNamesByUid.
 * @param {Record<string, unknown>} [overrides] Uid fields this write also sets (top-level names).
 * @returns {Array<[string[], string]>}
 */
export function labelFixes(data, fields, namesByUid, overrides = {}) {
  const fixes = [];
  for (const field of fields) {
    if (!containsEmail(valueAt(data, field.path))) continue;
    const uidKey = field.uid.join('.');
    const uid = text(uidKey in overrides ? overrides[uidKey] : valueAt(data, field.uid));
    const name = uid ? namesByUid.get(uid) : undefined;
    const label = name ? (field.firstName ? name.split(/\s+/)[0].slice(0, 60) : name)
      : (!uid && field.unassigned) ? field.unassigned : field.fallback;
    fixes.push([field.path, label]);
  }
  return fixes;
}

/**
 * What the scrub does with one chore: any assignee or completer email still
 * stored (as release D's planner: uid first where it was missing), a former
 * member's `completedByEmail` (replaced by `FORMER_MEMBER_UID`), and email labels.
 * @param {Record<string, unknown> | null | undefined} data
 * @param {{ uidByEmail: Map<string, string>, namesByUid: Map<string, string> }} context
 * @returns {{ kind: 'clean' } | { kind: 'scrub', remove: string[][], set: Array<[string[], unknown]>, emails: number, formerCompleter: boolean, labels: number }}
 */
export function choreRemainingEmailPlan(data, { uidByEmail, namesByUid }) {
  const base = choreMemberEmailPlan(data, uidByEmail);
  const remove = base.kind === 'scrub' ? [...base.remove] : [];
  const sets = base.kind === 'scrub' ? { ...base.set } : {};
  const formerCompleter = base.kind === 'kept' || (base.kind === 'scrub' && base.completer === 'kept');
  if (formerCompleter) {
    remove.push(['completedByEmail']);
    sets.completedByUid = FORMER_MEMBER_UID;
  }
  const labels = labelFixes(data, LABEL_FIELDS.chores, namesByUid, sets);
  const emails = remove.length - (formerCompleter ? 1 : 0);
  if (remove.length === 0 && Object.keys(sets).length === 0 && labels.length === 0) return { kind: 'clean' };
  const set = [...Object.entries(sets).map(([field, value]) => [[field], value]), ...labels];
  return { kind: 'scrub', remove, set, emails, formerCompleter, labels: labels.length };
}

/**
 * What the scrub does with one chore template: any assignee email still stored
 * and an email assignee label.
 * @param {Record<string, unknown> | null | undefined} data
 * @param {{ uidByEmail: Map<string, string>, namesByUid: Map<string, string> }} context
 * @returns {{ kind: 'clean' } | { kind: 'scrub', remove: string[][], set: Array<[string[], unknown]>, emails: number, formerCompleter: false, labels: number }}
 */
export function templateRemainingEmailPlan(data, { uidByEmail, namesByUid }) {
  const base = choreMemberEmailPlan(data, uidByEmail);
  const remove = base.kind === 'scrub' ? [...base.remove] : [];
  const sets = base.kind === 'scrub' ? { ...base.set } : {};
  const labels = labelFixes(data, LABEL_FIELDS['chore-templates'], namesByUid, sets);
  if (remove.length === 0 && Object.keys(sets).length === 0 && labels.length === 0) return { kind: 'clean' };
  const set = [...Object.entries(sets).map(([field, value]) => [[field], value]), ...labels];
  return { kind: 'scrub', remove, set, emails: remove.length, formerCompleter: false, labels: labels.length };
}

/**
 * What the scrub does with a document that only has labels (attachments, pet
 * logs, feeding state).
 * @param {Record<string, unknown> | null | undefined} data
 * @param {keyof typeof LABEL_FIELDS} collection
 * @param {Map<string, string>} namesByUid
 * @returns {{ kind: 'clean' } | { kind: 'scrub', remove: string[][], set: Array<[string[], unknown]>, labels: number }}
 */
export function labelEmailPlan(data, collection, namesByUid) {
  const labels = labelFixes(data, LABEL_FIELDS[collection], namesByUid);
  return labels.length === 0 ? { kind: 'clean' } : { kind: 'scrub', remove: [], set: labels, labels: labels.length };
}

/**
 * What the scrub does with one membership record: a `displayName` that is an
 * email and a photo in an email-named folder are removed (the app shows
 * "Member" and initials; the member's next profile sync writes their current
 * public name and photo). A leftover `email` is only counted (`email: true`):
 * scripts/ops/backfill-member-contact.mjs, then scripts/ops/scrub-member-emails.mjs,
 * remove it once the contact document holds it.
 * @param {Record<string, unknown> | null | undefined} data
 * @returns {{ kind: 'clean', email: boolean } | { kind: 'scrub', remove: string[][], set: [], email: boolean }}
 */
export function memberRecordRemainingPlan(data) {
  const email = Boolean(data && 'email' in data && text(data.email));
  const remove = [];
  if (containsEmail(data?.displayName)) remove.push(['displayName']);
  if (isEmailFolderPhotoUrl(data?.avatarUrl)) remove.push(['avatarUrl']);
  return remove.length === 0 ? { kind: 'clean', email } : { kind: 'scrub', remove, set: [], email };
}
