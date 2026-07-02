
'use client';

import { useState, useEffect } from 'react';
import { useAuth } from '@/hooks/use-auth';
import { useToast } from '@/hooks/use-toast';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { BellRing, Loader2 } from 'lucide-react';
import { getFirebaseMessaging } from '@/lib/firebase';
import { getToken } from 'firebase/messaging';


async function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) {
        throw new Error('Service workers are not supported by this browser.');
    }
    // Explicitly register our service worker at /api/sw with the root scope
    const registration = await navigator.serviceWorker.register('/api/sw', {
        scope: '/',
    });
    return registration;
}

export function PushNotificationSettings() {
    const { currentUser, updateUser } = useAuth();
    const { toast } = useToast();
    const [permission, setPermission] = useState<NotificationPermission | 'unsupported'>('default');
    const [isSubscribing, setIsSubscribing] = useState(false);

    useEffect(() => {
        if ('Notification' in window) {
            setPermission(Notification.permission);
        } else {
            setPermission('unsupported');
        }
    }, []);

    const handleSubscribe = async () => {
        if (!currentUser?.email) return;
        setIsSubscribing(true);

        try {
            const permissionResult = await Notification.requestPermission();
            setPermission(permissionResult);

            if (permissionResult !== 'granted') {
                toast({ variant: 'destructive', title: 'Permission Denied', description: 'You can enable notifications later in your browser settings.' });
                setIsSubscribing(false);
                return;
            }

            toast({ title: 'Permissions granted!', description: 'Subscribing to notifications...' });

            const messaging = await getFirebaseMessaging();
            if (!messaging) {
                throw new Error('Firebase Messaging is not supported in this browser.');
            }
            
            const vapidKey = process.env.NEXT_PUBLIC_FIREBASE_VAPID_KEY;
            if (!vapidKey) {
                throw new Error('VAPID key is not configured. Please add NEXT_PUBLIC_FIREBASE_VAPID_KEY to your .env file.');
            }

            // Register our custom service worker and get the registration object
            const registration = await registerServiceWorker();

            // Get the token, explicitly passing our service worker registration
            const currentToken = await getToken(messaging, { 
                vapidKey,
                serviceWorkerRegistration: registration,
            });
            
            if (currentToken) {
                const newTokens = Array.from(new Set([...(currentUser.fcmTokens || []), currentToken]));
                await updateUser({ fcmTokens: newTokens });
                toast({ title: 'Subscription Successful!', description: 'Push notifications are now active on this device.' });
            } else {
                 throw new Error('Failed to retrieve FCM token.');
            }

        } catch (err: any) {
            console.error('An error occurred while subscribing to notifications. ', err);
            toast({ variant: 'destructive', title: 'Subscription Failed', description: err.message || 'An unexpected error occurred.' });
        } finally {
            setIsSubscribing(false);
        }
    }

    const renderContent = () => {
        switch (permission) {
            case 'granted':
                return (
                    <div className="rounded-lg border bg-secondary/50 p-4 text-center">
                        <p className="text-sm font-medium">Push notifications are active on this device.</p>
                    </div>
                );
            case 'denied':
                return (
                    <div className="rounded-lg border border-destructive/50 p-4 text-center">
                        <p className="text-sm text-destructive">Notifications are blocked.</p>
                        <p className="text-xs text-muted-foreground mt-1">Please enable them in your browser settings to receive alerts.</p>
                    </div>
                );
            case 'unsupported':
                return (
                    <div className="rounded-lg border p-4 text-center">
                        <p className="text-sm text-muted-foreground">This browser does not support push notifications.</p>
                    </div>
                );
            default: // 'default'
                return (
                    <Button onClick={handleSubscribe} disabled={isSubscribing} className="w-full">
                        {isSubscribing ? <Loader2 className="mr-2 animate-spin" /> : <BellRing />}
                        Enable Push Notifications
                    </Button>
                );
        }
    }

    return (
        <Card>
            <CardHeader>
                <CardTitle className="font-headline flex items-center gap-2"><BellRing/> Push Notifications</CardTitle>
                <CardDescription>Receive notifications directly on your device, even when the app is closed.</CardDescription>
            </CardHeader>
            <CardContent>
                {renderContent()}
            </CardContent>
        </Card>
    );
}
