/**
 * "Message the house" (NO-25): an owner or admin posts a short household-wide message
 * ("Dinner at 6", "Plumber coming 2 pm"). It is a `general` notification addressed to
 * everyone (`['*']`) with `sourceType: 'house-announcement'`, written only by the server
 * (src/lib/server/house-announcements.ts), shown in every member's bell and pinned in
 * registered wall tablets' top bar until it expires; a push to phones is optional. Pure:
 * shared by the form, the server and the tablet.
 */
export const HOUSE_ANNOUNCEMENT_SOURCE_TYPE = 'house-announcement';
export const HOUSE_ANNOUNCEMENT_MAX_LENGTH = 200;
/** How long a message stays up, in hours (the notification's expiry; at most the 7-day window). */
export const HOUSE_ANNOUNCEMENT_HOURS = [2, 6, 12, 24, 72] as const;
export const HOUSE_ANNOUNCEMENT_DEFAULT_HOURS = 12;

export type HouseAnnouncementInput = { message: string; hours: number; push: boolean };

export type HouseAnnouncementValidation =
  | { ok: true; value: HouseAnnouncementInput }
  | { ok: false; message: string };

// Control characters other than newline are refused (they could hide text in a push).
const CONTROL = /[\x00-\x09\x0b-\x1f\x7f]/;

export function validateHouseAnnouncement(input: unknown): HouseAnnouncementValidation {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, message: 'Write a message.' };
  const { message, hours, push } = input as Record<string, unknown>;
  if (typeof message !== 'string' || !message.trim()) return { ok: false, message: 'Write a message.' };
  const text = message.trim().replace(/\r\n?/g, '\n');
  if (text.length > HOUSE_ANNOUNCEMENT_MAX_LENGTH) return { ok: false, message: `Keep it under ${HOUSE_ANNOUNCEMENT_MAX_LENGTH} characters.` };
  if (CONTROL.test(text)) return { ok: false, message: 'Use plain text.' };
  if (typeof hours !== 'number' || !(HOUSE_ANNOUNCEMENT_HOURS as readonly number[]).includes(hours)) return { ok: false, message: 'Choose how long it stays up.' };
  if (typeof push !== 'boolean') return { ok: false, message: 'Choose whether to send a push.' };
  return { ok: true, value: { message: text, hours, push } };
}

/** The newest house message still up, for the tablet's top bar (NO-25). */
export function pinnedAnnouncement<T extends { category: string; sourceType?: string | null; createdAt: Date | null; expiresAt?: Date | null }>(
  notices: T[],
  nowMs: number,
): T | null {
  // `general` too: members may create household-wide notices in their own module
  // categories with any sourceType, but only owners and admins can create `general`
  // ones, so nobody else can pin a message on the wall.
  const live = notices.filter((notice) => notice.category === 'general' && notice.sourceType === HOUSE_ANNOUNCEMENT_SOURCE_TYPE
    && (!notice.expiresAt || notice.expiresAt.getTime() > nowMs));
  live.sort((a, b) => (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0));
  return live[0] ?? null;
}
