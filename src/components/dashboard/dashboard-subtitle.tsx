'use client';

/**
 * The dashboard's one subtitle line (HP-15a, HP-20): household name, the household's
 * date and time, and the current weather when the member turned it on. The name is shown
 * only here (the house's own heading is for screen readers).
 *
 * Pane-aware (HP-20c): the subtitle is its own inline-size container
 * (`dashboard.module.css` `.subtitle`), so the long date and the weather condition are
 * chosen by the width the subtitle actually has (half the page beside the house on a
 * wide landscape screen), not by the viewport. Date, time and weather are whole `nowrap`
 * items, each carrying its leading separator; when they still do not fit (large text, a
 * narrow pane) they wrap onto a second line instead of running into the brief. Only the
 * name truncates, and only when it alone is wider than the pane.
 */
import { useEffect, useState } from 'react';
import { temperatureLabel } from '@/lib/dashboard/weather';
import { useLiveWeather } from '@/lib/dashboard/use-weather';
import styles from './dashboard.module.css';

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

const Dot = () => <span aria-hidden className="px-1">·</span>;

export function DashboardSubtitle({ householdName, timeZone }: { householdName?: string | null; timeZone?: string }) {
  const now = useMinuteClock();
  const weather = useLiveWeather();
  // The household's date and time (D-6), the same day every tile counts from.
  const longDate = now.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', timeZone });
  const shortDate = now.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', timeZone });
  const time = now.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', timeZone });
  // The first field after the name has no separator when there is no name.
  const lead = householdName ? <Dot /> : null;

  return (
    <div className={styles.subtitle}>
      <p className="flex min-w-0 flex-wrap items-baseline text-muted-foreground" data-testid="dashboard-household-line">
        {householdName ? (
          <span className="min-w-[3ch] max-w-full truncate font-medium text-foreground" data-testid="dashboard-household-name" title={householdName}>{householdName}</span>
        ) : null}
        <span className="whitespace-nowrap" data-testid="dashboard-date">
          {lead}
          <span className={styles.subtitleShortDate}>{shortDate}</span>
          <span className={styles.subtitleLongDate}>{longDate}</span>
        </span>
        <span className="whitespace-nowrap tabular-nums" data-testid="dashboard-time"><Dot />{time}</span>
        {weather ? (
          <span className="whitespace-nowrap" data-testid="dashboard-weather-line">
            <Dot />
            {temperatureLabel(weather)}
            <span className={styles.subtitleCondition}>{` ${weather.label}`}</span>
          </span>
        ) : null}
      </p>
    </div>
  );
}
