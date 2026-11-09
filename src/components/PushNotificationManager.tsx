'use client';

import { useEffect } from 'react';
import { registerHomeHubServiceWorker, shouldAutoRegisterServiceWorker } from '@/lib/service-worker';

/**
 * Registers the combined push + offline service worker for every visitor, once
 * the page has finished loading, so it never competes with first paint.
 * PushNotificationSettings registers the same URL/scope on push opt-in and
 * receives this registration. No Firebase here: signed-out pages stay within the
 * first-paint budget (foreground push toasts are `PushForegroundListener`).
 */
export function PushNotificationManager() {
  useEffect(() => {
    if (typeof window === 'undefined' || !('serviceWorker' in navigator) || !shouldAutoRegisterServiceWorker()) return;

    const register = () => {
      registerHomeHubServiceWorker().catch((error: unknown) => {
        console.warn('Service worker registration failed', error instanceof Error ? error.message : String(error));
      });
    };

    if (document.readyState === 'complete') {
      register();
      return;
    }
    window.addEventListener('load', register, { once: true });
    return () => window.removeEventListener('load', register);
  }, []);

  return null;
}
