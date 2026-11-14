// Household quiet hours (docs/modules/devices/README.md, "Night dimming"; design 14.4,
// D-T1, WT-14g, JC-20). `households/{h}.quietHours = { start: 'HH:mm', end: 'HH:mm' }`
// in the household's time zone, or absent/null for none. Written only by the server
// (owners and admins, `updateQuietHoursAction`); wall tablets dim their screen during
// them. Push muting by these hours is not part of this goal. Pure: shared by the server
// validation, the Household settings form and the tablet.

import { localMinutes, parseTimeOfDay, safeTimeZone } from '@functions/shared/calendar';

export type QuietHours = { start: string; end: string };

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

const isTime = (value: unknown): value is string => typeof value === 'string' && TIME.test(value);

/** The stored setting, or null when absent or malformed (no dimming). */
export function readQuietHours(value: unknown): QuietHours | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const { start, end } = value as { start?: unknown; end?: unknown };
  if (!isTime(start) || !isTime(end) || start === end) return null;
  return { start, end };
}

export type QuietHoursValidation =
  | { ok: true; value: QuietHours | null }
  | { ok: false; message: string };

/** A submitted setting: `null` turns quiet hours off; otherwise two different `HH:mm` times. */
export function validateQuietHours(input: unknown): QuietHoursValidation {
  if (input === null) return { ok: true, value: null };
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, message: 'Choose a start and an end time.' };
  const keys = Object.keys(input);
  if (keys.length !== 2 || !keys.includes('start') || !keys.includes('end')) return { ok: false, message: 'Choose a start and an end time.' };
  const { start, end } = input as { start: unknown; end: unknown };
  if (!isTime(start) || !isTime(end)) return { ok: false, message: 'Use times like 21:30.' };
  if (start === end) return { ok: false, message: 'The start and end must differ.' };
  return { ok: true, value: { start, end } };
}

/**
 * Whether `now` falls inside quiet hours in the household's zone. The start minute is
 * inside, the end minute is not; a range like 22:00-07:00 crosses midnight. DST needs no
 * special case: the wall-clock minute in the zone decides.
 */
export function isQuietAt(quietHours: QuietHours | null, timeZone: string | null | undefined, now: Date): boolean {
  if (!quietHours) return false;
  const start = parseTimeOfDay(quietHours.start);
  const end = parseTimeOfDay(quietHours.end);
  if (start === null || end === null || start === end) return false;
  const minute = localMinutes(now, safeTimeZone(timeZone));
  return start < end ? minute >= start && minute < end : minute >= start || minute < end;
}

/** "22:00 to 07:00" for settings summaries. */
export const describeQuietHours = (quietHours: QuietHours | null): string =>
  quietHours ? `${quietHours.start} to ${quietHours.end}` : 'Off';
