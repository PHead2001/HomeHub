/**
 * Member choices kept on the membership record, which every approved housemate can
 * read (audit PR-24, PR-25). Pure; tests/unit/profile-extras.test.ts. The server
 * (`setMemberColor`, `setMyBirthday` in src/lib/server/household-membership.ts)
 * validates with the same functions.
 */
import { MEMBER_COLOR_COUNT } from '@/lib/theme/tokens';

/** A member colour slot 1-8, or null to go back to the automatic colour. */
export function parseMemberColor(value: unknown): number | null | undefined {
  if (value === null) return null;
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= MEMBER_COLOR_COUNT ? value : undefined;
}

export type Birthday = { month: number; day: number };

const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/**
 * An opt-in birthday: month and day only (no year, so no age), typed by the person.
 * February 29 is allowed. Undefined when invalid; null clears it.
 */
export function parseBirthday(value: unknown): Birthday | null | undefined {
  if (value === null) return null;
  if (typeof value !== 'object' || value === null) return undefined;
  const { month, day } = value as Record<string, unknown>;
  if (typeof month !== 'number' || typeof day !== 'number' || !Number.isInteger(month) || !Number.isInteger(day)) return undefined;
  if (month < 1 || month > 12) return undefined;
  if (day < 1 || day > DAYS_IN_MONTH[month - 1]) return undefined;
  return { month, day };
}

/**
 * Whether a birthday falls on a household day ("YYYY-MM-DD", already in the household's
 * time zone, D-6). A February 29 birthday is celebrated on February 28 in other years.
 */
export function isBirthdayOn(birthday: Birthday | null | undefined, householdDay: string): boolean {
  if (!birthday) return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(householdDay);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (birthday.month === month && birthday.day === day) return true;
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  return !leap && birthday.month === 2 && birthday.day === 29 && month === 2 && day === 28;
}

/** First names of approved members whose birthday is on this household day. */
export function birthdayNamesOn(
  records: ReadonlyArray<Record<string, unknown>>,
  householdDay: string,
): string[] {
  const names: string[] = [];
  for (const record of records) {
    const status = record.status ?? 'active';
    if (status !== 'active' || record.role === 'newuser') continue;
    if (!isBirthdayOn(parseBirthday(record.birthday) ?? null, householdDay)) continue;
    const name = typeof record.displayName === 'string' ? record.displayName.trim() : '';
    if (!name || /\S+@\S+/.test(name)) continue;
    names.push(name.split(/\s+/)[0]);
  }
  return names.sort((a, b) => a.localeCompare(b));
}

/** "Happy birthday, Sam!" / "Happy birthday, Sam and Mia!" */
export function birthdayGreeting(names: readonly string[]): string | null {
  if (names.length === 0) return null;
  const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  return `Happy birthday, ${list}!`;
}

/** A nickname for the greeting: one word (letters, digits, ' or -), up to 20 characters. */
export const NICKNAME_MAX = 20;
export function nicknameError(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > NICKNAME_MAX) return `Keep it to ${NICKNAME_MAX} characters.`;
  if (!/^[\p{L}\p{N}'’-]+$/u.test(trimmed)) return 'One word, like Mom, Grandpa or Sam.';
  return null;
}
