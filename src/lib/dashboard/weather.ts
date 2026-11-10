/**
 * Opt-in live weather (H02, H22). Uses Open-Meteo, which is free and needs no key:
 * the city name goes to its geocoding endpoint, and the coordinates that come back
 * go to its forecast endpoint. Nothing else about the household is ever sent.
 * Results are cached per city for 30 minutes; any failure returns null so the UI
 * simply hides the weather.
 */

export const GEOCODING_ENDPOINT = 'https://geocoding-api.open-meteo.com/v1/search';
export const FORECAST_ENDPOINT = 'https://api.open-meteo.com/v1/forecast';
export const WEATHER_TTL_MS = 30 * 60_000;
/** After a failed refresh, try again this much later (the last good report stays, marked stale). */
export const WEATHER_RETRY_MS = 5 * 60_000;
/** A last good report older than this is no longer shown, even as stale. */
export const WEATHER_STALE_MAX_MS = 3 * 60 * 60_000;
export const WEATHER_CACHE_KEY = 'homehub.dashboard.weather';
export const MAX_CITY_LENGTH = 80;

export type WeatherKind = 'clear' | 'partly' | 'cloudy' | 'fog' | 'drizzle' | 'rain' | 'snow' | 'storm';
/** Ambient effect drawn on the house and shell (never under reduced motion). */
export type WeatherEffect = 'rain' | 'snow' | 'glint' | null;
export type TemperatureUnit = 'fahrenheit' | 'celsius';

export type WeatherReport = {
  /** The city as the member typed it (normalized), which is the cache key. */
  city: string;
  /** Place name Open-Meteo matched, e.g. "Austin". */
  place: string;
  temperature: number;
  unit: TemperatureUnit;
  code: number;
  isDay: boolean;
  kind: WeatherKind;
  label: string;
  effect: WeatherEffect;
  fetchedAt: number;
};

export type WeatherPreference = { enabled: boolean; city: string };

export const DEFAULT_WEATHER_PREFERENCE: WeatherPreference = { enabled: false, city: '' };

/** Trims, collapses spaces and caps the length. */
export function normalizeCity(city: unknown): string {
  if (typeof city !== 'string') return '';
  return city.replace(/\s+/g, ' ').trim().slice(0, MAX_CITY_LENGTH);
}

/** Reads `users/{email}.preferences.weather` defensively (missing or malformed means off). */
export function parseWeatherPreference(value: unknown): WeatherPreference {
  if (!value || typeof value !== 'object') return { ...DEFAULT_WEATHER_PREFERENCE };
  const record = value as Record<string, unknown>;
  return { enabled: record.enabled === true, city: normalizeCity(record.city) };
}

/** WMO weather interpretation codes (Open-Meteo `weather_code`) → kind, label and effect. */
export function weatherFromCode(code: number, isDay: boolean): { kind: WeatherKind; label: string; effect: WeatherEffect } {
  const pick = (kind: WeatherKind, label: string, effect: WeatherEffect) => ({ kind, label, effect });
  if (code === 0) return pick('clear', isDay ? 'Sunny' : 'Clear', isDay ? 'glint' : null);
  if (code === 1 || code === 2) return pick('partly', 'Partly cloudy', isDay ? 'glint' : null);
  if (code === 3) return pick('cloudy', 'Cloudy', null);
  if (code === 45 || code === 48) return pick('fog', 'Fog', null);
  if (code >= 51 && code <= 57) return pick('drizzle', 'Drizzle', 'rain');
  if ((code >= 61 && code <= 67) || (code >= 80 && code <= 82)) return pick('rain', 'Rain', 'rain');
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return pick('snow', 'Snow', 'snow');
  if (code >= 95 && code <= 99) return pick('storm', 'Thunderstorm', 'rain');
  return pick('cloudy', 'Cloudy', null);
}

/** Fahrenheit for US-style locales (US, Liberia, Myanmar and US territories), else Celsius. */
export function temperatureUnitFor(locale: string | undefined): TemperatureUnit {
  const region = (locale ?? '').split(/[-_]/)[1]?.toUpperCase();
  return region && ['US', 'LR', 'MM', 'PR', 'GU', 'VI', 'AS', 'MP', 'UM'].includes(region) ? 'fahrenheit' : 'celsius';
}

/** Geocoding request: the city name and fixed options only. */
export function geocodingUrl(city: string): string {
  const params = new URLSearchParams({ name: normalizeCity(city), count: '1', language: 'en', format: 'json' });
  return `${GEOCODING_ENDPOINT}?${params.toString()}`;
}

/** Forecast request: coordinates from the geocoder and fixed options only. */
export function forecastUrl(latitude: number, longitude: number, unit: TemperatureUnit): string {
  const params = new URLSearchParams({
    latitude: latitude.toFixed(3),
    longitude: longitude.toFixed(3),
    current: 'temperature_2m,weather_code,is_day',
    temperature_unit: unit,
    timezone: 'auto',
  });
  return `${FORECAST_ENDPOINT}?${params.toString()}`;
}

