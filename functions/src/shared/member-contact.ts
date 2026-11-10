// A member's email, read from their protected contact document first.
// Shared by the web app and the Cloud Functions (pure, no Firebase).
//
// Emails are moving off the membership record
// (`households/{id}/members/{uid}.email`) into
// `households/{id}/members/{uid}/private/contact` (`{email, updatedAt}`),
// which only the server writes and only the person and member managers can
// read. During the move a member may have either or both, so every reader
// prefers the contact document and falls back to the record.

const text = (value: unknown): string =>
  typeof value === "string" ? value.trim() : "";

/**
 * The email in a contact document, or "" when it is missing or unusable.
 * @param {unknown} contact Contact document data.
 * @return {string} Trimmed email, or "".
 */
export const contactEmailOf = (contact: unknown): string =>
  contact && typeof contact === "object" ?
    text((contact as {email?: unknown}).email) :
    "";

/**
 * A member's email: the contact document's, else the membership record's.
 * @param {object} member Membership record (its `email`, if any).
 * @param {unknown} contact Contact document data, if read.
 * @return {string} Trimmed email, or "".
 */
export const memberEmailOf = (
  member: {email?: unknown},
  contact: unknown,
): string => contactEmailOf(contact) || text(member.email);

/**
 * Membership records with `email` taken from each member's contact document
 * when it has one. Records without a contact email keep their own field.
 * @param {T[]} members Membership records (uid = document id).
 * @param {Map<string, unknown>} contacts Contact document data by uid.
 * @return {T[]} Records with the preferred email.
 */
export const withContactEmails = <T extends {uid: string; email?: unknown}>(
  members: T[],
  contacts: ReadonlyMap<string, unknown>,
): T[] => members.map((member) => {
    const email = contactEmailOf(contacts.get(member.uid));
    return email ? {...member, email} : member;
  });
