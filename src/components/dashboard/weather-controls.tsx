'use client';

/**
 * Per-user live weather opt-in (H02), on the living house. Saved to the member's
 * own profile (`users/{email}.preferences.weather`). Households have no city, so
 * the city is a per-user setting next to the switch; only that name is sent to
 * Open-Meteo.
 *
 * HP-18a: the switch and "Change weather city" live in the house's "…" menu
 * (`house-menu.tsx`); the house shows only the city form, and only while a city is
 * being set (weather just turned on without one, or the member chose to change it).
 */
import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { useToast } from '@/hooks/use-toast';
import { useWeatherPreference } from '@/lib/dashboard/use-weather';
import { MAX_CITY_LENGTH, normalizeCity, type WeatherPreference } from '@/lib/dashboard/weather';
import { cn } from '@/lib/utils';
import styles from './dashboard.module.css';

export type WeatherSettings = {
  preference: WeatherPreference;
  ready: boolean;
  saving: boolean;
  /** The city form is showing. */
  showForm: boolean;
  editing: boolean;
  draft: string;
  setDraft: (value: string) => void;
  toggle: () => Promise<void>;
  startEditing: () => void;
  cancelEditing: () => void;
  submit: (event: FormEvent<HTMLFormElement>) => Promise<void>;
  /**
   * The city form was just opened from the menu: the menu must not return focus to its
   * trigger, and the form focuses its field (then clears this).
   */
  cityFocus: boolean;
  clearCityFocus: () => void;
};

/** State shared by the "…" menu (the switch) and the city form on the house. */
export function useWeatherSettings(): WeatherSettings {
  const { preference, ready, save } = useWeatherPreference();
  const { toastError } = useToast();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [cityFocus, setCityFocus] = useState(false);
  const showForm = ready && preference.enabled && (editing || !preference.city);
  const clearCityFocus = useCallback(() => setCityFocus(false), []);

  const persist = async (next: { enabled: boolean; city: string }) => {
    setSaving(true);
    try {
      await save(next);
      return true;
    } catch (error) {
      toastError(error, "Couldn't save the weather setting");
      return false;
    } finally {
      setSaving(false);
    }
  };

  const toggle = async () => {
    const enabled = !preference.enabled;
    // Seed the city field before saving: setting it after the save resolved would
    // wipe whatever the member typed while the write was in flight.
    if (enabled) {
      setDraft(preference.city);
      if (!preference.city) setCityFocus(true);
    } else {
      setEditing(false);
      setCityFocus(false);
    }
    if (!(await persist({ enabled, city: preference.city }))) setCityFocus(false);
  };

  const startEditing = () => {
    setDraft(preference.city);
    setEditing(true);
    setCityFocus(true);
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (await persist({ enabled: true, city: normalizeCity(draft) })) setEditing(false);
  };

  return {
    preference, ready, saving, showForm, editing, draft, setDraft, toggle, startEditing,
    cancelEditing: () => setEditing(false), submit, cityFocus, clearCityFocus,
  };
}

/** The city form on the house, shown only while a city is being set. */
export function WeatherCityForm({ settings }: { settings: WeatherSettings }) {
  const inputId = useId();
  const hintId = useId();
  const input = useRef<HTMLInputElement>(null);
  const { showForm, cityFocus, clearCityFocus } = settings;

  // After the menu closed (next frame), move focus into the field it just opened.
  useEffect(() => {
    if (!showForm || !cityFocus) return;
    const frame = window.requestAnimationFrame(() => {
      input.current?.focus();
      clearCityFocus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [showForm, cityFocus, clearCityFocus]);

  if (!showForm) return null;
  return (
    <form id="weather-settings" onSubmit={settings.submit} className="flex w-full min-w-0 flex-wrap items-center gap-1.5 px-4 pt-2" data-testid="weather-city-form">
      <label htmlFor={inputId} className="text-sm text-muted-foreground">City for weather (optional)</label>
      <input
        ref={input}
        id={inputId}
        value={settings.draft}
        onChange={(event) => settings.setDraft(event.target.value)}
        maxLength={MAX_CITY_LENGTH}
        autoComplete="address-level2"
        aria-describedby={hintId}
        className={cn(styles.target, 'w-40 min-w-0 rounded-md border bg-background px-2 text-sm')}
      />
      <button type="submit" disabled={settings.saving} className={cn(styles.target, 'rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground disabled:opacity-60')}>
        Save
      </button>
      {settings.editing && (
        <button type="button" onClick={settings.cancelEditing} className={cn(styles.target, 'rounded-md px-3 text-sm text-muted-foreground hover:text-foreground')}>
          Cancel
        </button>
      )}
      <span id={hintId} className="sr-only">Only the city name is sent to Open-Meteo, a free weather service.</span>
    </form>
  );
}
