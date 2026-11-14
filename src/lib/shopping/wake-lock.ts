/**
 * The open list's screen wake lock (SH-33a): while a list is open on a personal
 * phone the screen stays on, so the list is there when the member looks back at
 * it in the aisle. Pure and browser-free; `useTripWakeLock` wires it to the
 * Screen Wake Lock API.
 *
 * - Wanted only while a list is open, the page is visible and the device is a
 *   phone (a coarse pointer on a narrow screen); never on a wide screen such as the
 *   wall tablet, and never where the API is missing (feature-detected).
 * - The browser releases the lock whenever the page is hidden; it is requested
 *   again when the page is shown, so the controller re-requests on every
 *   transition back to wanted, also after a system release.
 * - Requests are asynchronous: a lock granted after it stopped being wanted is
 *   released at once, and at most one request is in flight.
 */

export { createWakeLockController } from '@/lib/devices/wake-lock';
export type { WakeLockApi, WakeLockController, WakeLockSentinelLike } from '@/lib/devices/wake-lock';
import { createWakeLockController, type VisibilityLike as SharedVisibility, type WakeLockApi } from '@/lib/devices/wake-lock';

/** A phone in the store: a coarse pointer and a narrow screen (max-width 767 px, the app's `md` breakpoint). */
export const WAKE_LOCK_MEDIA = '(pointer: coarse) and (max-width: 767px)';

export function wakeLockWanted({ listOpen, visible, phone, supported }: {
  listOpen: boolean;
  visible: boolean;
  phone: boolean;
  supported: boolean;
}): boolean {
  return listOpen && visible && phone && supported;
}

/** A media query list as the wake lock needs it (`window.matchMedia(WAKE_LOCK_MEDIA)`). */
export type MediaQueryLike = {
  readonly matches: boolean;
  addEventListener: (type: 'change', listener: () => void) => void;
  removeEventListener: (type: 'change', listener: () => void) => void;
};

/** The page's visibility as the wake lock needs it (`document`). */
export type VisibilityLike = SharedVisibility;

/**
 * Keeps the screen on while an open list is shown on a phone: decides now and
 * again whenever the page is shown or hidden and whenever the phone query starts
 * or stops matching (a phone turned from landscape to portrait, or a window made
 * narrower or wider). Returns the stop, which releases the lock and removes both
 * listeners.
 */
export function watchTripWakeLock({ api, page, phone }: { api: WakeLockApi; page: VisibilityLike; phone: MediaQueryLike | null }): () => void {
  const controller = createWakeLockController(api);
  const update = () => controller.set(wakeLockWanted({
    listOpen: true,
    visible: page.visibilityState === 'visible',
    phone: Boolean(phone?.matches),
    supported: true,
  }));
  update();
  page.addEventListener('visibilitychange', update);
  phone?.addEventListener('change', update);
  return () => {
    page.removeEventListener('visibilitychange', update);
    phone?.removeEventListener('change', update);
    controller.dispose();
  };
}
