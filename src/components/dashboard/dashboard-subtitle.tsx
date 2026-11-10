'use client';

/**
 * The dashboard's one subtitle line (HP-15a, HP-20): household name, the household's
 * date and time, and the current weather when the member turned it on. The name is shown
 * only here (the house's own heading is for screen readers), and it is the part that
 * shortens when space runs out: the date, time and weather are whole words that never
 * wrap or truncate, with shorter formats on phones.
 */
import { useEffect, useState } from 'react';
import { temperatureLabel } from '@/lib/dashboard/weather';
import { useLiveWeather } from '@/lib/dashboard/use-weather';

/** The current time, re-read on each minute boundary and when the page is shown again. */
function useMinuteClock(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    let id = 0;
    const schedule = () => {
      window.clearTimeout(id);
      const current = new Date();
      setNow(current);
      // A little past the boundary so the new minute has started on every clock.
      id = window.setTimeout(schedule, 60_000 - (current.getTime() % 60_000) + 50);
    };
    const onVisible = () => {
      if (document.visibilityState !== 'hidden') schedule();
    };
    schedule();
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('pageshow', schedule);
    return () => {
      window.clearTimeout(id);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('pageshow', schedule);
    };
  }, []);
  return now;
}

const Dot = () => <span aria-hidden className="shrink-0 px-1">·</span>;

export function DashboardSubtitle({ householdName, timeZone }: { householdName?: string | null; timeZone?: string }) {
  const now = useMinuteClock();
  const weather = useLiveWeather();
  // The household's date and time (D-6), the same day every tile counts from.
  const longDate = now.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', timeZone });
  const shortDate = now.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', timeZone });
  const time = now.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', timeZone });

  return (
    <p className="flex min-w-0 items-baseline whitespace-nowrap text-muted-foreground" data-testid="dashboard-household-line">
      {householdName ? (
        <>
          <span className="min-w-[3ch] truncate font-medium text-foreground" data-testid="dashboard-household-name" title={householdName}>{householdName}</span>
          <Dot />
        </>
      ) : null}
      <span className="shrink-0" data-testid="dashboard-date">
        <span className="sm:hidden">{shortDate}</span>
        <span className="hidden sm:inline">{longDate}</span>
      </span>
      <Dot />
      <span className="shrink-0 tabular-nums" data-testid="dashboard-time">{time}</span>
      {weather ? (
        <>
          <Dot />
          <span className="shrink-0" data-testid="dashboard-weather-line">
            {temperatureLabel(weather)}
            <span className="hidden sm:inline">{` ${weather.label}`}</span>
          </span>
        </>
      ) : null}
    </p>
  );
}
