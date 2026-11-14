// "This browser was a wall tablet" (docs/modules/devices/README.md, "Revocation on the
// tablet"). The tablet shell clears its data whenever it observes the end of its session,
// but a tablet can also lose its session while the shell is not running: removed while
// switched off, its sign-in then refused at the next start, so the app starts signed out
// and the shell never mounts. A marker in localStorage, set while the shell runs and removed
// by the shell's own clearing, lets the signed-out app (and the setup screen) finish the
// clearing: the tablet database, the household's local data, the Firestore cache and push
// state, then a fresh load of the setup screen.

import { withTimeout, CLEAR_STEP_TIMEOUT_MS } from './device-session';
import { codeFromSetupFragment, deviceSetupUrl } from './device-codes';

export const TABLET_MARKER_KEY = 'homehub.tablet-browser';

type KeyStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

const browserStorage = (): KeyStorage | null => {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
};

const attempt = <T,>(work: () => T): T | null => {
  try {
    return work();
  } catch {
    return null;
  }
};

export const markTabletBrowser = (storage: KeyStorage | null = browserStorage()): void => {
  attempt(() => storage?.setItem(TABLET_MARKER_KEY, '1'));
};

export const hasTabletMarker = (storage: KeyStorage | null = browserStorage()): boolean =>
  attempt(() => storage?.getItem(TABLET_MARKER_KEY) === '1') === true;

export const forgetTabletMarker = (storage: KeyStorage | null = browserStorage()): void => {
  attempt(() => storage?.removeItem(TABLET_MARKER_KEY));
};

export type FormerTabletDeps = {
  deleteDeviceDatabase: () => unknown | Promise<unknown>;
  forgetHousehold: () => unknown | Promise<unknown>;
  clearFirestore: () => unknown | Promise<unknown>;
  clearPush: () => unknown | Promise<unknown>;
  /** A full load afterwards: Firestore was terminated and cannot be reused in this page. */
  navigate: () => void;
};

let recovering = false;

/**
 * Finishes the clearing a tablet could not do itself. Does nothing unless the marker is
 * present. Every step is best effort and time-boxed; the marker is removed before the
 * navigation, so this runs once. Returns whether it ran.
 */
export async function recoverFormerTablet(deps: FormerTabletDeps, storage: KeyStorage | null = browserStorage(), stepTimeoutMs = CLEAR_STEP_TIMEOUT_MS): Promise<boolean> {
  if (recovering || !hasTabletMarker(storage)) return false;
  recovering = true;
  try {
    for (const step of [deps.deleteDeviceDatabase, deps.forgetHousehold, deps.clearFirestore, deps.clearPush]) {
      try {
        await withTimeout(Promise.resolve().then(step), stepTimeoutMs, 'former tablet clearing');
      } catch {
        // Best effort: the next step still runs.
      }
    }
    forgetTabletMarker(storage);
    deps.navigate();
    return true;
  } finally {
    recovering = false;
  }
}

/** Test helper: the in-progress guard is module state. */
export const resetFormerTabletForTests = () => { recovering = false; };

/**
 * Where recovery reloads to: the setup screen, carrying a setup link's code in the fragment
 * when there was one (a new QR link opened on a former tablet keeps its prefilled code).
 */
export const formerTabletReloadUrl = (origin: string, setupCode: string | null): string =>
  setupCode ? deviceSetupUrl(origin, setupCode) : new URL('/setup', origin).href;

/**
 * Whether the setup screen may strip the code from the address bar now: not while a
 * recovery is still owed (the marker is present), since recovery reloads the page and the
 * code must survive that reload; after it, the marker is gone and the code is stripped.
 */
export const shouldStripSetupFragment = (markerPresent: boolean): boolean => !markerPresent;

/**
 * The browser's own steps (loaded only when the marker is present). The setup code is
 * captured now, before any asynchronous step: `setupCode` when the caller already read it,
 * else the current fragment's.
 */
export function recoverFormerTabletHere(setupCode?: string | null): Promise<boolean> {
  const code = setupCode ?? (typeof window === 'undefined' ? null : codeFromSetupFragment(window.location.hash));
  return recoverFormerTablet({
    deleteDeviceDatabase: async () => (await import('./device-store')).deleteDeviceDatabase(),
    forgetHousehold: async () => (await import('@/lib/auth/household-scope')).forgetHouseholdOnDevice(null),
    clearFirestore: async () => (await import('@/lib/firebase')).clearLocalFirestoreCache(),
    clearPush: async () => {
      const { clearPushState, browserPushClearDeps } = await import('./push-clear');
      await clearPushState(browserPushClearDeps());
    },
    navigate: () => window.location.replace(formerTabletReloadUrl(window.location.origin, code)),
  });
}
