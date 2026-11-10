// Who a chore or chore template is assigned to. Shared by the web app, the
// household server actions and the upkeep function (pure, no Firebase).
//
// Assignees are moving from the member's email (`assignedToEmail`) to their
// Auth uid (`assignedToUid`). During the move every writer sets both, and
// every reader goes through these helpers:
// - a record with only an email (written before the uid existed, or by a
//   browser still running an older build) is matched by email;
// - a record with both is matched by email whenever the reader knows the
//   email, because an older build that reassigns a chore rewrites only the
//   email and leaves the previous assignee's uid behind;
// - a record whose email is empty, or whose email the reader cannot see,
//   is matched by uid;
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
 * Fields a writer sets to assign a chore or template (dual-write): the uid
 * always, the email while the writer still knows it ("" otherwise, so an
 * older assignee's email is never left behind).
 * @param {AssigneePerson} person The new assignee.
 * @return {{assignedToUid: string, assignedToEmail: string}} The fields.
 */
export const assigneeFields = (
  person: AssigneePerson,
): {assignedToUid: string; assignedToEmail: string} => ({
  assignedToUid: person.uid,
  assignedToEmail: text(person.email),
});

/**
 * Fields that leave an open chore unassigned.
 * @return {object} The fields.
 */
export const unassignedChoreFields = (): {
  assignedToUid: string; assignedToEmail: string;
  assignedToDisplayName: string;
} => ({
  assignedToUid: "",
  assignedToEmail: "",
  assignedToDisplayName: "Unassigned",
});

/**
 * The assignee part of a generated occurrence's id. Existing templates keep
 * the email they were generated with (changing it would regenerate every
 * upcoming occurrence under a new id); a template that has no email (written
 * once emails are no longer known to the writer) uses the uid.
 * @param {AssigneeRecord} template Template fields.
 * @return {string} The key, or "" when unassigned.
 */
export const occurrenceAssigneeKey = (template: AssigneeRecord): string => {
  // The stored value as is (not trimmed or lower-cased): ids generated so far
  // used it verbatim.
  const raw = (value: unknown): string =>
    typeof value === "string" && value.trim() ? value : "";
  const recurrence = template.recurrence;
  return raw(template.assignedToEmail) ||
    (recurrence && typeof recurrence === "object" ?
      raw((recurrence as Record<string, unknown>).assignedToEmail) : "") ||
    assigneeUidOf(template);
};
