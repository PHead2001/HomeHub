// Pure decisions for scrub-member-emails.mjs (member privacy release D). No
// Firebase imports, so tests/unit/member-email-scrub.test.ts can cover them.
// A write is a list of field paths (arrays of segments) to delete, plus fields
// to set, as in ./shared-email-scrub.mjs.

import { assigneeEmailOfJs } from './chore-assignee.mjs';
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
 * release C's planner, and the server-written `completedByEmail`, without ever
 * dropping the person a completed chore is credited to (`creditedPerson` in
 * functions/src/shared/chore-stats.ts: the completer, else the assignee). When
 * the email being removed names nobody in the household (someone who has left)
 * and is the only identity of the credited person, the chore gets that person's
 * opaque former-member key (`formerKeyOf`, ./former-member-key.mjs) in its place.
 * @param {Record<string, unknown> | null | undefined} data Document data.
 * @param {Map<string, string>} uidByEmail Email (lower-cased) to member uid.
 * @param {(email: string) => string} [formerKeyOf] Former-member key for an email
 *   (the same for the same person in the household). Without it, such an email
 *   is kept rather than dropped with its credit.
 * @returns {{ kind: 'clean' | 'kept' } | { kind: 'scrub', remove: string[][], set: Record<string, string>, assignee: string, completer: string }}
 *   `assignee` is release C's kind (`clean`, `scrub`, `repaired`, `cleared`), or
 *   `former`: a completed chore credited to its assignee, whose email names
 *   nobody here and whose stored uid would not name them (none, or a current
 *   member's leftover): `assignedToUid` becomes their former-member key.
 *   `completer` is one of:
 *   - `none`: no `completedByEmail`;
 *   - `removed`: removed; `completedByUid` already names the completer;
 *   - `repaired`: `completedByUid` was missing and is set to the member the email names;
 *   - `former`: no `completedByUid` and the email names nobody here (someone who
 *     left): `completedByUid` becomes their former-member key;
 *   - `kept`: as `former`, without `formerKeyOf`: the email is kept.
 *   `kind` is `clean` when there is nothing to write, `kept` when the only emails
 *   left are such kept ones.
 */
export function choreMemberEmailPlan(data, uidByEmail, formerKeyOf) {
  const assignee = choreEmailScrubPlan(data, uidByEmail, { keepForStats: false });
  let assigneeKind = assignee.kind;
  let remove = assignee.kind === 'clean' ? [] : [...assignee.remove];
  const set = assignee.kind === 'clean' ? {} : { ...assignee.set };
  let kept = false;
  // Credited to the assignee: completed, with no completer recorded at all.
  const creditedToAssignee = data?.isCompleted === true && !text(data?.completedByUid) && !text(data?.completedByEmail);
  if (creditedToAssignee && (assignee.kind === 'scrub' || assignee.kind === 'cleared')) {
    const email = assigneeEmailOfJs(data);
    const uidAfter = text(assignee.kind === 'cleared' ? assignee.set.assignedToUid : data?.assignedToUid);
    if (!uidByEmail.get(email) && !uidAfter) {
      const key = formerKeyOf ? formerKeyOf(email) : '';
      if (key) {
        set.assignedToUid = key;
        assigneeKind = 'former';
      } else {
        remove = [];
        delete set.assignedToUid;
        assigneeKind = 'clean';
        kept = true;
      }
    }
  }
  let completer = 'none';
  if (data && 'completedByEmail' in data) {
    const email = text(data.completedByEmail).toLowerCase();
    const uid = text(data.completedByUid);
    const key = uid || !email || uidByEmail.get(email) || !formerKeyOf ? '' : formerKeyOf(email);
    if (uid || !email) {
      completer = 'removed';
      remove.push(['completedByEmail']);
    } else if (uidByEmail.get(email)) {
      completer = 'repaired';
      set.completedByUid = uidByEmail.get(email);
      remove.push(['completedByEmail']);
    } else if (key) {
      completer = 'former';
      set.completedByUid = key;
      remove.push(['completedByEmail']);
    } else {
      completer = 'kept';
      kept = true;
    }
  }
  if (remove.length === 0 && Object.keys(set).length === 0) return { kind: kept ? 'kept' : 'clean' };
  return { kind: 'scrub', remove, set, assignee: assigneeKind, completer };
}
