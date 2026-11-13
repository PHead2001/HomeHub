// Who a chore or chore template is assigned to. Shared by the web app, the
// household server actions and the upkeep function (pure, no Firebase).
//
// Assignees moved from the member's email (`assignedToEmail`) to their Auth
// uid (`assignedToUid`). Release A dual-wrote both; since member privacy
// release C writers store the uid only (and remove any email they replace),
// and scripts/ops/scrub-shared-emails.mjs removes the email from stored
// records. Until every stored email is gone (release F drops the fallback),
// every reader goes through these helpers:
// - a record with only an email (written before the uid existed, or by a
//   browser still running a build from before release A) is matched by
//   email;
// - a record with both is matched by email whenever the reader knows the
//   email, because a build from before release A that reassigns a chore
//   rewrites only the email and leaves the previous assignee's uid behind;
// - a record whose email is empty or absent (every record written since
//   release C), or whose email the reader cannot see, is matched by uid;
// - a uid whose member's (readable) email differs from the stored email is
//   stale and matches nobody, even when the email names a former member.

export type AssigneeRecord = {
  assignedToUid?: unknown;
  assignedToEmail?: unknown;
  recurrence?: unknown;
};

/** A household member as far as assignment is concerned. */
export type AssigneePerson = {uid: string; email?: string | null};

const text = (value: unknown): string =>
  typeof value === "string" ? value.trim() : "";

const lower = (value: unknown): string => text(value).toLowerCase();

/**
 * The record's assignee email: the top-level field, else (templates) the
 * legacy copy inside `recurrence`.
 * @param {AssigneeRecord} record Chore or template fields.
 * @return {string} Lower-cased email, or "".
 */
export const assigneeEmailOf = (record: AssigneeRecord): string => {
  const top = lower(record.assignedToEmail);
  if (top) return top;
  const recurrence = record.recurrence;
  return recurrence && typeof recurrence === "object" ?
    lower((recurrence as Record<string, unknown>).assignedToEmail) : "";
};

/**
 * The record's stored assignee uid, or "".
 * @param {AssigneeRecord} record Chore or template fields.
 * @return {string} The uid.
 */
export const assigneeUidOf = (record: AssigneeRecord): string =>
  text(record.assignedToUid);

/**
 * The uid of the member a record is assigned to, among `people`.
 * @param {AssigneeRecord} record Chore or template fields.
 * @param {AssigneePerson[]} people Members (emails where known).
 * @return {string | null} The member's uid, or null when unassigned or
 *   assigned to someone who is not among `people`.
 */
export const resolveAssigneeUid = (
  record: AssigneeRecord,
  people: readonly AssigneePerson[],
): string | null => {
  const email = assigneeEmailOf(record);
  if (email) {
    const byEmail = people.find((person) => lower(person.email) === email);
    if (byEmail) return byEmail.uid;
  }
  const uid = assigneeUidOf(record);
  const byUid = uid ? people.find((person) => person.uid === uid) : undefined;
  if (!byUid) return null;
  // The uid counts only when it cannot contradict the email: its member's
  // email is unknown to this reader, or there is no stored email. A stored
  // email naming someone else (even a former member) means an older build
  // reassigned the record and the uid is stale.
  const uidEmail = lower(byUid.email);
  if (email && uidEmail && uidEmail !== email) return null;
  return byUid.uid;
};

/**
 * Whether a record is assigned to one person (see the module comment for
 * which field decides).
 * @param {AssigneeRecord} record Chore or template fields.
 * @param {AssigneePerson} person The person.
 * @return {boolean} True when it is theirs.
 */
export const isAssignedTo = (
  record: AssigneeRecord,
  person: AssigneePerson,
): boolean => {
  const email = assigneeEmailOf(record);
  const personEmail = lower(person.email);
  if (email && personEmail) return email === personEmail;
  const uid = assigneeUidOf(record);
  return Boolean(uid) && uid === person.uid;
};

/**
 * Fields a writer sets to assign a chore or template: the uid only (member
 * privacy release C). A writer that updates an existing record must also
 * remove its `assignedToEmail` (and a template's `recurrence.assignedToEmail`)
 * with its SDK's delete sentinel, or an older assignee's email would be left
 * behind and, being matched first, win over the new uid.
 * @param {AssigneePerson} person The new assignee.
 * @return {{assignedToUid: string}} The fields.
 */
export const assigneeFields = (
  person: AssigneePerson,
): {assignedToUid: string} => ({
  assignedToUid: person.uid,
});

/**
 * Fields that leave an open chore unassigned (the writer also deletes
 * `assignedToEmail`, see assigneeFields).
 * @return {object} The fields.
 */
export const unassignedChoreFields = (): {
  assignedToUid: string; assignedToDisplayName: string;
} => ({
  assignedToUid: "",
  assignedToDisplayName: "Unassigned",
});
