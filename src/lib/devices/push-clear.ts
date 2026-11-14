// Clears push state a previous personal session left in this browser, before it signs
// in as a wall tablet (S5): a device principal must never hold a push subscription
// (NO-2c). Unsubscribes the service worker's push subscription, deletes the FCM token
// where Messaging is supported, and removes the stored push-device record that
// src/lib/push-registration.ts keeps. Failures are reported, never thrown: pairing
// goes on, and the tablet retries at start until it succeeds.
import { clearPushDevice } from '@/lib/push-tokens';
import { deviceStorage } from '@/lib/dashboard/house-snapshot';
import { SERVICE_WORKER_SCOPE } from '@/lib/service-worker';

export type PushClearDeps = {
  getSubscriptions: () => Promise<Array<{ unsubscribe(): Promise<boolean> }>>;
  deleteFcmToken: () => Promise<void>;
  clearStoredRecord: () => void;
};

export type PushClearResult = { ok: boolean; unsubscribed: number; errors: string[] };

const describe = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Runs every step, whatever fails (the FCM token first, while its subscription still
 * exists, then any subscription left); `ok` only when all of them succeeded.
 */
export const clearPushState = async (deps: PushClearDeps): Promise<PushClearResult> => {
  const errors: string[] = [];
  let unsubscribed = 0;
  try {
    await deps.deleteFcmToken();
  } catch (error) {
    errors.push(describe(error));
  }
  try {
    for (const subscription of await deps.getSubscriptions()) {
      if (await subscription.unsubscribe()) unsubscribed += 1;
      else errors.push('A push subscription could not be ended.');
    }
  } catch (error) {
    errors.push(describe(error));
  }
  try {
    deps.clearStoredRecord();
  } catch (error) {
    errors.push(describe(error));
  }
  return { ok: errors.length === 0, unsubscribed, errors };
};

/** The browser's dependencies: the HomeHub service worker, Firebase Messaging, local storage. */
export const browserPushClearDeps = (): PushClearDeps => ({
  getSubscriptions: async () => {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return [];
    const registration = await navigator.serviceWorker.getRegistration(SERVICE_WORKER_SCOPE);
    const subscription = await registration?.pushManager?.getSubscription();
    return subscription ? [subscription] : [];
  },
  deleteFcmToken: async () => {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
    const registration = await navigator.serviceWorker.getRegistration(SERVICE_WORKER_SCOPE);
    if (!registration) return;
    const [{ getFirebaseMessaging }, { deleteToken }] = await Promise.all([import('@/lib/firebase'), import('firebase/messaging')]);
    const messaging = await getFirebaseMessaging();
    if (!messaging) return;
    // As in push-registration.ts: point deleteToken at HomeHub's worker instead of the SDK default.
    const service = messaging as typeof messaging & { swRegistration?: ServiceWorkerRegistration };
    service.swRegistration ??= registration;
    await deleteToken(messaging);
  },
  clearStoredRecord: () => clearPushDevice(deviceStorage()),
});
