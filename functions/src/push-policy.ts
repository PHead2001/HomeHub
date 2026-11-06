// Pure decisions for push delivery, kept free of Firebase imports so they can
// be unit-tested. Notification documents are written by clients, so nothing in
// them is trusted: targets must be approved members and links must stay in
// the app.

export type MemberRecord = {
  uid: string;
  email?: unknown;
  role?: unknown;
  status?: unknown;
};

const APPROVED_ROLES = new Set(["owner", "admin", "member", "child", "guest"]);

/**
 * Whether a membership record is an approved, active member.
 * @param {MemberRecord} member Membership record.
 * @return {boolean} True for approved active members.
 */
export const isApprovedMember = (member: MemberRecord): boolean =>
  typeof member.role === "string" &&
  APPROVED_ROLES.has(member.role) &&
  (member.status === undefined || member.status === "active");

const emailOf = (member: MemberRecord): string[] =>
  typeof member.email === "string" && member.email ? [member.email] : [];

/**
 * Returns the emails of members who should receive a push. Targeted
 * notifications go only to that approved member; untargeted ones go to every
 * approved member (never to pending joiners or former members).
 * @param {MemberRecord[]} members Membership records of the household.
 * @param {Record<string, unknown>} notification The notification document.
 * @return {string[]} Recipient emails.
 */
export const selectRecipientEmails = (
  members: MemberRecord[],
  notification: Record<string, unknown>,
): string[] => {
  const approved = members.filter(isApprovedMember);
  const targetUid = notification.targetUserUid;
  const targetEmail = notification.targetUserEmail;

  if (typeof targetUid === "string") {
    return approved.filter((m) => m.uid === targetUid).flatMap(emailOf);
  }
  if (typeof targetEmail === "string") {
    const target = targetEmail.toLowerCase();
    return approved
      .filter((m) =>
        typeof m.email === "string" && m.email.toLowerCase() === target)
      .flatMap(emailOf);
  }
  return [...new Set(approved.flatMap(emailOf))];
};

/**
 * Only same-origin, path-relative links may be opened from a push.
 * @param {unknown} link Candidate deep link.
 * @return {string} A safe in-app path.
 */
export const safeDeepLink = (link: unknown): string => {
  if (typeof link !== "string") return "/";
  const trimmed = link.trim();
  if (!/^\/(?![/\\])/.test(trimmed) || trimmed.length > 300) return "/";
  return trimmed;
};

/**
 * Bounds user-provided text for notification payloads.
 * @param {unknown} value Candidate text.
 * @param {string} fallback Text used when value is empty.
 * @param {number} max Maximum length.
 * @return {string} Bounded text.
 */
export const clampText = (
  value: unknown,
  fallback: string,
  max: number,
): string => {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return fallback;
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};
