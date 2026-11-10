// Pure decisions for backfill-chore-assignee-uid.mjs. No Firebase imports, so
// tests/unit/chores-assignee.test.ts can cover them. `resolveAssigneeUidJs` is
// the plain-JavaScript twin of `resolveAssigneeUid` in
// functions/src/shared/assignee.ts (these scripts run without a TypeScript
// loader); that test checks the two agree case by case.

const text = value => (typeof value === 'string' ? value.trim() : '');
const lower = value => text(value).toLowerCase();

/**
 * The record's assignee email: the top-level field, else (templates) the copy
 * inside `recurrence`. Lower-cased, or ''.
 * @param {Record<string, unknown> | null | undefined} data
 * @returns {string}
 */
export function assigneeEmailOfJs(data) {
  const top = lower(data?.assignedToEmail);
  if (top) return top;
  const recurrence = data?.recurrence;
  return recurrence && typeof recurrence === 'object' ? lower(recurrence.assignedToEmail) : '';
}

/**
 * Email (case-insensitive) to uid lookup from a household's member documents.
 * @param {Array<{ uid?: unknown, email?: unknown }>} members
 * @returns {Map<string, string>}
 */
export function memberUidsByEmail(members) {
  const byEmail = new Map();
  for (const member of members) {
    const uid = text(member?.uid);
    const email = lower(member?.email);
    if (uid && email && !byEmail.has(email)) byEmail.set(email, uid);
  }
  return byEmail;
}

/**
 * Plain-JavaScript twin of resolveAssigneeUid: the uid of the member a record
 * is assigned to. The email decides when it names a member (an older build that
 * reassigns rewrites only the email); otherwise a stored uid of a member.
 * @param {Record<string, unknown> | null | undefined} data
 * @param {Array<{ uid: string, email?: string | null }>} people
 * @returns {string | null}
 */
export function resolveAssigneeUidJs(data, people) {
  const email = assigneeEmailOfJs(data);
  if (email) {
    const byEmail = people.find(person => lower(person.email) === email);
    if (byEmail) return byEmail.uid;
  }
  const uid = text(data?.assignedToUid);
  return uid && people.some(person => person.uid === uid) ? uid : null;
}

/**
 * What the backfill does with one chore or chore-template document.
 * @param {Record<string, unknown> | null | undefined} data Document data.
 * @param {Map<string, string>} uidByEmail From memberUidsByEmail.
 * @returns {{ kind: 'present' | 'unassigned' | 'former' } | { kind: 'missing' | 'mismatch', assignedToUid: string }}
 *   - `present`: the stored uid already agrees (or there is no email to check it against);
 *   - `unassigned`: no email and no uid;
 *   - `former`: an email that names nobody in the household (left, or never joined); left alone;
 *   - `missing`: no uid yet, the email names a member: write that member's uid;
 *   - `mismatch`: the stored uid disagrees with the member the email names (an
 *     older build reassigned it by email): write the email's member uid.
 */
export function assigneeBackfillDecision(data, uidByEmail) {
  const email = assigneeEmailOfJs(data);
  const stored = text(data?.assignedToUid);
  if (!email) return stored ? { kind: 'present' } : { kind: 'unassigned' };
  const resolved = uidByEmail.get(email);
  if (!resolved) return { kind: 'former' };
  if (!stored) return { kind: 'missing', assignedToUid: resolved };
  return stored === resolved ? { kind: 'present' } : { kind: 'mismatch', assignedToUid: resolved };
}
