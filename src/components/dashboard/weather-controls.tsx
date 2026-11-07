'use client';

/**
 * Per-user live weather opt-in (H02), on the living house. Saved to the member's
 * own profile (`users/{email}.preferences.weather`). Households have no city, so
 * the city is a per-user setting next to the switch; only that name is sent to
 * Open-Meteo.
 */
import { useId, useState, type FormEvent } from 'react';
import { CloudSun } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { useWeatherPreference } from '@/lib/dashboard/use-weather';
import { MAX_CITY_LENGTH, normalizeCity } from '@/lib/dashboard/weather';

export function WeatherControls() {
  const { preference, ready, save } = useWeatherPreference();
  const { toastError } = useToast();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const inputId = useId();
  const hintId = useId();

  if (!ready) return null;
  const showForm = preference.enabled && (editing || !preference.city);

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
    if (enabled) setDraft(preference.city);
    else setEditing(false);
    await persist({ enabled, city: preference.city });
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (await persist({ enabled: true, city: normalizeCity(draft) })) setEditing(false);
  };

  return (
    <div id="weather-settings" className="flex min-w-0 flex-wrap items-center gap-1">
      <button
        type="button"
        onClick={toggle}
        disabled={saving}
        aria-pressed={preference.enabled}
        data-testid="weather-toggle"
        className="inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground hover:text-foreground disabled:opacity-60"
      >
        <CloudSun aria-hidden className="h-3.5 w-3.5" />
        Live weather {preference.enabled ? 'on' : 'off'}
      </button>
      {preference.enabled && preference.city && !editing && (
        <button
          type="button"
          onClick={() => {
            setDraft(preference.city);
            setEditing(true);
          }}
          className="max-w-[10rem] shrink truncate rounded-md px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
          aria-label={`Change weather city, now ${preference.city}`}
        >
          {preference.city}
        </button>
      )}
      {showForm && (
        <form onSubmit={submit} className="flex w-full min-w-0 flex-wrap items-center gap-1.5 sm:w-auto" data-testid="weather-city-form">
          <label htmlFor={inputId} className="text-xs text-muted-foreground">City for weather (optional)</label>
          <input
            id={inputId}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            maxLength={MAX_CITY_LENGTH}
            autoComplete="address-level2"
            aria-describedby={hintId}
            className="h-7 w-36 min-w-0 rounded-md border bg-background px-2 text-xs"
          />
          <button type="submit" disabled={saving} className="h-7 rounded-md bg-primary px-2 text-xs font-medium text-primary-foreground disabled:opacity-60">
            Save
          </button>
          {editing && (
            <button type="button" onClick={() => setEditing(false)} className="h-7 rounded-md px-2 text-xs text-muted-foreground hover:text-foreground">
              Cancel
            </button>
          )}
          <span id={hintId} className="sr-only">Only the city name is sent to Open-Meteo, a free weather service.</span>
        </form>
      )}
    </div>
  );
}
