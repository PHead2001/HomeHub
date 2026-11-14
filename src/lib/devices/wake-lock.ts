// Screen wake lock, generalized from the shopping list's (SH-33a) for the wall tablet's
// keep-awake (docs/modules/devices/README.md, "Tablet shell"; design 14.3, WT-14d, HP-17a).
// Pure and browser-free: `createWakeLockController` requests and releases one lock as
// "wanted" changes; `watchKeepAwake` wires it to the page's visibility. The browser
// releases the lock whenever the page is hidden; it is requested again when shown.

export type WakeLockSentinelLike = {
  readonly released: boolean;
  release: () => Promise<void>;
  addEventListener?: (type: 'release', listener: () => void) => void;
};

export type WakeLockApi = {
  request: (type: 'screen') => Promise<WakeLockSentinelLike>;
};

export type WakeLockController = {
  /** Sets whether the lock is wanted now; requests or releases as needed. */
  set: (wanted: boolean) => void;
  /** Releases and stops (unmount). */
  dispose: () => void;
  /** For tests and diagnostics. */
  state: () => 'idle' | 'requesting' | 'held';
};

export function createWakeLockController(api: WakeLockApi | null | undefined): WakeLockController {
  let wanted = false;
  let disposed = false;
  let sentinel: WakeLockSentinelLike | null = null;
  let requesting = false;

  const release = () => {
    const held = sentinel;
    sentinel = null;
    if (held && !held.released) void held.release().catch(() => undefined);
  };

  const sync = () => {
    if (!api) return;
    if (!wanted || disposed) {
      release();
      return;
    }
    if (sentinel && !sentinel.released) return;
    sentinel = null;
    if (requesting) return;
    requesting = true;
    api.request('screen').then(
      (granted) => {
        requesting = false;
        if (!wanted || disposed) {
          if (!granted.released) void granted.release().catch(() => undefined);
          return;
        }
        sentinel = granted;
        // A system release (page hidden, battery saver): forget it; the next
        // transition to wanted requests again.
        granted.addEventListener?.('release', () => {
          if (sentinel === granted) sentinel = null;
        });
      },
      () => {
        // Refused (not allowed, battery saver, not visible): nothing held; tried again on the next transition.
        requesting = false;
      },
    );
  };

  return {
    set(next) {
      if (disposed) return;
      const changed = next !== wanted;
      wanted = next;
      if (changed || (wanted && !sentinel && !requesting)) sync();
    },
    dispose() {
      disposed = true;
      wanted = false;
      release();
    },
    state: () => (sentinel && !sentinel.released ? 'held' : requesting ? 'requesting' : 'idle'),
  };
}

/** The page's visibility as the wake lock needs it (`document`). */
export type VisibilityLike = {
  readonly visibilityState: string;
  addEventListener: (type: 'visibilitychange', listener: () => void) => void;
  removeEventListener: (type: 'visibilitychange', listener: () => void) => void;
};

/**
 * Keeps the screen on while `wanted()` holds and the page is visible (a registered tablet:
 * always while its shell is shown). Re-decides on every visibility change and whenever
 * `update()` is called. Returns `{ update, stop }`; stop releases the lock.
 */
export function watchKeepAwake({ api, page, wanted }: { api: WakeLockApi; page: VisibilityLike; wanted: () => boolean }): { update: () => void; stop: () => void } {
  const controller = createWakeLockController(api);
  const update = () => controller.set(wanted() && page.visibilityState === 'visible');
  update();
  page.addEventListener('visibilitychange', update);
  return {
    update,
    stop: () => {
      page.removeEventListener('visibilitychange', update);
      controller.dispose();
    },
  };
}
