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
  // A tablet session running now: any later cleanup starts from the first step.
  attempt(() => storage?.removeItem(TABLET_CLEANUP_KEY));
};

export const hasTabletMarker = (storage: KeyStorage | null = browserStorage()): boolean =>
  attempt(() => storage?.getItem(TABLET_MARKER_KEY) === '1') === true;

export const forgetTabletMarker = (storage: KeyStorage | null = browserStorage()): void => {
  attempt(() => storage?.removeItem(TABLET_MARKER_KEY));
};

export type FormerTabletDeps = {
  /**
   * Whether a person is signed in on this browser right now. Recovery only starts while
   * nobody is, and checks again before every step that clears data, so a sign-in during
   * recovery stops it before anything of theirs is cleared. The one exception is the reload
   * after Firestore was shut down (the last step): that page can't work without it.
   */
  signedIn: () => boolean;
  deleteDeviceDatabase: () => unknown | Promise<unknown>;
  forgetHousehold: () => unknown | Promise<unknown>;
  clearPush: () => unknown | Promise<unknown>;
  /** Shuts the page's Firestore down and clears its cache: the page must reload afterwards. */
  clearFirestore: () => unknown | Promise<unknown>;
  /** A full load of the setup screen. */
  navigate: () => void;
};

/**
 * The cleanup still owed is durable: the marker stays until every step has run, and this
 * key counts the steps already done, so a refresh or a closed page mid-cleanup resumes at
 * the next step on the next signed-out start (steps already done are not repeated).
 */
export const TABLET_CLEANUP_KEY = 'homehub.tablet-cleanup';
const PROBE_KEY = 'homehub.tablet-cleanup-probe';

/** The steps in order. Firestore is last: once it is shut down the page always reloads. */
export const FORMER_TABLET_STEPS = ['deleteDeviceDatabase', 'forgetHousehold', 'clearPush', 'clearFirestore'] as const;

const stepsDone = (storage: KeyStorage | null): number => {
  const raw = attempt(() => storage?.getItem(TABLET_CLEANUP_KEY) ?? null);
  const value = raw === null ? 0 : Number(raw);
  return Number.isInteger(value) && value >= 0 && value <= FORMER_TABLET_STEPS.length ? value : 0;
};

/** Storage can both write and remove a key (checked before anything is cleared, so a page never reloads in a loop). */
const storageRemoves = (storage: KeyStorage | null): boolean =>
  attempt(() => {
    if (!storage) return false;
    storage.setItem(PROBE_KEY, '1');
    storage.removeItem(PROBE_KEY);
    return storage.getItem(PROBE_KEY) === null;
  }) === true;

let recovering = false;

/**
 * - `ran`: every step has run and the marker is gone; the setup screen was reloaded when
 *   this page shut Firestore down.
 * - `not-needed`: no marker (or a recovery is already running in this page).
 * - `signed-in`: a person is (or became) signed in before Firestore was shut down: stopped
 *   before the next step; the marker and the progress are kept, so the next signed-out start
 *   resumes where this one stopped.
 * - `marker-stuck`: storage cannot remove keys: nothing is cleared and nothing reloads, so a
 *   page can never reload in a loop; the next start tries again.
 */
export type RecoveryResult = 'ran' | 'not-needed' | 'signed-in' | 'marker-stuck';

/**
 * Finishes the clearing a tablet could not do itself, only while nobody is signed in.
 * Before anything is cleared, storage must prove it can remove a key (a probe). Each step
 * is best effort and time-boxed, preceded by a sign-in check, and recorded once run. The
 * marker is removed only after the last step. Once Firestore has been shut down the page
 * always reloads (a person who signed in meanwhile reloads into a working app; nothing of
 * theirs is cleared after the check). A resumed run whose steps were all done before needs
 * no reload; so if the marker could still not be removed after a reload, the next start
 * does nothing more and the page never reloads in a loop.
 */
export async function recoverFormerTablet(deps: FormerTabletDeps, storage: KeyStorage | null = browserStorage(), stepTimeoutMs = CLEAR_STEP_TIMEOUT_MS): Promise<RecoveryResult> {
  if (recovering || !hasTabletMarker(storage)) return 'not-needed';
  if (deps.signedIn()) return 'signed-in';
  recovering = true;
  try {
    if (!storageRemoves(storage)) return 'marker-stuck';
    let firestoreShutDown = false;
    for (let index = stepsDone(storage); index < FORMER_TABLET_STEPS.length; index += 1) {
      const name = FORMER_TABLET_STEPS[index];
      // Before each step, never after Firestore is gone (that page reloads whatever happens).
      if (deps.signedIn()) return 'signed-in';
      if (name === 'clearFirestore') firestoreShutDown = true;
      try {
        await withTimeout(Promise.resolve().then(deps[name]), stepTimeoutMs, 'former tablet clearing');
      } catch {
        // Best effort: the next step still runs.
      }
      attempt(() => storage?.setItem(TABLET_CLEANUP_KEY, String(index + 1)));
    }
    forgetTabletMarker(storage);
    // The progress goes only with the marker: a marker that somehow stays leaves every step
    // recorded as done, so the next start runs nothing and never reloads again.
    if (!hasTabletMarker(storage)) attempt(() => storage?.removeItem(TABLET_CLEANUP_KEY));
    if (firestoreShutDown) {
      deps.navigate();
      return 'ran';
    }
    return hasTabletMarker(storage) ? 'marker-stuck' : 'ran';
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
    clearPush: async () => {
      const { clearPushState, browserPushClearDeps } = await import('./push-clear');
      await clearPushState(browserPushClearDeps());
    },
    clearFirestore: async () => (await import('@/lib/firebase')).clearLocalFirestoreCache(),
    navigate: () => window.location.replace(formerTabletReloadUrl(window.location.origin, code)),
  });
}
