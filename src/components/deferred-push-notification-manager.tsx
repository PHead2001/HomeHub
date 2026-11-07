'use client';

/**
 * Loads `PushNotificationManager` (Firebase Messaging, the service worker
 * registration and foreground push toasts) after the page has loaded and the
 * browser is idle, so first paint never waits for Messaging or Firestore. The
 * manager itself already registered the worker only after `load`, so the timing
 * of that registration is unchanged in practice.
 */
import { useEffect, useState } from 'react';
import dynamic from 'next/dynamic';

const PushNotificationManager = dynamic(() => import('./PushNotificationManager').then((mod) => mod.PushNotificationManager), { ssr: false });

type IdleWindow = Window & { requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number; cancelIdleCallback?: (id: number) => void };

export function DeferredPushNotificationManager() {
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

  return ready ? <PushNotificationManager /> : null;
}
