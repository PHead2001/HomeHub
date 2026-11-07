import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  fetchWeather,
  forecastUrl,
  geocodingUrl,
  normalizeCity,
  parseWeatherPreference,
  readCachedWeather,
  temperatureLabel,
  temperatureUnitFor,
  weatherFromCode,
  weatherSummary,
  WEATHER_CACHE_KEY,
  WEATHER_TTL_MS,
  writeCachedWeather,
  type WeatherReport,
} from '../../src/lib/dashboard/weather';

const memoryStorage = () => {
  const map = new Map<string, string>();
  return { getItem: (key: string) => map.get(key) ?? null, setItem: (key: string, value: string) => void map.set(key, value), map };
};

const report = (overrides: Partial<WeatherReport> = {}): WeatherReport => ({
  city: 'Austin', place: 'Austin', temperature: 71.6, unit: 'fahrenheit', code: 61, isDay: true,
  kind: 'rain', label: 'Rain', effect: 'rain', fetchedAt: 1_000_000, ...overrides,
});

describe('weather mapping', () => {
  it('maps WMO codes to a kind, label and effect', () => {
    assert.deepEqual(weatherFromCode(0, true), { kind: 'clear', label: 'Sunny', effect: 'glint' });
    assert.deepEqual(weatherFromCode(0, false), { kind: 'clear', label: 'Clear', effect: null });
    assert.equal(weatherFromCode(2, true).effect, 'glint');
    assert.equal(weatherFromCode(3, true).effect, null);
    assert.equal(weatherFromCode(45, true).kind, 'fog');
    assert.deepEqual(weatherFromCode(53, true), { kind: 'drizzle', label: 'Drizzle', effect: 'rain' });
    assert.equal(weatherFromCode(63, true).effect, 'rain');
    assert.equal(weatherFromCode(81, false).kind, 'rain');
    assert.deepEqual(weatherFromCode(73, true), { kind: 'snow', label: 'Snow', effect: 'snow' });
    assert.equal(weatherFromCode(86, true).effect, 'snow');
    assert.deepEqual(weatherFromCode(95, true), { kind: 'storm', label: 'Thunderstorm', effect: 'rain' });
    assert.equal(weatherFromCode(1234, true).kind, 'cloudy');
  });

  it('picks the unit from the locale region', () => {
    assert.equal(temperatureUnitFor('en-US'), 'fahrenheit');
    assert.equal(temperatureUnitFor('es_PR'), 'fahrenheit');
    assert.equal(temperatureUnitFor('en-GB'), 'celsius');
    assert.equal(temperatureUnitFor('fr'), 'celsius');
    assert.equal(temperatureUnitFor(undefined), 'celsius');
  });

  it('labels and summarizes', () => {
    assert.equal(temperatureLabel(report()), '72°F');
    assert.equal(temperatureLabel(report({ unit: 'celsius', temperature: -0.4 })), '0°C');
    assert.equal(weatherSummary(report()), 'Weather in Austin: Rain, 72°F');
  });

  it('reads the per-user preference defensively', () => {
    assert.deepEqual(parseWeatherPreference(undefined), { enabled: false, city: '' });
    assert.deepEqual(parseWeatherPreference({ enabled: 'yes', city: 4 }), { enabled: false, city: '' });
    assert.deepEqual(parseWeatherPreference({ enabled: true, city: '  San   Antonio ' }), { enabled: true, city: 'San Antonio' });
    assert.equal(normalizeCity('x'.repeat(200)).length, 80);
  });
});

