/**
 * Opt-in live weather (H02, H22). Uses Open-Meteo, which is free and needs no key:
 * the city name goes to its geocoding endpoint, and the coordinates that come back
 * go to its forecast endpoint. Nothing else about the household is ever sent.
 * Results are cached per city for 30 minutes; any failure returns null so the UI
 * simply hides the weather.
 *
 * HP-35: one forecast call also carries today's high, low and chance of rain
 * (`daily=`), and the geocoded coordinates are cached on the device for 30 days per
 * city, so each refresh is a single request.
 */

export const GEOCODING_ENDPOINT = 'https://geocoding-api.open-meteo.com/v1/search';
export const FORECAST_ENDPOINT = 'https://api.open-meteo.com/v1/forecast';
export const WEATHER_TTL_MS = 30 * 60_000;
/** After a failed refresh, try again this much later (the last good report stays, marked stale). */
export const WEATHER_RETRY_MS = 5 * 60_000;
/** A last good report older than this is no longer shown, even as stale. */
export const WEATHER_STALE_MAX_MS = 3 * 60 * 60_000;
export const WEATHER_CACHE_KEY = 'homehub.dashboard.weather';
/** Geocoded coordinates per city (HP-35b). */
export const GEOCODE_CACHE_KEY = 'homehub.dashboard.geocode';
export const GEOCODE_TTL_MS = 30 * 24 * 60 * 60_000;
/** Cities kept in the coordinate cache (newest first). */
const GEOCODE_MAX_CITIES = 5;
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
  /** Today's high and low (HP-35a), in `unit`; absent or null when the forecast had none. */
  high?: number | null;
  low?: number | null;
  /** Today's highest chance of rain, 0-100 (HP-35a); absent or null when unknown. */
  rainChance?: number | null;
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
    // HP-35a: today's range and rain chance in the same request.
    daily: 'temperature_2m_max,temperature_2m_min,precipitation_probability_max',
    forecast_days: '1',
    temperature_unit: unit,
    timezone: 'auto',
  });
  return `${FORECAST_ENDPOINT}?${params.toString()}`;
}

export const temperatureLabel = (report: Pick<WeatherReport, 'temperature' | 'unit'>) =>
  `${Math.round(report.temperature)}°${report.unit === 'fahrenheit' ? 'F' : 'C'}`;

const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const degrees = (value: number) => `${Math.round(value)}°`;

/** "H 70° · L 55° · 30% rain" (HP-35a), or '' when the forecast had no daily values. */
export function dailyLabel(report: Pick<WeatherReport, 'high' | 'low' | 'rainChance'>): string {
  const parts: string[] = [];
  if (isNumber(report.high)) parts.push(`H ${degrees(report.high)}`);
  if (isNumber(report.low)) parts.push(`L ${degrees(report.low)}`);
  if (isNumber(report.rainChance)) parts.push(`${Math.round(report.rainChance)}% rain`);
  return parts.join(' · ');
}

/**
 * Plain sentence for screen readers and link names:
 * "Weather in Austin: Rain, 64°F. High 70°, low 55°, 30% chance of rain."
 */
export function weatherSummary(report: WeatherReport): string {
  const daily: string[] = [];
  if (isNumber(report.high)) daily.push(`high ${degrees(report.high)}`);
  if (isNumber(report.low)) daily.push(`low ${degrees(report.low)}`);
  if (isNumber(report.rainChance)) daily.push(`${Math.round(report.rainChance)}% chance of rain`);
  const tail = daily.length > 0 ? `. ${daily.join(', ').replace(/^./, (first) => first.toUpperCase())}.` : '';
  return `Weather in ${report.place}: ${report.label}, ${temperatureLabel(report)}${tail}`;
}

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

/** Geocoded coordinates for a city (HP-35b). */
export type GeocodedPlace = { latitude: number; longitude: number; place: string; at: number };

const geocodeKey = (city: string) => normalizeCity(city).toLowerCase();

