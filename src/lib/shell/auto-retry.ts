/**
 * SL-12: a read that must eventually succeed (the signed-in person's profile on page
 * load) is retried on its own instead of leaving the page on a skeleton for good.
 * Retries follow a bounded backoff (2 s, 5 s, 15 s, 30 s, then every 60 s) and run at
 * once when the browser comes back online. `keepGoing` is asked before every attempt
 * and after every wait: when it says no (another account signed in, or signed out), the
 * loop stops and reports `aborted`, so a late answer never overwrites newer state.
 *
 * Framework-free (timers and the online target are injected); unit tested in
 * tests/unit/shell-section-11.test.ts.
 */

export const AUTO_RETRY_DELAYS_MS = [2_000, 5_000, 15_000, 30_000, 60_000] as const;

/** Wait before retry number `attempt` (1-based); the last step repeats. */
export function autoRetryDelay(attempt: number, delays: readonly number[] = AUTO_RETRY_DELAYS_MS): number {
  const index = Math.min(Math.max(1, Math.floor(attempt)), delays.length) - 1;
  return delays[index];
}

type OnlineTarget = Pick<EventTarget, 'addEventListener' | 'removeEventListener'>;

export type AutoRetryOptions = {
  keepGoing: () => boolean;
  onError?: (error: unknown, attempt: number) => void;
  delays?: readonly number[];
  /** Receives `online` (the window in the browser). */
  onlineTarget?: OnlineTarget | null;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (id: unknown) => void;
};

export type AutoRetryResult<T> = { aborted: false; value: T } | { aborted: true };

/** Waits `ms`, or less when the browser comes back online. */
function waitForRetry(ms: number, options: AutoRetryOptions): Promise<void> {
  const setTimer = options.setTimer ?? ((fn: () => void, delay: number) => setTimeout(fn, delay));
  const clearTimer = options.clearTimer ?? ((id: unknown) => clearTimeout(id as ReturnType<typeof setTimeout>));
  const target = options.onlineTarget === undefined
    ? (typeof window === 'undefined' ? null : window)
    : options.onlineTarget;
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimer(timer);
      target?.removeEventListener('online', finish);
      resolve();
    };
    const timer = setTimer(finish, ms);
    target?.addEventListener('online', finish);
  });
}

export async function retryUntil<T>(task: () => Promise<T>, options: AutoRetryOptions): Promise<AutoRetryResult<T>> {
  for (let attempt = 1; ; attempt += 1) {
    if (!options.keepGoing()) return { aborted: true };
    try {
      const value = await task();
      return options.keepGoing() ? { aborted: false, value } : { aborted: true };
    } catch (error) {
      options.onError?.(error, attempt);
    }
    await waitForRetry(autoRetryDelay(attempt, options.delays), options);
  }
}
