// Pure mapping for backfill-feeding-state.mjs. No Firebase imports, so
// tests/server/feeding-state-backfill.test.ts can cover it. The household day
// is the plain-JavaScript twin of `localDay` in functions/src/shared/calendar.ts
// (these scripts run without a TypeScript loader); that test checks they agree.

export const DEFAULT_TIME_ZONE = 'America/Chicago';

/**
 * A usable IANA zone, else the default household zone.
 * @param {unknown} timeZone
 * @returns {string}
 */
export function safeTimeZone(timeZone) {
  if (typeof timeZone !== 'string' || !timeZone) return DEFAULT_TIME_ZONE;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format(0);
    return timeZone;
  } catch {
    return DEFAULT_TIME_ZONE;
  }
}

/**
 * `yyyy-MM-dd` of an instant in a time zone.
 * @param {Date} instant
 * @param {string} timeZone
 * @returns {string}
 */
export function localDay(instant, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(instant);
  const get = type => parts.find(part => part.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/**
 * A stored feeding date (Firestore Timestamp, Date, ISO string or millis) as a Date.
 * @param {unknown} value
 * @returns {Date | null}
 */
export function toDate(value) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === 'string' || typeof value === 'number') {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  if (value && typeof value === 'object' && typeof value.toDate === 'function') return toDate(value.toDate());
  return null;
}

const text = value => (typeof value === 'string' && value.length > 0 ? value : null);

/**
 * The `feeding-state/current` document for a pet that has none, from its newest
 * feeding logs (both date shapes, any order): the newest log becomes the latest
 * feed, and `countOnDay` counts the logs on that log's household day among
 * those read. `lastFedAt` is a Date (the script stores it as a Timestamp).
 * Returns null when no log has a readable date (no state: clients treat the pet
 * as "no recent feed known").
 * @param {Array<{ id: string, date?: unknown, loggedByUid?: unknown, loggedByName?: unknown }>} logs
 * @param {unknown} timeZone `household.timeZone`
 * @param {Date} [now] Entries more than a minute after this are ignored (device clocks ahead).
 * @returns {null | { lastLogId: string, lastFedAt: Date, lastFedByUid: string | null, lastFedByName: string | null, day: string, countOnDay: number, prev: null }}
 */
export function feedingStateFromLogs(logs, timeZone, now = new Date()) {
  const zone = safeTimeZone(timeZone);
  const dated = [];
  for (const log of logs) {
    const date = toDate(log?.date);
    if (!date || date.getTime() > now.getTime() + 60_000 || !text(log.id)) continue;
    dated.push({ log, date });
  }
  if (dated.length === 0) return null;
  dated.sort((a, b) => b.date.getTime() - a.date.getTime());
  const newest = dated[0];
  const day = localDay(newest.date, zone);
  const countOnDay = dated.filter(entry => localDay(entry.date, zone) === day).length;
  const name = text(newest.log.loggedByName);
  return {
    lastLogId: newest.log.id,
    lastFedAt: newest.date,
    lastFedByUid: text(newest.log.loggedByUid),
    lastFedByName: name ? name.trim().slice(0, 200) : null,
    day,
    countOnDay: Math.min(countOnDay, 1000),
    prev: null,
  };
}
