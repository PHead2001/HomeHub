// Pure decisions for scrub-member-emails.mjs (member privacy release D). No
// Firebase imports, so tests/unit/member-email-scrub.test.ts can cover them.
// A write is a list of field paths (arrays of segments) to delete, plus fields
// to set, as in ./shared-email-scrub.mjs.

import { choreEmailScrubPlan } from './shared-email-scrub.mjs';

const text = value => (typeof value === 'string' ? value.trim() : '');

/**
 * What the scrub does with one membership record, given its contact document
 * (`members/{uid}/private/contact`). The record's `email` is removed only when
 * the contact document holds the same email, so no member is left without one.
 * @param {Record<string, unknown> | null | undefined} member Membership record data.
 * @param {Record<string, unknown> | null | undefined} contact Contact document data, or null when it does not exist.
 * @returns {{ kind: 'clean' | 'no-contact' | 'mismatch' } | { kind: 'scrub', remove: string[][] }}
 *   - `clean`: the record has no `email` field;
 *   - `no-contact`: no contact document, or one without an email: the record keeps
 *     its email (run scripts/ops/backfill-member-contact.mjs, then this again);
 *   - `mismatch`: the contact document holds another email: kept for a person to check;
 *   - `scrub`: remove `email` (an empty or non-text value is removed as well).
 */
export function memberRecordEmailPlan(member, contact) {
  if (!member || !('email' in member)) return { kind: 'clean' };
  const recordEmail = text(member.email).toLowerCase();
  if (recordEmail) {
    const contactEmail = text(contact?.email).toLowerCase();
    if (!contactEmail) return { kind: 'no-contact' };
    if (contactEmail !== recordEmail) return { kind: 'mismatch' };
  }
  return { kind: 'scrub', remove: [['email']] };
}

/**
 * What the scrub does with one chore or chore template: every assignee email
 * (completed chores included, since the yearly stats credit by uid) as in
 * release C's planner, and the server-written `completedByEmail`.
 * @param {Record<string, unknown> | null | undefined} data Document data.
 * @param {Map<string, string>} uidByEmail Email (lower-cased) to member uid.
 * @returns {{ kind: 'clean' | 'kept' } | { kind: 'scrub', remove: string[][], set: Record<string, string>, assignee: string, completer: string }}
 *   `assignee` is release C's kind (`clean`, `scrub`, `repaired`, `cleared`);
 *   `completer` is one of:
 *   - `none`: no `completedByEmail`;
 *   - `removed`: removed; `completedByUid` already names the completer;
 *   - `repaired`: `completedByUid` was missing and is set to the member the email names;
 *   - `kept`: no `completedByUid` and the email names nobody here (a former
 *     member): kept, since without it the chore would be credited to its assignee.
 *   `kind` is `clean` when there is nothing to write, `kept` when the only email
 *   left is such a kept `completedByEmail`.
 */
export function choreMemberEmailPlan(data, uidByEmail) {
  const assignee = choreEmailScrubPlan(data, uidByEmail, { keepForStats: false });
  const remove = assignee.kind === 'clean' ? [] : [...assignee.remove];
  const set = assignee.kind === 'clean' ? {} : { ...assignee.set };
  let completer = 'none';
  if (data && 'completedByEmail' in data) {
    const email = text(data.completedByEmail).toLowerCase();
    const uid = text(data.completedByUid);
    if (uid || !email) {
      completer = 'removed';
      remove.push(['completedByEmail']);
    } else if (uidByEmail.get(email)) {
      completer = 'repaired';
      set.completedByUid = uidByEmail.get(email);
      remove.push(['completedByEmail']);
    } else {
      completer = 'kept';
    }
  }
  if (remove.length === 0 && Object.keys(set).length === 0) return { kind: completer === 'kept' ? 'kept' : 'clean' };
  return { kind: 'scrub', remove, set, assignee: assignee.kind, completer };
}
