// Pure decisions for scrub-shared-emails.mjs (member privacy release C). No
// Firebase imports, so tests/unit/shared-email-scrub.test.ts can cover them.
// Each planner says what to remove from one document; a write is a list of
// field paths (arrays of path segments, so a map key containing a dot is still
// one segment) to delete, plus any field to set.

import { assigneeBackfillDecision, assigneeEmailOfJs } from './chore-assignee.mjs';
import { AUDIENCE_EVERYONE, hasAudience } from './notification-audience.mjs';

const text = value => (typeof value === 'string' ? value.trim() : '');
const isMap = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/**
 * Email (case-insensitive) to uid lookup for one household: each member's
 * protected contact document first (member privacy release B), else the email
 * still on the membership record.
 * @param {Array<{ uid: string, recordEmail?: unknown, contactEmail?: unknown }>} members
 * @returns {Map<string, string>}
 */
export function householdUidsByEmail(members) {
  const byEmail = new Map();
  for (const member of members) {
    const uid = text(member?.uid);
    const email = (text(member?.contactEmail) || text(member?.recordEmail)).toLowerCase();
    if (uid && email && !byEmail.has(email)) byEmail.set(email, uid);
  }
  return byEmail;
}

/**
 * What the scrub does with one chore or chore template.
 * @param {Record<string, unknown> | null | undefined} data Document data.
 * @param {Map<string, string>} uidByEmail From householdUidsByEmail.
 * @returns {{ kind: 'clean' | 'credit' } | { kind: 'scrub' | 'repaired' | 'cleared', remove: string[][], set: Record<string, string> }}
 *   - `clean`: no assignee email stored (an empty one is left alone);
 *   - `credit`: a completed chore without a recorded completer: the yearly chore
 *     stats still credit it to its assignee by email when upkeep removes it after
 *     90 days, so its email is kept until then;
 *   - `scrub`: remove the email (`assignedToEmail`, and a template's
 *     `recurrence.assignedToEmail`), the stored uid already agrees with it (or the
 *     email names no current member and the uid is not a current member's);
 *   - `repaired`: as `scrub`, and first set `assignedToUid` to the member the email
 *     names (missing, or left stale by a build from before release A that
 *     reassigned by email only), so readers resolve the same member by uid;
 *   - `cleared`: as `scrub`, and clear `assignedToUid` (`''`): the email names a
 *     former member and the uid next to it is a current member's leftover, which
 *     must not become that member's chore once the email is gone.
 */
export function choreEmailScrubPlan(data, uidByEmail) {
  if (!assigneeEmailOfJs(data)) return { kind: 'clean' };
  const completedWithoutCompleter = data?.isCompleted === true && !text(data?.completedByEmail);
  if (completedWithoutCompleter) return { kind: 'credit' };
  const remove = [];
  if (data && 'assignedToEmail' in data) remove.push(['assignedToEmail']);
  if (isMap(data?.recurrence) && 'assignedToEmail' in data.recurrence) remove.push(['recurrence', 'assignedToEmail']);
  const decision = assigneeBackfillDecision(data, uidByEmail);
  if (decision.kind === 'missing' || decision.kind === 'mismatch') {
    return { kind: 'repaired', remove, set: { assignedToUid: decision.assignedToUid } };
  }
  if (decision.kind === 'stale') return { kind: 'cleared', remove, set: { assignedToUid: '' } };
  return { kind: 'scrub', remove, set: {} };
}

/**
 * Paths of emails inside notification action entries: `readBy.<uid>.email`,
 * `dismissedBy.<uid>.email` and `resolvedBy.email` (written before release A).
 * @param {Record<string, unknown> | null | undefined} data
 * @returns {string[][]}
 */
export function notificationActionEmailPaths(data) {
  const paths = [];
  for (const field of ['readBy', 'dismissedBy']) {
    const entries = data?.[field];
    if (!isMap(entries)) continue;
    for (const [key, entry] of Object.entries(entries)) {
      if (isMap(entry) && 'email' in entry) paths.push([field, key, 'email']);
    }
  }
  if (isMap(data?.resolvedBy) && 'email' in data.resolvedBy) paths.push(['resolvedBy', 'email']);
  return paths;
}

