'use client';

import { useEffect, useRef } from 'react';
import { onMessage } from 'firebase/messaging';
import { doc, updateDoc } from 'firebase/firestore';
import { useAuth } from '@/hooks/use-auth';
import { useToast } from '@/hooks/use-toast';
import { db, getFirebaseMessaging } from '@/lib/firebase';
import { syncPushForSignedInUser } from '@/lib/push-registration';
import { createNotificationAction } from '@/lib/notifications';
import { openedNotificationId, withoutOpenedNotification } from '@/lib/push-open';

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

  // NO-9: a push opened this page (`?n=<id>`): mark that notification read for
  // this member, then drop the parameter so a reload or a shared link does not
  // repeat it. The rules refuse it for a notification not addressed to them.
  const uid = currentUser?.uid;
  const householdId = currentUser?.householdId;
  const displayName = currentUser?.displayName;
  useEffect(() => {
    if (typeof window === 'undefined' || !uid || !householdId) return;
    const id = openedNotificationId(window.location.search);
    if (!id) return;
    window.history.replaceState(window.history.state, '', withoutOpenedNotification(window.location.href));
    updateDoc(doc(db, 'households', householdId, 'notifications', id), {
      [`readBy.${uid}`]: createNotificationAction({ uid, displayName: displayName ?? '' }),
    }).catch((error: unknown) => console.warn('The opened notification could not be marked read.', error));
  }, [uid, householdId, displayName]);

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
