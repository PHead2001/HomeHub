/**
 * Pure helpers for the household records the server writes: household creation
 * (name, ID, time zone) and the daily pending-member reminder. No Firebase, no
 * React, so the server actions (`src/lib/server/household-membership.ts`) and
 * the Household Manager share them and unit tests run without an emulator.
 */

export const HOUSEHOLD_NAME_MAX = 80;
const HOUSEHOLD_ID_SUFFIX_CHARS = 'abcdefghjklmnpqrstuvwxyz23456789';
const TIME_ZONE_MAX = 64;

/** A pending person is reminded about at most once per this many hours. */
export const PENDING_REMINDER_INTERVAL_HOURS = 24;
export const PENDING_REMINDER_SOURCE_TYPE = 'household-newuser-reminder';

export type HouseholdNameCheck = { ok: true; name: string } | { ok: false; message: string };

/** Trims and checks a household name (1-80 characters, as the rules require). */
export const readHouseholdName = (raw: unknown): HouseholdNameCheck => {
  const name = typeof raw === 'string' ? raw.trim() : '';
  if (!name) return { ok: false, message: 'Give your household a name.' };
  if (name.length > HOUSEHOLD_NAME_MAX) return { ok: false, message: `Keep it under ${HOUSEHOLD_NAME_MAX} characters.` };
  return { ok: true, name };
};

/** Lowercase ASCII slug of a household name; `household` when nothing is left. */
export const slugifyHouseholdName = (name: string): string => {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'household';
};

/**
 * Household ID: the slugified name plus a four-character suffix. `pick(n)`
 * returns an integer in [0, n) (the server passes a cryptographic one).
 */
export const householdIdFor = (name: string, pick: (n: number) => number): string => {
  const suffix = Array.from({ length: 4 }, () => HOUSEHOLD_ID_SUFFIX_CHARS[pick(HOUSEHOLD_ID_SUFFIX_CHARS.length)]).join('');
  return `${slugifyHouseholdName(name)}-${suffix}`;
};

/** A valid IANA time zone of at most 64 characters, or undefined (upkeep then uses its default). */
export const normalizeTimeZone = (value: unknown): string | undefined => {
  if (typeof value !== 'string' || !value || value.length > TIME_ZONE_MAX) return undefined;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return value;
  } catch {
    return undefined;
  }
};

const toInstant = (value: unknown): Date | null => {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

/** Whether a pending person is due a reminder: never reminded, unreadable, or 24 hours or more ago. */
export const pendingReminderDue = (lastReminderAt: unknown, now: Date): boolean => {
  const last = toInstant(lastReminderAt);
  if (!last) return true;
  return now.getTime() - last.getTime() >= PENDING_REMINDER_INTERVAL_HOURS * 60 * 60 * 1000;
};

/**
 * Per-day notification state (UTC date), so overlapping visits on the same day
 * write the same notification document instead of a duplicate.
 */
export const pendingReminderStateKey = (now: Date): string => `pending|${now.toISOString().slice(0, 10)}`;

/**
 * The photo for a new membership. A photo removed in Profile is saved as
 * `avatarUrl: null` and stays removed (as does ''); a non-empty string wins; only
 * a profile with no avatarUrl field at all falls back to the ID token's picture.
 */
export const membershipAvatarUrl = (profile: Record<string, unknown> | undefined, tokenAvatarUrl?: string): string | undefined => {
  if (profile && Object.prototype.hasOwnProperty.call(profile, 'avatarUrl')) {
    return typeof profile.avatarUrl === 'string' && profile.avatarUrl ? profile.avatarUrl : undefined;
  }
  return tokenAvatarUrl || undefined;
};