/** Cached coordinates for `city` younger than 30 days, else null. */
export function readCachedGeocode(storage: StorageLike | null, city: string, now: number): GeocodedPlace | null {
  if (!storage) return null;
  try {
    const all = JSON.parse(storage.getItem(GEOCODE_CACHE_KEY) ?? '{}') as Record<string, GeocodedPlace>;
    const entry = all[geocodeKey(city)];
    if (!entry || !isNumber(entry.latitude) || !isNumber(entry.longitude) || !isNumber(entry.at) || typeof entry.place !== 'string') return null;
    if (now - entry.at >= GEOCODE_TTL_MS || entry.at > now) return null;
    return entry;
  } catch {
    return null;
  }
}

/** Saves the coordinates for `city`, keeping the newest few cities. */
export function writeCachedGeocode(storage: StorageLike | null, city: string, place: GeocodedPlace): void {
  if (!storage) return;
  try {
    let all: Record<string, GeocodedPlace> = {};
    try {
      const parsed = JSON.parse(storage.getItem(GEOCODE_CACHE_KEY) ?? '{}') as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) all = parsed as Record<string, GeocodedPlace>;
    } catch {
      // A malformed cache is replaced.
    }
    const next = Object.entries({ ...all, [geocodeKey(city)]: place })
      .filter(([, entry]) => entry && isNumber(entry.at))
      .sort(([, a], [, b]) => b.at - a.at)
      .slice(0, GEOCODE_MAX_CITIES);
    storage.setItem(GEOCODE_CACHE_KEY, JSON.stringify(Object.fromEntries(next)));
  } catch {
    // Storage full or blocked: the next refresh geocodes again.
  }
}

const firstNumber = (value: unknown): number | null => (Array.isArray(value) && isNumber(value[0]) ? value[0] : null);

/**
 * Geocodes `city` (or uses its cached coordinates, HP-35b), then reads current conditions
 * and today's high, low and rain chance in one forecast request. Returns null on any
 * failure (unknown city, network, malformed response); it never throws.
 */
export async function fetchWeather(
  city: string,
  options: { fetchImpl?: typeof fetch; unit: TemperatureUnit; now?: () => number; signal?: AbortSignal; storage?: StorageLike | null },
): Promise<WeatherReport | null> {
  const name = normalizeCity(city);
  if (!name) return null;
  const fetchImpl = options.fetchImpl ?? fetch;
  const clock = options.now ?? Date.now;
  const storage = options.storage ?? null;
  const init: RequestInit = { signal: options.signal, credentials: 'omit', referrerPolicy: 'no-referrer' };
  try {
    let place = readCachedGeocode(storage, name, clock());
    if (!place) {
      const geo = await fetchImpl(geocodingUrl(name), init);
      if (!geo.ok) return null;
      const geoJson = (await geo.json()) as { results?: Array<{ latitude?: unknown; longitude?: unknown; name?: unknown }> };
      const match = geoJson.results?.[0];
      if (!match || !isNumber(match.latitude) || !isNumber(match.longitude)) return null;
      place = {
        latitude: match.latitude,
        longitude: match.longitude,
        place: typeof match.name === 'string' && match.name.trim() ? match.name.trim() : name,
        at: clock(),
      };
      writeCachedGeocode(storage, name, place);
    }
    const forecast = await fetchImpl(forecastUrl(place.latitude, place.longitude, options.unit), init);
    if (!forecast.ok) return null;
    const json = (await forecast.json()) as {
      current?: { temperature_2m?: unknown; weather_code?: unknown; is_day?: unknown };
      daily?: { temperature_2m_max?: unknown; temperature_2m_min?: unknown; precipitation_probability_max?: unknown };
    };
    const current = json.current;
    if (!current || !isNumber(current.temperature_2m) || !isNumber(current.weather_code)) return null;
    const isDay = current.is_day !== 0;
    const mapped = weatherFromCode(current.weather_code, isDay);
    return {
      city: name,
      place: place.place,
      temperature: current.temperature_2m,
      unit: options.unit,
      code: current.weather_code,
      isDay,
      ...mapped,
      high: firstNumber(json.daily?.temperature_2m_max),
      low: firstNumber(json.daily?.temperature_2m_min),
      rainChance: firstNumber(json.daily?.precipitation_probability_max),
      fetchedAt: clock(),
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
