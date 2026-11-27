/**
 * Daily chore reminder settings (PR-4, PR-5). Server upkeep runs once an hour, so a
 * reminder is chosen by the hour and promised "around" that time; minutes would
 * promise a precision the server cannot keep. Reminders follow the household's time
 * zone (D-6). Pure; tests/unit/profile-reminders.test.ts.
 */
export const DEFAULT_REMINDER_HOUR = 17;
export const REMINDER_HOURS = Array.from({ length: 24 }, (_, hour) => hour);

/** The hour of a stored "HH:MM" (an older minute choice keeps its hour); the default when unreadable. */
export function reminderHourFrom(stored: unknown): number {
  if (typeof stored !== 'string') return DEFAULT_REMINDER_HOUR;
  const match = /^(\d{1,2}):(\d{2})$/.exec(stored.trim());
  if (!match) return DEFAULT_REMINDER_HOUR;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  return hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59 ? hour : DEFAULT_REMINDER_HOUR;
}

/** The stored value for an hour: always on the hour. */
export function reminderTimeFor(hour: number): string {
  const clamped = Math.min(23, Math.max(0, Math.trunc(hour)));
  return `${String(clamped).padStart(2, '0')}:00`;
}

/** "5 PM" (or "17" style in a 24-hour locale), in the reader's locale. */
export function hourLabel(hour: number, locale?: string): string {
  try {
    return new Intl.DateTimeFormat(locale, { hour: 'numeric', timeZone: 'UTC' }).format(Date.UTC(2026, 0, 1, hour));
  } catch {
    return reminderTimeFor(hour);
  }
}

/** "Chicago" for "America/Chicago", "Port of Spain" for "America/Port_of_Spain"; null when unknown. */
export function zoneCityLabel(timeZone: string | null | undefined): string | null {
  if (typeof timeZone !== 'string' || !timeZone.trim()) return null;
  const city = timeZone.trim().split('/').pop() ?? '';
  return city ? city.replace(/_/g, ' ') : null;
}

/** The line under the reminder picker. */
export function reminderZoneNote(timeZone: string | null | undefined): string {
  const city = zoneCityLabel(timeZone);
  return city
    ? `Reminders follow your household's time zone (${city} time), wherever you are.`
    : "Reminders follow your household's time zone, wherever you are.";
}
