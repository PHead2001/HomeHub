// Pure decisions for push delivery, kept free of Firebase imports so they can
// be unit-tested. Notification documents are written by clients, so nothing in
// them is trusted: targets must be approved members and links must stay in
// the app.

import {safePushLink} from "./shared/push-link";
import {isAddressedToMember} from "./shared/notification-audience";

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
 * Returns the emails of members who should receive a push. A stored
 * `audience` decides: `[uid]` selects exactly that approved member, `["*"]`
 * every approved member, `[]` nobody. A document without `audience` (written
 * before the field existed) falls back to `targetUserUid`, then
 * `targetUserEmail`, then everyone. Never pending joiners or former members.
 * The same addressing check (`isAddressedToMember`) decides what the bell,
 * center, dashboard and AI overview show. Category permission is applied
 * afterwards by the caller (`filterRecipientsByCategory`).
 * @param {MemberRecord[]} members Membership records of the household.
 * @param {Record<string, unknown>} notification The notification document.
 * @return {string[]} Recipient emails.
 */
export const selectRecipientEmails = (
  members: MemberRecord[],
  notification: Record<string, unknown>,
): string[] => {
  const recipients = members.filter(isApprovedMember).filter((member) =>
    isAddressedToMember(notification, {
      uid: member.uid,
      email: typeof member.email === "string" ? member.email : null,
    }));
  return [...new Set(recipients.flatMap(emailOf))];
};

/**
 * Only same-origin, path-relative links may be opened from a push. This is
 * the same function the service worker embeds (shared/push-link.ts), so the
 * two layers cannot drift.
 * @param {unknown} link Candidate deep link.
 * @return {string} A safe in-app path.
 */
export const safeDeepLink = (link: unknown): string => safePushLink(link);

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

/**
 * Whether a newly created notification is pushed. Upkeep marks a document
 * `silent` when the person was already told today (for example the overdue
 * notification on a day the daily reminder carries the overdue count).
 * Clients cannot set the field (it is not in the rules' create allow-list).
 * @param {Record<string, unknown>} data The created document.
 * @return {boolean} True to push.
 */
export const pushOnCreate = (data: Record<string, unknown>): boolean =>
  data.silent !== true;

type Instant = {seconds?: unknown; nanoseconds?: unknown};

const sameInstant = (left: unknown, right: unknown): boolean => {
  if (!left || !right || typeof left !== "object" ||
      typeof right !== "object") {
    return left === right;
  }
  const a = left as Instant;
  const b = right as Instant;
  return a.seconds === b.seconds && a.nanoseconds === b.nanoseconds;
};

/**
 * Whether an updated notification is pushed again: only when upkeep moved its
 * `renotifyAt` (the overdue notification gained a chore). Read, dismiss,
 * refresh and resolve updates leave it alone; clients cannot write it (the
 * rules let them change only their own read and dismiss entries).
 * @param {Record<string, unknown>} before Document before the update.
 * @param {Record<string, unknown>} after Document after the update.
 * @return {boolean} True to push.
 */
export const pushOnUpdate = (
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): boolean => Boolean(after.renotifyAt) &&
  !sameInstant(before.renotifyAt, after.renotifyAt) && !after.resolvedAt;
