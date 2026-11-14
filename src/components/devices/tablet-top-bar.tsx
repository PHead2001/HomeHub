'use client';

// The tablet's slim top bar (WT-14b, HP-15b): the room from the device record, the
// household's clock and date, the weather when the record turns it on, the Offline pill
// (SL-10), who is acting right now with "Done", household notices and Tablet settings.
// Nothing personal while resting (WT-5a).

import { Bell, Settings } from 'lucide-react';
import { ConnectionStatus } from '@/components/shell/connection-status';
import { useLiveWeather } from '@/lib/dashboard/use-weather';
import { temperatureLabel } from '@/lib/dashboard/weather';
import { safeTimeZone } from '@functions/shared/calendar';
import { currentActor } from '@/lib/devices/shell-state';
import { NOTICES_PATH } from '@/lib/devices/start-page';
import { useTablet } from './tablet-context';

export const clockLabel = (now: Date, timeZone: string) =>
  new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit', timeZone: safeTimeZone(timeZone) }).format(now);
export const dateLabel = (now: Date, timeZone: string) =>
  new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric', timeZone: safeTimeZone(timeZone) }).format(now);

export function TabletTopBar({ now }: { now: Date }) {
  const { settings, household, shell, person, done, notices, navigate, openSettings } = useTablet();
  const weather = useLiveWeather();
  const zone = household?.timeZone ?? 'America/Chicago';
  const acting = currentActor(shell);
  const actor = acting ? person(acting.memberUid) : null;

  return (
    <header className="relative flex h-14 shrink-0 items-center gap-4 border-b border-border bg-card px-4" data-testid="tablet-top-bar">
      <p className="min-w-0 truncate font-headline text-lg font-semibold" data-testid="tablet-room">{settings.room || settings.name}</p>
      <p className="flex items-baseline gap-3 tabular-nums">
        <span className="font-headline text-2xl font-bold" data-testid="tablet-clock">{clockLabel(now, zone)}</span>
        <span className="text-sm text-muted-foreground" data-testid="tablet-date">{dateLabel(now, zone)}</span>
      </p>
      {settings.display.weather && weather && (
        <p className="text-sm text-muted-foreground" data-testid="tablet-weather">
          {temperatureLabel(weather)} · {weather.label}
        </p>
      )}
      <div className="flex-1" />
      {actor && (
        <div className="flex items-center gap-2 rounded-full bg-primary/10 py-1 pl-3 pr-1 text-sm" data-testid="tablet-acting">
          <span>
            {actor.name}
            {acting?.level === 'pin' ? ' (PIN)' : ''}
          </span>
          <button type="button" onClick={done} className="min-h-12 rounded-full px-4 font-semibold text-primary" data-testid="tablet-done">
            Done
          </button>
        </div>
      )}
      <button
        type="button"
        onClick={() => navigate(NOTICES_PATH)}
        className="relative inline-flex min-h-12 min-w-12 items-center justify-center rounded-full text-muted-foreground"
        aria-label={notices.length > 0 ? `Household notices, ${notices.length}` : 'Household notices'}
        data-testid="tablet-notices-button"
      >
        <Bell aria-hidden className="h-6 w-6" />
        {notices.length > 0 && (
          <span aria-hidden className="absolute right-1 top-1 min-w-5 rounded-full bg-primary px-1 text-center text-[0.65rem] font-bold leading-5 text-primary-foreground">
            {notices.length > 9 ? '9+' : notices.length}
          </span>
        )}
      </button>
      <button
        type="button"
        onClick={openSettings}
        className="inline-flex min-h-12 min-w-12 items-center justify-center rounded-full text-muted-foreground"
        aria-label="Tablet settings"
        data-testid="tablet-settings-button"
      >
        <Settings aria-hidden className="h-6 w-6" />
      </button>
      <ConnectionStatus />
    </header>
  );
}
