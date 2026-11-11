// Who a notification document is addressed to, stored on the document as
// `audience`: `[targetUserUid]` for a notification aimed at one member,
// `["*"]` for a household-wide one. Every producer (the web app's builder,
// the upkeep function, the household server actions, the backfill and the
// e2e seed) derives it here so the stored value cannot drift. Pure (no
// Firebase imports).

/** The audience entry that means every member of the household. */
export const AUDIENCE_EVERYONE = "*";

type AudienceTarget = {targetUserUid?: unknown; targetUserEmail?: unknown};

const text = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

/**
 * The `audience` value for a notification.
 * - a `targetUserUid` gives `[uid]`;
 * - a legacy email-only target gives `[uid]` when `uidForEmail` knows the
 *   member, otherwise `[]` (nobody: the target cannot be named by uid);
 * - no target gives `["*"]`.
 * @param {AudienceTarget} target The notification's targeting fields.
 * @param {Function} uidForEmail Optional lookup from a member email to uid.
 * @return {string[]} The audience list.
 */
export const notificationAudience = (
  target: AudienceTarget,
  uidForEmail?: (email: string) => string | null | undefined,
): string[] => {
  const uid = text(target.targetUserUid);
  if (uid) return [uid];
  const email = text(target.targetUserEmail);
  if (email) {
    const resolved = text(uidForEmail ? uidForEmail(email) : null);
    return resolved ? [resolved] : [];
  }
  return [AUDIENCE_EVERYONE];
};

/**
 * Whether a stored value is already a well-formed audience list.
 * @param {unknown} value The document's `audience` field.
 * @return {boolean} True for an array of strings.
 */
export const hasAudience = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === "string");

/**
 * Builds an email to uid lookup from a household's membership records
 * (case-insensitive on the email).
 * @param {object[]} members Membership records (`uid`, `email`).
 * @return {Function} Lookup usable as `uidForEmail`.
 */
export const memberUidByEmail = (
  members: Array<{uid?: unknown; email?: unknown}>,
): ((email: string) => string | null) => {
  const byEmail = new Map<string, string>();
  for (const member of members) {
    const uid = text(member.uid);
    const email = text(member.email);
    if (uid && email && !byEmail.has(email.toLowerCase())) {
      byEmail.set(email.toLowerCase(), uid);
    }
  }
  return (email) => byEmail.get(email.toLowerCase()) ?? null;
};

/**
 * The `audience` values a member's list queries ask for:
 * `where("audience", "array-contains-any", audienceQueryValues(uid))`.
 * The read rule accepts exactly the documents whose audience names the
 * caller or everyone, so every client list query carries this filter.
 * @param {string} uid The signed-in member's uid.
 * @return {string[]} `[uid, "*"]`.
 */
export const audienceQueryValues = (uid: string): string[] =>
  [uid, AUDIENCE_EVERYONE];

type AddressedNotification = {
  [field: string]: unknown;
  audience?: unknown;
  targetUserUid?: unknown;
  targetUserEmail?: unknown;
};

/**
 * Whether a notification is addressed to a member. A stored `audience`
 * decides on its own: it names the member's uid or `"*"`. A document
 * written before the field existed falls back to the old targeting: a
 * `targetUserUid` must be the member, a `targetUserEmail` must be the
 * member's email (case-insensitive), and an untargeted one is for everyone.
 * Category permission is a separate check (push-audience.ts).
 * @param {AddressedNotification} notification The notification document.
 * @param {object} member The member (`uid`, optional `email`).
 * @return {boolean} True when the member is in the notification's audience.
 */
export const isAddressedToMember = (
  notification: AddressedNotification,
  member: {uid: string; email?: string | null},
): boolean => {
  if (hasAudience(notification.audience)) {
    return notification.audience.includes(AUDIENCE_EVERYONE) ||
      notification.audience.includes(member.uid);
  }
  const uid = text(notification.targetUserUid);
  if (uid) return uid === member.uid;
  const email = text(notification.targetUserEmail);
  if (email) {
    return typeof member.email === "string" &&
      email.toLowerCase() === member.email.toLowerCase();
  }
  return true;
};