export const temperatureLabel = (report: Pick<WeatherReport, 'temperature' | 'unit'>) =>
  `${Math.round(report.temperature)}°${report.unit === 'fahrenheit' ? 'F' : 'C'}`;

/** Plain sentence for screen readers and link names: "Weather in Austin: Rain, 64°F". */
export const weatherSummary = (report: WeatherReport) => `Weather in ${report.place}: ${report.label}, ${temperatureLabel(report)}`;

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

const cacheKey = (city: string, unit: TemperatureUnit) => `${normalizeCity(city).toLowerCase()}|${unit}`;

/** A cached report for this city and unit younger than `maxAgeMs` (30 minutes), else null. */
export function readCachedWeather(storage: StorageLike | null, city: string, unit: TemperatureUnit, now: number, maxAgeMs = WEATHER_TTL_MS): WeatherReport | null {
  if (!storage) return null;
  try {
    const all = JSON.parse(storage.getItem(WEATHER_CACHE_KEY) ?? '{}') as Record<string, WeatherReport>;
    const entry = all[cacheKey(city, unit)];
    if (!entry || typeof entry.fetchedAt !== 'number' || typeof entry.temperature !== 'number') return null;
    if (now - entry.fetchedAt >= maxAgeMs || entry.fetchedAt > now) return null;
    return entry;
  } catch {
    return null;
  }
}

/** Keeps only the newest entry: one city per device is all the dashboard needs. */
export function writeCachedWeather(storage: StorageLike | null, report: WeatherReport): void {
  if (!storage) return;
  try {
    storage.setItem(WEATHER_CACHE_KEY, JSON.stringify({ [cacheKey(report.city, report.unit)]: report }));
  } catch {
    // Storage full or blocked: the next visit fetches again.
  }
}

const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

/**
 * Geocodes `city`, then reads current conditions. Returns null on any failure
 * (unknown city, network, malformed response); it never throws.
 */
export async function fetchWeather(
  city: string,
  options: { fetchImpl?: typeof fetch; unit: TemperatureUnit; now?: () => number; signal?: AbortSignal },
): Promise<WeatherReport | null> {
  const name = normalizeCity(city);
  if (!name) return null;
  const fetchImpl = options.fetchImpl ?? fetch;
  try {
    const geo = await fetchImpl(geocodingUrl(name), { signal: options.signal, credentials: 'omit', referrerPolicy: 'no-referrer' });
    if (!geo.ok) return null;
    const geoJson = (await geo.json()) as { results?: Array<{ latitude?: unknown; longitude?: unknown; name?: unknown }> };
    const match = geoJson.results?.[0];
    if (!match || !isNumber(match.latitude) || !isNumber(match.longitude)) return null;
    const forecast = await fetchImpl(forecastUrl(match.latitude, match.longitude, options.unit), { signal: options.signal, credentials: 'omit', referrerPolicy: 'no-referrer' });
    if (!forecast.ok) return null;
    const json = (await forecast.json()) as { current?: { temperature_2m?: unknown; weather_code?: unknown; is_day?: unknown } };
    const current = json.current;
    if (!current || !isNumber(current.temperature_2m) || !isNumber(current.weather_code)) return null;
    const isDay = current.is_day !== 0;
    const mapped = weatherFromCode(current.weather_code, isDay);
    return {
      city: name,
      place: typeof match.name === 'string' && match.name.trim() ? match.name.trim() : name,
      temperature: current.temperature_2m,
      unit: options.unit,
      code: current.weather_code,
      isDay,
      ...mapped,
      fetchedAt: (options.now ?? Date.now)(),
    };
  } catch {
    return null;
  }
}

/** The live report state per city: the last good report, and when the latest refresh failed. */
export type WeatherEntry = { report: WeatherReport | null; failedAt: number | null };

/**
 * HP-6a: the state after a refresh. A good report replaces the entry; a failed one keeps
 * the last good report (if it is not too old) and records the failure, so one failed
 * fetch never wipes a good report.
 */
export function weatherAfterFetch(previous: WeatherEntry | undefined, report: WeatherReport | null, now: number): WeatherEntry {
  if (report) return { report, failedAt: null };
  const last = previous?.report ?? null;
  return { report: last && now - last.fetchedAt < WEATHER_STALE_MAX_MS ? last : null, failedAt: now };
}

/** A report still shown after a failed refresh is stale. */
export const isWeatherStale = (entry: WeatherEntry | undefined): boolean =>
  Boolean(entry?.report && entry.failedAt !== null);

/**
 * HP-6b: milliseconds until the next refresh is due: `fetchedAt + TTL` for a good report,
 * `failedAt + retry` after a failure; 0 when it is due now (or nothing is loaded yet).
 */
export function weatherRefreshDelay(entry: WeatherEntry | undefined, now: number): number {
  if (!entry) return 0;
  const due = entry.failedAt !== null ? entry.failedAt + WEATHER_RETRY_MS : (entry.report?.fetchedAt ?? now) + WEATHER_TTL_MS;
  return Math.max(0, due - now);
}
