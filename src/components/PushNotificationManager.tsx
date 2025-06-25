
'use client';

import { useEffect } from 'react';
import { onMessage } from 'firebase/messaging';
import { useToast } from '@/hooks/use-toast';
import { getFirebaseMessaging } from '@/lib/firebase';

export function PushNotificationManager() {
    const { toast } = useToast();

    useEffect(() => {
        // This component now ONLY handles foreground messages.
        // The service worker is registered on-demand by PushNotificationSettings.
        const setupForegroundListener = async () => {
            const messaging = await getFirebaseMessaging();

            if (messaging) {
                onMessage(messaging, (payload) => {
                    console.log('Foreground message received. ', payload);
                    toast({
                        title: payload.notification?.title,
                        description: payload.notification?.body,
                    });
                });
            }
        };

        if (typeof window !== 'undefined' && 'serviceWorker' in navigator) {
            // We wait for the service worker to be ready before setting up the listener.
            navigator.serviceWorker.ready.then(registration => {
                console.log('Service worker ready for foreground messages.');
                setupForegroundListener();
            });
        }
    }, [toast]);

    return null; // This component is for side effects only
}
