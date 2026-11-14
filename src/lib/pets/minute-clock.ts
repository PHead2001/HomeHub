/**
 * One shared minute clock for every Pets consumer (PE-21c): instead of one 60 s
 * interval per card, chip and tab, a single timer ticks on each minute boundary
 * while anyone listens, so "Fed 2 h ago", "1 of 2 today" and "Due today" all
 * roll over together, and at household midnight within the first second of the
 * new minute without a reload (PE-7d). It also ticks at once when the page
 * becomes visible again, is restored from the back-forward cache, or comes back
 * online (a tablet waking from sleep), since timers stall while hidden.
 *
 * Framework-free (timers and events injected), so it is unit tested with a
 * pinned clock; `use-now.ts` binds it to React with `useSyncExternalStore`.
 */

type Target = Pick<EventTarget, 'addEventListener' | 'removeEventListener'>;

export type ClockEnvironment = {
  now: () => Date;
  setTimeout: (callback: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
  /** Receives `pageshow` and `online`. */
  window?: Target;
  /** Receives `visibilitychange`; `visibilityState` is read on each event. */
  document?: Target & { visibilityState?: string };
};

/** Fire just after the minute turns, never a moment before it. */
const BOUNDARY_SLACK_MS = 50;
const MINUTE_MS = 60_000;

export type MinuteClock = {
  /** The current minute's Date; the same object until the next tick (a stable snapshot). */
  now: () => Date;
  subscribe: (listener: () => void) => () => void;
};

export function createMinuteClock(environment: ClockEnvironment): MinuteClock {
  let current = environment.now();
  const listeners = new Set<() => void>();
  let timer: unknown = null;

  const minuteOf = (date: Date) => Math.floor(date.getTime() / MINUTE_MS);
  const refresh = () => {
    const next = environment.now();
    if (minuteOf(next) === minuteOf(current)) return false;
    current = next;
    return true;
  };
  const schedule = () => {
    if (timer !== null) environment.clearTimeout(timer);
    const at = environment.now().getTime();
    const wait = MINUTE_MS - (at % MINUTE_MS) + BOUNDARY_SLACK_MS;
    timer = environment.setTimeout(tick, wait);
  };
  const tick = () => {
    timer = null;
    if (refresh()) listeners.forEach((listener) => listener());
    if (listeners.size > 0) schedule();
  };
  const onVisibility = () => {
    if (environment.document?.visibilityState !== 'hidden') tick();
  };

  return {
    now: () => {
      // Without listeners nothing ticks: catch up on read (same object within a minute).
      if (listeners.size === 0) refresh();
      return current;
    },
    subscribe: (listener) => {
      listeners.add(listener);
      if (listeners.size === 1) {
        if (refresh()) listener();
        schedule();
        environment.document?.addEventListener('visibilitychange', onVisibility);
        environment.window?.addEventListener('pageshow', tick);
        environment.window?.addEventListener('online', tick);
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size > 0) return;
        if (timer !== null) environment.clearTimeout(timer);
        timer = null;
        environment.document?.removeEventListener('visibilitychange', onVisibility);
        environment.window?.removeEventListener('pageshow', tick);
        environment.window?.removeEventListener('online', tick);
      };
    },
  };
}
