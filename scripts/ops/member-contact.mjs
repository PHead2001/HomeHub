// Pure decisions for backfill-member-contact.mjs. No Firebase imports, so
// tests/unit/household-member-contact.test.ts can cover them. The contact
// document is `households/{id}/members/{uid}/private/contact` with
// `{ email, updatedAt }` (household-governance README, "Member contact").

const text = value => (typeof value === 'string' ? value.trim() : '');

/**
 * What the backfill does for one member.
 * @param {Record<string, unknown> | null | undefined} member Membership record data.
 * @param {Record<string, unknown> | null | undefined} contact Contact document data, or null when it does not exist.
 * @returns {{ kind: 'no-email' | 'present' } | { kind: 'missing' | 'different', email: string }}
 *   - `no-email`: the record carries no usable email; nothing to copy;
 *   - `present`: the contact document already holds the record's email;
 *   - `missing`: no contact document yet: create it;
 *   - `different`: the contact document holds another (or no) email: update it.
 */
export function contactBackfillDecision(member, contact) {
  const email = text(member?.email);
  if (!email) return { kind: 'no-email' };
  if (!contact) return { kind: 'missing', email };
  return text(contact.email) === email ? { kind: 'present' } : { kind: 'different', email };
}

/**
 * The contact document written for a decision that needs one.
 * @param {string} email
 * @param {Date} now
 * @returns {{ email: string, updatedAt: string }}
 */
export function contactDocument(email, now) {
  return { email, updatedAt: now.toISOString() };
}
