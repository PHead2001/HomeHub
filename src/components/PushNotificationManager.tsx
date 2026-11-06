
'use client';

import { useEffect } from 'react';
import { onMessage } from 'firebase/messaging';
import { useToast } from '@/hooks/use-toast';
import { getFirebaseMessaging } from '@/lib/firebase';
import { registerHomeHubServiceWorker, shouldAutoRegisterServiceWorker } from '@/lib/service-worker';

export function PushNotificationManager() {
    const { toast } = useToast();

    useEffect(() => {
        // Register the combined push + offline worker once the page has finished
        // loading, so it never competes with first paint. PushNotificationSettings
        // registers the same URL/scope on push opt-in and receives this registration.
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

    useEffect(() => {
        // Foreground messages are shown as toasts.
        const setupForegroundListener = async () => {
            const messaging = await getFirebaseMessaging();

            if (messaging) {
                onMessage(messaging, (payload) => {
                    toast({
                        title: payload.notification?.title,
                        description: payload.notification?.body,
                    });
                });
            }
        };

        if (typeof window !== 'undefined' && 'serviceWorker' in navigator) {
            // We wait for the service worker to be ready before setting up the listener.
            navigator.serviceWorker.ready.then(() => {
                setupForegroundListener();
            });
        }
    }, [toast]);

    return null; // This component is for side effects only
}