/**
 * What the scrub does with one notification.
 * @param {Record<string, unknown> | null | undefined} data Notification data.
 * @param {Map<string, string>} uidByEmail From householdUidsByEmail.
 * @returns {{ kind: 'clean' } | { kind: 'scrub' | 'retargeted' | 'unresolvable', remove: string[][], set: Record<string, unknown> }}
 *   - `clean`: no `targetUserEmail` and no email in an action entry;
 *   - `scrub`: remove `targetUserEmail` (the notification also names its member by
 *     `targetUserUid`; an `audience` is added when missing) and action-entry emails;
 *   - `retargeted`: an email-only target whose member is known (from its `audience`
 *     or the household's members): set `targetUserUid` (and `audience` when missing
 *     or empty) before removing the email, so it never becomes household-wide;
 *   - `unresolvable`: an email-only target that is no longer a member: the target
 *     email is kept (removing it would address the notification to everyone; it
 *     expires within seven days); only action-entry emails are removed (`remove`
 *     may then be empty, meaning nothing to write).
 */
export function notificationEmailScrubPlan(data, uidByEmail) {
  const remove = notificationActionEmailPaths(data);
  const targetEmail = text(data?.targetUserEmail);
  if (!targetEmail) {
    if (remove.length === 0) return { kind: 'clean' };
    if (data && 'targetUserEmail' in data) remove.push(['targetUserEmail']);
    return { kind: 'scrub', remove, set: {} };
  }
  const audience = hasAudience(data?.audience) ? data.audience : null;
  const uid = text(data?.targetUserUid);
  if (uid) {
    return { kind: 'scrub', remove: [...remove, ['targetUserEmail']], set: audience ? {} : { audience: [uid] } };
  }
  const named = audience && audience.length === 1 && audience[0] !== AUDIENCE_EVERYONE ? text(audience[0]) : '';
  const resolved = named || uidByEmail.get(targetEmail.toLowerCase()) || '';
  if (!resolved) return { kind: 'unresolvable', remove, set: {} };
  return {
    kind: 'retargeted',
    remove: [...remove, ['targetUserEmail']],
    set: { targetUserUid: resolved, ...(audience && audience.length > 0 ? {} : { audience: [resolved] }) },
  };
}

/**
 * What the scrub removes from a household document: the legacy `memberEmails`
 * list and `ownerEmail` (display data only; access comes from membership
 * records and `ownerUid`). `ownerEmail` is kept on a household without an
 * `ownerUid` (none are expected), so nothing is left without an owner pointer.
 * @param {Record<string, unknown> | null | undefined} data Household data.
 * @returns {{ kind: 'clean' | 'no-owner-uid' } | { kind: 'scrub', remove: string[][] }}
 */
export function householdEmailScrubPlan(data) {
  const remove = [];
  if (data && 'memberEmails' in data) remove.push(['memberEmails']);
  const ownerEmailKept = data && 'ownerEmail' in data && !text(data.ownerUid);
  if (data && 'ownerEmail' in data && !ownerEmailKept) remove.push(['ownerEmail']);
  if (remove.length === 0) return ownerEmailKept ? { kind: 'no-owner-uid' } : { kind: 'clean' };
  return { kind: 'scrub', remove };
}

/**
 * Labels in a yearly chore stats document (`stats/chores-{year}.names`) that are
 * an email (written before release A, when a missing name fell back to it).
 * Counts (`byAssignee`) are untouched; Home Wrapped then shows no label for that
 * key, never the email.
 * @param {Record<string, unknown> | null | undefined} data Stats data.
 * @returns {{ kind: 'clean' } | { kind: 'scrub', remove: string[][] }}
 */
export function statsEmailScrubPlan(data) {
  const names = isMap(data?.names) ? data.names : {};
  const remove = Object.entries(names)
    .filter(([, name]) => typeof name === 'string' && name.includes('@'))
    .map(([key]) => ['names', key]);
  return remove.length === 0 ? { kind: 'clean' } : { kind: 'scrub', remove };
}
