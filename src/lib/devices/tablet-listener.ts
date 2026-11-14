// Every Firestore listener a wall tablet opens goes through here (docs/modules/devices/README.md,
// "Tablet shell"). Firestore ends a listener on its first error; a tablet never restarts by
// itself, so an abandoned listener would leave a view stale until someone reloads it. This
// wraps `resilientListener` (bounded backoff, retry on `online` and visible) and, after the
// permission-denied retries are used up, keeps trying every minute: a tablet that really lost
// access is ended by its own revocation flow, and `onDenied` lets the caller ask the server.
// Tablet components never call `onSnapshot` directly (a unit test reads their sources).

import { resilientListener, type ResilientEnvironment, type ResilientHandle } from '@/lib/dashboard/resilient-listener';

/** After the permission-denied retries, the tablet subscribes again this long later. */
export const TABLET_DENIED_RECOVERY_MS = 60_000;

export type TabletListenerHandlers<T> = {
  next: (value: T) => void;
  /** Firestore: `!snapshot.metadata.fromCache`. Only confirmed answers reset the backoff. */
  confirmed?: (value: T) => boolean;
  /** Called when a subscription settles on permission-denied (before the next recovery attempt). */
  onDenied?: (error: unknown) => void;
};

export function tabletListener<T>(
  subscribe: (next: (value: T) => void, error: (error: unknown) => void) => () => void,
  handlers: TabletListenerHandlers<T>,
  environment?: ResilientEnvironment,
  recoverAfterMs = TABLET_DENIED_RECOVERY_MS,
): ResilientHandle {
  return resilientListener<T>(subscribe, {
    next: handlers.next,
    confirmed: handlers.confirmed,
    recoverUnauthorizedAfterMs: recoverAfterMs,
    status: (status) => {
      if (status.kind === 'unauthorized') handlers.onDenied?.(status.error);
    },
  }, environment);
}
