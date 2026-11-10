'use client';

import { useEffect, useRef } from 'react';
import { onMessage } from 'firebase/messaging';
import { useAuth } from '@/hooks/use-auth';
import { useToast } from '@/hooks/use-toast';
import { getFirebaseMessaging } from '@/lib/firebase';
import { syncPushForSignedInUser } from '@/lib/push-registration';

/**
 * Shows push messages that arrive while HomeHub is open as toasts. It imports
 * `@/lib/firebase` (and so Firestore and App Check), so the deferred shell loads
 * it only for a signed-in member: push messages only ever go to members.
 *
 * It also keeps this device's push registration in step with the signed-in
 * account: browser permission outlives sign-out but the token does not, so a
 * device that already has permission is registered again for whoever signs in.
 */
export function PushForegroundListener() {
  const { toast } = useToast();
  const { currentUser } = useAuth();
  const email = currentUser?.email;
  const legacyTokens = useRef<unknown>(undefined);

  useEffect(() => {
    legacyTokens.current = currentUser?.fcmTokens;
  });

  useEffect(() => {
    if (email) void syncPushForSignedInUser({ email, fcmTokens: legacyTokens.current });
  }, [email]);

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
