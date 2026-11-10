/**
 * A listener whose error is not final (HP-5). Firestore ends an `onSnapshot` listener on
 * its first error; this wrapper subscribes again with bounded exponential backoff
 * (1 s, 2 s, 4 s … capped at 60 s, each with ±20% jitter so many tablets do not retry in
 * step), and at once when the browser comes back `online` or the page becomes visible
 * again. A successful answer resets the schedule.
 *
 * `permission-denied` usually means access really changed, but it can also be a token
 * refresh racing the read, so it is retried at most twice; after that the listener
 * reports `unauthorized` and stays quiet until it is recreated (the caller recreates it
 * when the household, member or permissions change).
 *
 * Framework-free (the subscribe function is injected), so the schedule is unit tested
 * with fake timers.
 */

export const BACKOFF_BASE_MS = 1000;
export const BACKOFF_CAP_MS = 60_000;
/** Permission-denied retries before the listener settles on `unauthorized`. */
export const PERMISSION_RETRIES = 2;

export type ListenerStatus =
  | { kind: 'live' }
  /** The last attempt failed; another is scheduled (`attempt` counts failures in a row). */
  | { kind: 'retrying'; attempt: number; delayMs: number; error: unknown }
  | { kind: 'unauthorized'; error: unknown };

export type ResilientHandle = {
  /** Unsubscribes and cancels any pending retry. Idempotent. */
  stop: () => void;
  /** Subscribes again now when a retry is pending (a Retry button); otherwise a no-op. */
  retryNow: () => void;
};

type Target = Pick<EventTarget, 'addEventListener' | 'removeEventListener'>;
export type ResilientEnvironment = {
  /** Receives `online`. */
  window?: Target;
  /** Receives `visibilitychange`; `visibilityState` is read on each event. */
  document?: Target & { visibilityState?: string };
  random?: () => number;
};

const browserEnvironment = (): ResilientEnvironment => ({
  window: typeof window === 'undefined' ? undefined : window,
  document: typeof document === 'undefined' ? undefined : document,
});

/** Delay before retry number `attempt` (1-based): 1 s, 2 s, 4 s … 60 s, ±20% jitter, never above the cap. */
export function backoffDelay(attempt: number, random: () => number = Math.random): number {
  const base = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, attempt - 1));
  return Math.min(BACKOFF_CAP_MS, Math.round(base * (0.8 + 0.4 * random())));
}

export const isPermissionDenied = (error: unknown): boolean =>
  Boolean(error && typeof error === 'object' && (error as { code?: unknown }).code === 'permission-denied');

export function resilientListener<T>(
  subscribe: (next: (value: T) => void, error: (error: unknown) => void) => () => void,
  handlers: {
    next: (value: T) => void;
    status?: (status: ListenerStatus) => void;
    /**
     * Whether an answer is confirmed by the server (Firestore: `!snapshot.metadata.fromCache`).
     * Only a confirmed answer resets the retry schedule and the permission-denied count, so a
     * cached snapshot delivered before each denial cannot keep a refused query retrying at
     * the minimum delay forever. Default: every answer is confirmed.
     */
    confirmed?: (value: T) => boolean;
  },
  environment: ResilientEnvironment = browserEnvironment(),
): ResilientHandle {
  const random = environment.random ?? Math.random;
  let generation = 0;
  let unsubscribe: (() => void) | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let failures = 0;
  let denials = 0;
  let pending = false;
  let stopped = false;
  let live = false;

  const detach = () => {
    const stop = unsubscribe;
    unsubscribe = null;
    stop?.();
  };

  const start = () => {
    if (stopped) return;
    clearTimeout(timer);
    pending = false;
    detach();
    const mine = ++generation;
    const onNext = (value: T) => {
      if (stopped || mine !== generation) return;
      if (handlers.confirmed?.(value) ?? true) {
        failures = 0;
        denials = 0;
      }
      if (!live) {
        live = true;
        handlers.status?.({ kind: 'live' });
      }
      handlers.next(value);
    };
    const onError = (error: unknown) => {
      if (stopped || mine !== generation) return;
      generation += 1; // later events from this subscription are ignored
      live = false;
      detach();
      if (isPermissionDenied(error)) {
        denials += 1;
        if (denials > PERMISSION_RETRIES) {
          handlers.status?.({ kind: 'unauthorized', error });
          return;
        }
      }
      failures += 1;
      const delayMs = backoffDelay(failures, random);
      pending = true;
      timer = setTimeout(start, delayMs);
      handlers.status?.({ kind: 'retrying', attempt: failures, delayMs, error });
    };
    const stop = subscribe(onNext, onError);
    // An error delivered synchronously already moved on; drop this subscription.
    if (mine === generation && !stopped) unsubscribe = stop;
    else stop();
  };

  const retryNow = () => {
    if (pending && !stopped) start();
  };
  const onVisibility = () => {
    if (environment.document?.visibilityState !== 'hidden') retryNow();
  };

  environment.window?.addEventListener('online', retryNow);
  environment.document?.addEventListener('visibilitychange', onVisibility);
  start();

  return {
    stop: () => {
      if (stopped) return;
      stopped = true;
      clearTimeout(timer);
      detach();
      environment.window?.removeEventListener('online', retryNow);
      environment.document?.removeEventListener('visibilitychange', onVisibility);
    },
    retryNow,
  };
}
