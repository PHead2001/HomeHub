// Pure decisions for backfill-notification-audience.mjs and the e2e seed. No
// Firebase imports, so tests/unit/notifications-audience-field.test.ts can
// cover them. `audienceForNotification` is the plain-JavaScript twin of
// `notificationAudience` in functions/src/shared/notification-audience.ts
// (these scripts run without a TypeScript loader); that test checks the two
// agree case by case.

/** The audience entry that means every member of the household. */
export const AUDIENCE_EVERYONE = '*';

const text = value => (typeof value === 'string' && value.length > 0 ? value : null);

/**
 * Whether a stored `audience` is already a list of strings.
 * @param {unknown} value
 * @returns {boolean}
 */
export const hasAudience = value => Array.isArray(value) && value.every(entry => typeof entry === 'string');

/**
 * Email (case-insensitive) to uid lookup from a household's member documents.
 * @param {Array<{ uid?: unknown, email?: unknown }>} members
 * @returns {(email: string) => string | null}
 */
export function memberUidByEmail(members) {
  const byEmail = new Map();
  for (const member of members) {
    const uid = text(member?.uid);
    const email = text(member?.email);
    if (uid && email && !byEmail.has(email.toLowerCase())) byEmail.set(email.toLowerCase(), uid);
  }
  return email => byEmail.get(email.toLowerCase()) ?? null;
}

/**
 * What the backfill does with one notification document.
 * @param {Record<string, unknown> | null | undefined} data Notification data.
 * @param {(email: string) => string | null | undefined} [uidForEmail]
 * @returns {{ kind: 'present' } | { kind: 'uid' | 'email' | 'everyone' | 'unresolvable', audience: string[] }}
 *   `present`: it already has an audience and is left alone. Otherwise the
 *   list to write: `[targetUserUid]`; for a legacy email-only target `[uid]`
 *   when the lookup knows the member and `[]` when it does not; `['*']` for a
 *   household-wide notification.
 */
export function backfillDecision(data, uidForEmail) {
  if (hasAudience(data?.audience)) return { kind: 'present' };
  const uid = text(data?.targetUserUid);
  if (uid) return { kind: 'uid', audience: [uid] };
  const email = text(data?.targetUserEmail);
  if (email) {
    const resolved = text(uidForEmail ? uidForEmail(email) : null);
    return resolved ? { kind: 'email', audience: [resolved] } : { kind: 'unresolvable', audience: [] };
  }
  return { kind: 'everyone', audience: [AUDIENCE_EVERYONE] };
}

/**
 * The `audience` a new notification with these targeting fields carries.
 * @param {{ targetUserUid?: unknown, targetUserEmail?: unknown }} data
 * @param {(email: string) => string | null | undefined} [uidForEmail]
 * @returns {string[]}
 */
export function audienceForNotification(data, uidForEmail) {
  return backfillDecision({ targetUserUid: data?.targetUserUid, targetUserEmail: data?.targetUserEmail }, uidForEmail).audience;
}

/**
 * Whether deciding needs the household's members (an email-only target).
 * @param {Record<string, unknown> | null | undefined} data Notification data.
 * @returns {boolean}
 */
export const needsMemberLookup = data =>
  !hasAudience(data?.audience) && !text(data?.targetUserUid) && Boolean(text(data?.targetUserEmail));
