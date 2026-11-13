// A member's email, read from their protected contact document.
// Shared by the web app and the Cloud Functions (pure, no Firebase).
//
// A member's email lives only in
// `households/{id}/members/{uid}/private/contact` (`{email, updatedAt}`),
// which only the server writes and only the person and member managers can
// read. Membership records carry no email (older records may still hold one
// until scripts/ops/scrub-member-emails.mjs removes it); readers never use it.

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
 * A member's email: the one in their contact document. A legacy `email` on
 * the membership record is ignored.
 * @param {object} _member Membership record (unused; kept for callers).
 * @param {unknown} contact Contact document data, if read.
 * @return {string} Trimmed email, or "".
 */
export const memberEmailOf = (
  _member: {email?: unknown},
  contact: unknown,
): string => contactEmailOf(contact);

/**
 * Membership records with `email` set from each member's contact document.
 * A record without a contact email gets none: any legacy `email` on the
 * record is dropped, never used.
 * @param {T[]} members Membership records (uid = document id).
 * @param {Map<string, unknown>} contacts Contact document data by uid.
 * @return {T[]} Records whose `email` is the contact document's, if any.
 */
export const withContactEmails = <T extends {uid: string; email?: unknown}>(
  members: T[],
  contacts: ReadonlyMap<string, unknown>,
): T[] => members.map((member) => {
    const email = contactEmailOf(contacts.get(member.uid));
    if (email) return {...member, email};
    if (!("email" in member)) return member;
    const rest = {...member};
    delete rest.email;
    return rest;
  });
