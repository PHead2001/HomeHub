/**
 * The household's "today" (D-6). Every day-based calculation on a shared screen uses
 * the household's own time zone (`household.timeZone`), so a phone travelling in
 * another zone and the wall tablet at home agree on which chores are due today, what
 * was done today and when the day rolls over. A household with no (valid) zone uses
 * the server default (America/Chicago), as reminders do. Date-only values (`yyyy-MM-dd`, such as a chore's
 * `originalDueDate`) stay date-only and are compared as strings with this key.
 *
 * Reusable by any module: `householdToday(tz, now)` is pure, `useHouseholdToday(tz)`
 * keeps it current with a timer to the next household midnight and re-checks when
 * the page becomes visible again, is restored from the back-forward cache
 * (`pageshow`) or comes back online (a tablet waking from sleep or a laptop lid).
 */
// A namespace import keeps this file importable from server code (server actions need the
// same day; the react-server build has no useState), while the hook runs only on the client.
import * as React from 'react';
import { DEFAULT_TIME_ZONE, addDays, localDay, zonedMidnightIso } from '../../functions/src/shared/calendar';

/** Re-check at least this often, so a clock change or a throttled timer cannot strand the day. */
const MAX_TIMER_MS = 60 * 60 * 1000;
/** Fire just after midnight, never a moment before it. */
const MIDNIGHT_SLACK_MS = 250;

const validZone = (timeZone: unknown): timeZone is string => {
  if (typeof timeZone !== 'string' || !timeZone) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format(0);
    return true;
  } catch {
    return false;
  }
};

/** The device's IANA zone (UTC where the runtime cannot say). */
export function deviceTimeZone(): string {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return validZone(zone) ? zone : 'UTC';
  } catch {
    return 'UTC';
  }
}

/**
 * The zone "today" is computed in: the household's, else the same default the server
 * uses for reminders and recurring chores (`DEFAULT_TIME_ZONE`), so the dashboard and
 * the server never disagree about the day.
 */
export function householdDayZone(timeZone?: string | null): string {
  return validZone(timeZone) ? timeZone : DEFAULT_TIME_ZONE;
}

/** `yyyy-MM-dd` of the household's current calendar day. */
export function householdToday(timeZone: string | null | undefined, now: Date = new Date()): string {
  return localDay(now, householdDayZone(timeZone));
}

/** The instant a household day (default: today) began, its local midnight. */
export function householdDayStart(timeZone: string | null | undefined, day: string = householdToday(timeZone)): Date {
  return new Date(zonedMidnightIso(day, householdDayZone(timeZone)));
}

/** Milliseconds from `now` to the next household midnight (at least 1 s). */
export function msUntilHouseholdMidnight(timeZone: string | null | undefined, now: Date = new Date()): number {
  const zone = householdDayZone(timeZone);
  const next = new Date(zonedMidnightIso(addDays(localDay(now, zone), 1), zone));
  return Math.max(1000, next.getTime() - now.getTime());
}

type DayEnvironment = {
  now: () => Date;
  /** Receives `pageshow` and `online`. */
  window?: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>;
  /** Receives `visibilitychange`; `visibilityState` is read on each event. */
  document?: Pick<EventTarget, 'addEventListener' | 'removeEventListener'> & { visibilityState?: string };
};

const browserEnvironment = (): DayEnvironment => ({
  now: () => new Date(),
  window: typeof window === 'undefined' ? undefined : window,
  document: typeof document === 'undefined' ? undefined : document,
});

/**
 * Calls `onDay` whenever the household day changes: at the next household midnight
 * (a timer, capped at an hour), and on `visibilitychange` to visible, `pageshow` and
 * `online`. Returns a stop function. Framework-free, so it is unit tested with fake timers.
 */
export function watchHouseholdDay(
  timeZone: string | null | undefined,
  onDay: (day: string) => void,
  environment: DayEnvironment = browserEnvironment(),
): () => void {
  let current = householdToday(timeZone, environment.now());
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  const check = () => {
    if (stopped) return;
    const day = householdToday(timeZone, environment.now());
    if (day !== current) {
      current = day;
      onDay(day);
    }
    schedule();
  };
  const schedule = () => {
    clearTimeout(timer);
    const wait = Math.min(MAX_TIMER_MS, msUntilHouseholdMidnight(timeZone, environment.now()) + MIDNIGHT_SLACK_MS);
    timer = setTimeout(check, wait);
  };
  const onVisibility = () => {
    if (environment.document?.visibilityState !== 'hidden') check();
  };

  schedule();
  environment.document?.addEventListener('visibilitychange', onVisibility);
  environment.window?.addEventListener('pageshow', check);
  environment.window?.addEventListener('online', check);
  return () => {
    stopped = true;
    clearTimeout(timer);
    environment.document?.removeEventListener('visibilitychange', onVisibility);
    environment.window?.removeEventListener('pageshow', check);
    environment.window?.removeEventListener('online', check);
  };
}

/** The household's current day key, rolling over at household midnight (see the module doc). */
export function useHouseholdToday(timeZone: string | null | undefined): string {
  const zone = householdDayZone(timeZone);
  const [state, setState] = React.useState(() => ({ zone, day: householdToday(zone) }));

  React.useEffect(() => {
    // Re-read once on subscribe (the zone may have changed since the first render).
    const sync = (day: string) => setState((previous) => (previous.zone === zone && previous.day === day ? previous : { zone, day }));
    sync(householdToday(zone));
    return watchHouseholdDay(zone, sync);
  }, [zone]);

  return state.zone === zone ? state.day : householdToday(zone);
}
