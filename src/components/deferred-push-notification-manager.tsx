'use client';

/**
 * Shell pieces that wait until the page has loaded and the browser is idle, so
 * first paint never waits for them:
 * - `PushNotificationManager` (Firebase Messaging, the service worker registration
 *   and foreground push toasts; the worker already registered only after `load`);
 * - the toast viewport (`Toaster`). Toasts raised earlier are kept in the toast
 *   store and appear as soon as it mounts;
 * - the Google sign-in popup resolver, warmed for signed-out visitors.
 */
import { useEffect, useState } from 'react';
import dynamic from 'next/dynamic';
import { useAuth } from '@/hooks/use-auth';
import { warmSignInPopup } from '@/lib/auth-popup';

const PushNotificationManager = dynamic(() => import('./PushNotificationManager').then((mod) => mod.PushNotificationManager), { ssr: false });
const Toaster = dynamic(() => import('./ui/toaster').then((mod) => mod.Toaster), { ssr: false });

type IdleWindow = Window & { requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number; cancelIdleCallback?: (id: number) => void };

/** True once the window has loaded and the browser had an idle moment (at most 3 s later). */
export function useAfterLoadIdle(): boolean {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const win = window as IdleWindow;
    let idleId: number | null = null;
    let timer: number | null = null;
    const start = () => {
      if (win.requestIdleCallback) idleId = win.requestIdleCallback(() => setReady(true), { timeout: 3000 });
      else timer = window.setTimeout(() => setReady(true), 1);
    };
    if (document.readyState === 'complete') start();
    else window.addEventListener('load', start, { once: true });
    return () => {
      window.removeEventListener('load', start);
      if (idleId !== null) win.cancelIdleCallback?.(idleId);
      if (timer !== null) window.clearTimeout(timer);
    };
  }, []);
  return ready;
}

export function DeferredPushNotificationManager() {
  return useAfterLoadIdle() ? <PushNotificationManager /> : null;
}

export function DeferredToaster() {
  return useAfterLoadIdle() ? <Toaster /> : null;
}

/** Warms the sign-in popup for signed-out visitors once the page is idle. */
export function SignInWarmup() {
  const ready = useAfterLoadIdle();
  const { currentUser, loading } = useAuth();
  useEffect(() => {
    if (ready && !loading && !currentUser) warmSignInPopup();
  }, [ready, loading, currentUser]);
  return null;
}
