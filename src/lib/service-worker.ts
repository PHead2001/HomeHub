// The one HomeHub service worker (push + offline app shell), served by
// src/app/api/sw/route.ts. Every registration must use this URL and scope:
// a second worker at the same scope would replace this one and break either
// push or offline support.
export const SERVICE_WORKER_URL = '/api/sw';
export const SERVICE_WORKER_SCOPE = '/';

export async function registerHomeHubServiceWorker(): Promise<ServiceWorkerRegistration> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
    throw new Error('Service workers are not supported by this browser.');
  }
  return navigator.serviceWorker.register(SERVICE_WORKER_URL, { scope: SERVICE_WORKER_SCOPE });
}

/** True when HomeHub's worker holds a browser push subscription. Registers nothing. */
export async function hasPushSubscription(): Promise<boolean> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return false;
  const registration = await navigator.serviceWorker.getRegistration(SERVICE_WORKER_SCOPE);
  return Boolean(await registration?.pushManager?.getSubscription());
}

/**
 * Production builds register the worker on every visit so the app is
 * installable and the shopping lists open offline. Development (and the
 * Playwright suite, which runs the dev server) does not, so cached shells never
 * mask code changes or intercept test traffic; push opt-in still registers it.
 */
export const shouldAutoRegisterServiceWorker = () => process.env.NODE_ENV === 'production';
