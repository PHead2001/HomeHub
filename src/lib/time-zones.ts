/**
 * Time zone choices for the household setting (HO-19). Pure: the list comes from the
 * runtime (`Intl.supportedValuesOf`), with a short fallback for older browsers; the
 * stored zone is always offered even when the runtime does not list it (aliases).
 */

const FALLBACK_ZONES = [
  'America/New_York', 'America/Chicago', 'America/Denver', 'America/Phoenix', 'America/Los_Angeles',
  'America/Anchorage', 'Pacific/Honolulu', 'Europe/London', 'Europe/Paris', 'Europe/Berlin',
  'Asia/Tokyo', 'Asia/Kolkata', 'Australia/Sydney', 'UTC',
];

type IntlWithZones = typeof Intl & { supportedValuesOf?: (key: 'timeZone') => string[] };

export function timeZoneOptions(current?: string | null, intl: IntlWithZones = Intl as IntlWithZones): string[] {
  let zones: string[] = [];
  try {
    zones = typeof intl.supportedValuesOf === 'function' ? intl.supportedValuesOf('timeZone') : [];
  } catch {
    zones = [];
  }
  const list = zones.length > 0 ? [...zones] : [...FALLBACK_ZONES];
  if (current && !list.includes(current)) list.push(current);
  return list.sort((a, b) => a.localeCompare(b));
}

/** "America/Chicago" as "America / Chicago (UTC-05:00)" at `at`; the bare name when the runtime cannot format it. */
export function timeZoneLabel(zone: string, at: Date = new Date()): string {
  const name = zone.replace(/_/g, ' ').replace(/\//g, ' / ');
  try {
    const part = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'longOffset' })
      .formatToParts(at).find((p) => p.type === 'timeZoneName')?.value;
    const offset = part === 'GMT' ? 'UTC' : part?.replace('GMT', 'UTC');
    return offset ? `${name} (${offset})` : name;
  } catch {
    return name;
  }
}
