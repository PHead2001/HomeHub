'use client';

import { useEffect } from 'react';
import { onMessage } from 'firebase/messaging';
import { useToast } from '@/hooks/use-toast';
import { getFirebaseMessaging } from '@/lib/firebase';

/**
 * Shows push messages that arrive while HomeHub is open as toasts. It imports
 * `@/lib/firebase` (and so Firestore and App Check), so the deferred shell loads
 * it only for a signed-in member: push messages only ever go to members.
 */
export function PushForegroundListener() {
  const { toast } = useToast();

  useEffect(() => {
    if (typeof window === 'undefined' || !('serviceWorker' in navigator)) return;
    let unsubscribe: (() => void) | null = null;
    let cancelled = false;
    // Wait for the service worker before attaching the listener.
    void navigator.serviceWorker.ready.then(async () => {
      const messaging = await getFirebaseMessaging();
      if (!messaging || cancelled) return;
      unsubscribe = onMessage(messaging, (payload) => {
        toast({ title: payload.notification?.title, description: payload.notification?.body });
      });
    });
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [toast]);

  return null;
}
