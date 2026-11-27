/**
 * iCalendar (RFC 5545) text for the household's phone calendar feed (audit CA-25).
 * Pure and framework-free: `src/lib/server/calendar-feed.ts` builds the events and
 * the route handler `src/app/api/calendar-feed/[token]/route.ts` serves this text.
 *
 * Every event is an all-day event (`DTSTART;VALUE=DATE`, with the exclusive next
 * day as `DTEND`): chores, maintenance, expiries and doses are kept by day in the
 * household's time zone, so a phone in another zone still shows them on that day.
 * Lines end in CRLF and are folded at 75 octets (UTF-8 bytes, never inside a
 * character); text values escape backslash, semicolon, comma and line breaks.
 */

export type IcsEvent = {
  /** Stable across fetches (the calendar event id), so phones update rather than duplicate. */
  uid: string;
  /** `YYYY-MM-DD` in the household's time zone. */
  day: string;
  summary: string;
  description?: string;
  /** A path inside the app (`/chores?...`) or an absolute URL. */
  url?: string;
  categories?: string[];
};

export type IcsCalendar = { name: string; now: Date; baseUrl?: string };

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** `YYYYMMDD` of a day key. */
export function icsDate(day: string): string {
  const match = DAY.exec(day);
  if (!match) throw new Error(`Not a day: ${day}`);
  return `${match[1]}${match[2]}${match[3]}`;
}

/** The day after `day` (DTEND of an all-day event is exclusive). */
export function nextDay(day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d + 1));
  return date.toISOString().slice(0, 10);
}

/** UTC timestamp in the basic format (`20261105T150000Z`). */
export function icsTimestamp(date: Date): string {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

/** Escapes a TEXT value (RFC 5545 3.3.11). */
export function escapeText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n');
}

const encoder = new TextEncoder();

/**
 * Folds one content line at 75 octets: continuation lines start with one space
 * (which counts toward their 75). A multi-byte character is never split.
 */
export function foldLine(line: string): string {
  if (encoder.encode(line).length <= 75) return line;
  const parts: string[] = [];
  let current = '';
  let bytes = 0;
  let limit = 75;
  for (const char of line) {
    const size = encoder.encode(char).length;
    if (bytes + size > limit) {
      parts.push(current);
      current = '';
      bytes = 0;
      limit = 74; // the leading space takes one octet
    }
    current += char;
    bytes += size;
  }
  parts.push(current);
  return parts.join('\r\n ');
}

/** A UID safe for any client: the event id with anything unusual replaced, plus the domain part. */
export function icsUid(id: string): string {
  return `${id.replace(/[^A-Za-z0-9._:-]/g, '_')}@homehub`;
}

/** The whole calendar, CRLF line endings, ending with a CRLF. */
export function buildIcs(events: readonly IcsEvent[], calendar: IcsCalendar): string {
  const stamp = icsTimestamp(calendar.now);
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//HomeHub//Household calendar//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeText(calendar.name)}`,
    'REFRESH-INTERVAL;VALUE=DURATION:PT1H',
    'X-PUBLISHED-TTL:PT1H',
  ];
  const seen = new Set<string>();
  for (const event of events) {
    if (!DAY.test(event.day)) continue;
    const uid = icsUid(event.uid);
    if (seen.has(uid)) continue;
    seen.add(uid);
    const url = event.url && calendar.baseUrl && event.url.startsWith('/') ? `${calendar.baseUrl.replace(/\/$/, '')}${event.url}` : event.url;
    lines.push(
      'BEGIN:VEVENT',
      `UID:${uid}`,
      `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${icsDate(event.day)}`,
      `DTEND;VALUE=DATE:${icsDate(nextDay(event.day))}`,
      `SUMMARY:${escapeText(event.summary)}`,
      ...(event.description ? [`DESCRIPTION:${escapeText(event.description)}`] : []),
      ...(url && /^https?:\/\//.test(url) ? [`URL:${url}`] : []),
      ...(event.categories && event.categories.length > 0 ? [`CATEGORIES:${event.categories.map(escapeText).join(',')}`] : []),
      'TRANSP:TRANSPARENT',
      'END:VEVENT',
    );
  }
  lines.push('END:VCALENDAR');
  return lines.map(foldLine).join('\r\n') + '\r\n';
}
