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
  /**
   * Whether a person is signed in on this browser right now. Recovery only ever runs while
   * nobody is: it is checked before starting and again before every step that clears data
   * or reloads, so a sign-in during recovery stops it (nothing of theirs is cleared).
   */
  signedIn: () => boolean;
  deleteDeviceDatabase: () => unknown | Promise<unknown>;
  forgetHousehold: () => unknown | Promise<unknown>;
  clearFirestore: () => unknown | Promise<unknown>;
  clearPush: () => unknown | Promise<unknown>;
  /** A full load afterwards: Firestore was terminated and cannot be reused in this page. */
  navigate: () => void;
};

let recovering = false;

/**
 * - `ran`: cleared, the marker removed, the setup screen reloaded.
 * - `not-needed`: no marker (or a recovery is already running in this page).
 * - `signed-in`: a person is (or became) signed in: stopped before clearing anything more;
 *   the marker is kept so the next signed-out start finishes it.
 * - `marker-stuck`: the marker cannot be removed (storage refuses writes): nothing is cleared
 *   and nothing reloads, so a page can never reload in a loop; the next start tries again.
 */
export type RecoveryResult = 'ran' | 'not-needed' | 'signed-in' | 'marker-stuck';

/**
 * Finishes the clearing a tablet could not do itself, only while nobody is signed in.
 * The marker is removed first (and must really be gone, or nothing happens); every step is
 * best effort and time-boxed and is preceded by a sign-in check; a sign-in meanwhile puts the
 * marker back and stops. The reload happens only with the marker gone, so it runs once.
 */
export async function recoverFormerTablet(deps: FormerTabletDeps, storage: KeyStorage | null = browserStorage(), stepTimeoutMs = CLEAR_STEP_TIMEOUT_MS): Promise<RecoveryResult> {
  if (recovering || !hasTabletMarker(storage)) return 'not-needed';
  if (deps.signedIn()) return 'signed-in';
  recovering = true;
  try {
    // A marker that cannot be removed would make every load recover and reload again.
    forgetTabletMarker(storage);
    if (hasTabletMarker(storage)) return 'marker-stuck';
    const stopForSignIn = () => {
      if (!deps.signedIn()) return false;
      // Owed still: the next signed-out start finishes it.
      markTabletBrowser(storage);
      return true;
    };
    for (const step of [deps.deleteDeviceDatabase, deps.forgetHousehold, deps.clearFirestore, deps.clearPush]) {
      if (stopForSignIn()) return 'signed-in';
      try {
        await withTimeout(Promise.resolve().then(step), stepTimeoutMs, 'former tablet clearing');
      } catch {
        // Best effort: the next step still runs.
      }
    }
    if (stopForSignIn()) return 'signed-in';
    if (hasTabletMarker(storage)) return 'marker-stuck';
    deps.navigate();
    return 'ran';
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
export async function recoverFormerTabletHere(setupCode?: string | null): Promise<RecoveryResult> {
  const code = setupCode ?? (typeof window === 'undefined' ? null : codeFromSetupFragment(window.location.hash));
  const { auth } = await import('@/lib/firebase-app');
  return recoverFormerTablet({
    signedIn: () => auth.currentUser !== null,
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
