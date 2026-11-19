/**
 * The zone "today" is computed in (D-6), without React: importable from any server code
 * (the server's tablet operations for Pets read the same household day as the app).
 * `src/lib/household-day.ts` re-exports these and adds the client hook.
 */
import { DEFAULT_TIME_ZONE } from '../../functions/src/shared/calendar';

export const validZone = (timeZone: unknown): timeZone is string => {
  if (typeof timeZone !== 'string' || !timeZone) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format(0);
    return true;
  } catch {
    return false;
  }
};

/** The device's IANA zone (UTC where the runtime cannot say). */
export function deviceTimeZone(): string {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return validZone(zone) ? zone : 'UTC';
  } catch {
    return 'UTC';
  }
}

/**
 * The zone "today" is computed in: the household's, else the same default the server
 * uses for reminders and recurring chores (`DEFAULT_TIME_ZONE`), so the dashboard and
 * the server never disagree about the day.
 */
export function householdDayZone(timeZone?: string | null): string {
  return validZone(timeZone) ? timeZone : DEFAULT_TIME_ZONE;
}
