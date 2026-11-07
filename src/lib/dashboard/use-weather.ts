'use client';

/**
 * Live weather preference and data (H02), shared by the shell effects, the living
 * house and the bento tile.
 *
 * The opt-in and the city are per user, stored in the member's own profile at
 * `users/{email}.preferences.weather = { enabled, city }`. `preferences` is already
 * on the profile self-update allowlist in `firestore.rules`, so no rules change was
 * needed. Households have no city field, so the city is per user too.
 */
import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { doc, setDoc } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { useAuth } from '@/hooks/use-auth';
import { awaitWriteUnlessOffline } from '@/lib/firestore-offline';
import {
  fetchWeather,
  normalizeCity,
  parseWeatherPreference,
  readCachedWeather,
  temperatureUnitFor,
  WEATHER_TTL_MS,
  writeCachedWeather,
  type WeatherPreference,
  type WeatherReport,
} from './weather';

type Listener = () => void;

/** Session overrides after a toggle, keyed by email, so every consumer updates at once. */
const overrides = new Map<string, WeatherPreference>();
/** Latest report per city|unit; `null` means "tried and failed" (hide quietly). */
const reports = new Map<string, WeatherReport | null>();
const inFlight = new Map<string, Promise<void>>();
const listeners = new Set<Listener>();
let version = 0;

const emit = () => {
  version += 1;
  listeners.forEach((listener) => listener());
};
const subscribe = (listener: Listener) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
const getVersion = () => version;
const getServerVersion = () => 0;

const storage = (): Storage | null => {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
};

const unit = () => temperatureUnitFor(typeof navigator === 'undefined' ? undefined : navigator.language);
const reportKey = (city: string) => `${city.toLowerCase()}|${unit()}`;

function loadWeather(city: string): Promise<void> {
  const key = reportKey(city);
  const existing = inFlight.get(key);
  if (existing) return existing;
  const cached = readCachedWeather(storage(), city, unit(), Date.now());
  if (cached) {
    reports.set(key, cached);
    emit();
    return Promise.resolve();
  }
  const task = fetchWeather(city, { unit: unit() })
    .then((report) => {
      reports.set(key, report);
      if (report) writeCachedWeather(storage(), report);
      emit();
    })
    .finally(() => inFlight.delete(key));
  inFlight.set(key, task);
  return task;
}

/** The member's weather preference and a setter that saves it to their profile. */
export function useWeatherPreference(): {
  preference: WeatherPreference;
  ready: boolean;
  save: (next: WeatherPreference) => Promise<void>;
} {
  const { currentUser } = useAuth();
  useSyncExternalStore(subscribe, getVersion, getServerVersion);
  const email = currentUser?.email ?? '';
  const stored = (currentUser as { preferences?: { weather?: unknown } } | null)?.preferences?.weather;
  const preference = (email && overrides.get(email)) || parseWeatherPreference(stored);

  const save = useCallback(async (next: WeatherPreference) => {
    if (!email) return;
    const clean = { enabled: next.enabled, city: normalizeCity(next.city) };
    const previous = overrides.get(email);
    overrides.set(email, clean);
    emit();
    try {
      // Merge writes only `preferences.weather`; other preference keys are kept.
      await awaitWriteUnlessOffline(setDoc(doc(db, 'users', email), { preferences: { weather: clean } }, { merge: true }));
    } catch (error) {
      if (previous) overrides.set(email, previous);
      else overrides.delete(email);
      emit();
      throw error;
    }
  }, [email]);

  return { preference, ready: Boolean(email), save };
}

/**
 * Current weather when the member opted in and set a city, else null. Cached for
 * 30 minutes (per device, by city), refreshed while mounted; failures hide it.
 */
export function useLiveWeather(): WeatherReport | null {
  const { preference } = useWeatherPreference();
  useSyncExternalStore(subscribe, getVersion, getServerVersion);
  const city = preference.enabled ? preference.city : '';

  useEffect(() => {
    if (!city) return;
    void loadWeather(city);
    // The cache entry expires after 30 minutes, so this refetches; the old report stays until then.
    const id = window.setInterval(() => void loadWeather(city), WEATHER_TTL_MS);
    return () => window.clearInterval(id);
  }, [city]);

  if (!city || typeof window === 'undefined') return null;
  return reports.get(reportKey(city)) ?? null;
}
