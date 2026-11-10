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
import { useAuth } from '@/hooks/use-auth';
import {
  fetchWeather,
  normalizeCity,
  parseWeatherPreference,
  isWeatherStale,
  readCachedWeather,
  temperatureUnitFor,
  WEATHER_STALE_MAX_MS,
  weatherAfterFetch,
  weatherRefreshDelay,
  writeCachedWeather,
  type WeatherEntry,
  type WeatherPreference,
  type WeatherReport,
} from './weather';

type Listener = () => void;

/** Session overrides after a toggle, keyed by email, so every consumer updates at once. */
const overrides = new Map<string, WeatherPreference>();
/** Last good report and latest failure per city|unit (a failure keeps the last good report). */
const reports = new Map<string, WeatherEntry>();
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

/** Loads the report when its refresh is due (`weatherRefreshDelay`); a no-op while it is fresh. */
function loadWeather(city: string): Promise<void> {
  const key = reportKey(city);
  const running = inFlight.get(key);
  if (running) return running;
  const previous = reports.get(key);
  if (previous && weatherRefreshDelay(previous, Date.now()) > 0) return Promise.resolve();
  const cached = readCachedWeather(storage(), city, unit(), Date.now());
  if (cached && (!previous?.report || cached.fetchedAt > previous.report.fetchedAt)) {
    reports.set(key, { report: cached, failedAt: null });
    emit();
    return Promise.resolve();
  }
  const task = fetchWeather(city, { unit: unit() })
    .then((report) => {
      // A failed fetch keeps the last good report (from this session, or the device cache).
      const last = previous?.report ? previous : { report: readCachedWeather(storage(), city, unit(), Date.now(), WEATHER_STALE_MAX_MS), failedAt: null };
      reports.set(key, weatherAfterFetch(last, report, Date.now()));
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
      // Loaded on demand: this hook also runs in the root layout (shell weather), which
      // must not pull Firestore into signed-out pages.
      const [{ db }, { doc, setDoc }, { awaitWriteUnlessOffline }] = await Promise.all([
        import('@/lib/firebase'),
        import('firebase/firestore'),
        import('@/lib/firestore-offline'),
      ]);
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
 * Current weather when the member opted in and set a city, with whether it is stale.
 * Cached for 30 minutes (per device, by city). The next refresh is scheduled at the
 * report's `fetchedAt + 30 min` (HP-6b), and re-checked when the page becomes visible
 * again; a failed refresh keeps the last good report, marked stale, and tries again in
 * 5 minutes (HP-6a). With no good report at all the weather stays hidden.
 */
export function useLiveWeatherState(): { report: WeatherReport | null; stale: boolean } {
  const { preference } = useWeatherPreference();
  useSyncExternalStore(subscribe, getVersion, getServerVersion);
  const city = preference.enabled ? preference.city : '';
  const entry = city && typeof window !== 'undefined' ? reports.get(reportKey(city)) : undefined;

  useEffect(() => {
    if (!city) return;
    const run = () => void loadWeather(city);
    run();
    // Re-armed whenever the entry changes (a new report or a failure).
    const id = window.setTimeout(run, Math.max(1000, weatherRefreshDelay(entry, Date.now())));
    const onVisible = () => {
      if (document.visibilityState !== 'hidden') run();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearTimeout(id);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [city, entry]);

  if (!entry?.report) return { report: null, stale: false };
  return { report: entry.report, stale: isWeatherStale(entry) };
}

/** Current weather (see `useLiveWeatherState`), or null. */
export function useLiveWeather(): WeatherReport | null {
  return useLiveWeatherState().report;
}