describe('weather requests send only the city', () => {
  it('geocoding carries the city name and fixed options only', () => {
    const url = new URL(geocodingUrl(' Austin '));
    assert.equal(url.origin + url.pathname, 'https://geocoding-api.open-meteo.com/v1/search');
    assert.deepEqual([...url.searchParams.keys()].sort(), ['count', 'format', 'language', 'name']);
    assert.equal(url.searchParams.get('name'), 'Austin');
  });

  it('the forecast carries the geocoded coordinates and fixed options only', () => {
    const url = new URL(forecastUrl(30.26715, -97.74306, 'fahrenheit'));
    assert.equal(url.origin + url.pathname, 'https://api.open-meteo.com/v1/forecast');
    assert.deepEqual([...url.searchParams.keys()].sort(), ['current', 'latitude', 'longitude', 'temperature_unit', 'timezone']);
    assert.equal(url.searchParams.get('latitude'), '30.267');
  });

  it('fetches geocoding then current conditions, without credentials or referrer', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      const body = url.includes('geocoding')
        ? { results: [{ name: 'Austin', latitude: 30.27, longitude: -97.74 }] }
        : { current: { temperature_2m: 64.2, weather_code: 61, is_day: 1 } };
      return new Response(JSON.stringify(body), { status: 200 });
    }) as typeof fetch;
    const result = await fetchWeather('Austin', { fetchImpl, unit: 'fahrenheit', now: () => 42 });
    assert.deepEqual(result, {
      city: 'Austin', place: 'Austin', temperature: 64.2, unit: 'fahrenheit', code: 61, isDay: true,
      kind: 'rain', label: 'Rain', effect: 'rain', fetchedAt: 42,
    });
    assert.equal(calls.length, 2);
    assert.ok(calls.every((call) => call.init?.credentials === 'omit' && call.init?.referrerPolicy === 'no-referrer'));
  });

  it('fails quietly: unknown city, HTTP errors, bad JSON, network errors and a blank city give null', async () => {
    const respond = (body: unknown, status = 200) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
    assert.equal(await fetchWeather('Nowhere', { fetchImpl: respond({ results: [] }), unit: 'celsius' }), null);
    assert.equal(await fetchWeather('Austin', { fetchImpl: respond({}, 500), unit: 'celsius' }), null);
    assert.equal(await fetchWeather('Austin', { fetchImpl: (async () => new Response('not json')) as unknown as typeof fetch, unit: 'celsius' }), null);
    assert.equal(await fetchWeather('Austin', { fetchImpl: (async () => { throw new Error('offline'); }) as unknown as typeof fetch, unit: 'celsius' }), null);
    let called = false;
    assert.equal(await fetchWeather('   ', { fetchImpl: (async () => { called = true; return new Response('{}'); }) as unknown as typeof fetch, unit: 'celsius' }), null);
    assert.equal(called, false);
  });
});

describe('weather cache', () => {
  it('serves a report for 30 minutes, per city and unit, then expires', () => {
    const storage = memoryStorage();
    writeCachedWeather(storage, report());
    assert.deepEqual(readCachedWeather(storage, 'austin', 'fahrenheit', 1_000_000 + WEATHER_TTL_MS - 1), report());
    assert.equal(readCachedWeather(storage, 'Austin', 'fahrenheit', 1_000_000 + WEATHER_TTL_MS), null);
    assert.equal(readCachedWeather(storage, 'Austin', 'celsius', 1_000_001), null);
    assert.equal(readCachedWeather(storage, 'Dallas', 'fahrenheit', 1_000_001), null);
    assert.equal(readCachedWeather(storage, 'Austin', 'fahrenheit', 999_999), null, 'a future stamp is ignored');
  });

  it('keeps one city only and survives broken or missing storage', () => {
    const storage = memoryStorage();
    writeCachedWeather(storage, report());
    writeCachedWeather(storage, report({ city: 'Dallas', place: 'Dallas' }));
    assert.deepEqual(Object.keys(JSON.parse(storage.map.get(WEATHER_CACHE_KEY)!)), ['dallas|fahrenheit']);
    storage.map.set(WEATHER_CACHE_KEY, '{broken');
    assert.equal(readCachedWeather(storage, 'Dallas', 'fahrenheit', 1_000_001), null);
    assert.equal(readCachedWeather(null, 'Dallas', 'fahrenheit', 1), null);
    assert.doesNotThrow(() => writeCachedWeather({ getItem: () => null, setItem: () => { throw new Error('full'); } }, report()));
  });
});
