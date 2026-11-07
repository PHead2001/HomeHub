
'use client';

import { useState, useEffect } from 'react';
import { useAuth } from '@/hooks/use-auth';
import { useToast } from '@/hooks/use-toast';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { BellRing, Loader2 } from 'lucide-react';
import { db, getFirebaseMessaging } from '@/lib/firebase';
import { getToken } from 'firebase/messaging';
import { arrayUnion, deleteField, doc, serverTimestamp, writeBatch } from 'firebase/firestore';
import { awaitWriteUnlessOffline } from '@/lib/firestore-offline';
import { registerHomeHubServiceWorker } from '@/lib/service-worker';



const getErrorMessage = (error: unknown) => error instanceof Error ? error.message : undefined;

export function PushNotificationSettings() {
    const { currentUser } = useAuth();
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

            // Register (or reuse) the combined push + offline service worker at /api/sw
            const registration = await registerHomeHubServiceWorker();

            // Get the token, explicitly passing our service worker registration
            const currentToken = await getToken(messaging, { 
                vapidKey,
                serviceWorkerRegistration: registration,
            });
            
            if (currentToken) {
                // Tokens live in an owner-only document so housemates, who can read
                // the profile, never see them. Any legacy profile tokens move along.
                const legacyTokens = (currentUser.fcmTokens || []).filter(token => typeof token === 'string');
                const batch = writeBatch(db);
                batch.set(doc(db, 'users', currentUser.email, 'private', 'push'), {
                    fcmTokens: arrayUnion(...legacyTokens, currentToken),
                    updatedAt: serverTimestamp(),
                }, { merge: true });
                if (currentUser.fcmTokens) {
                    batch.update(doc(db, 'users', currentUser.email), { fcmTokens: deleteField() });
                }
                await awaitWriteUnlessOffline(batch.commit(), error => {
                    console.error('Push subscription could not be saved.', error instanceof Error ? error : String(error));
                });
                toast({ title: 'Subscription Successful!', description: 'Push notifications are now active on this device.' });
            } else {
                 throw new Error('Failed to retrieve FCM token.');
            }

        } catch (err) {
            console.error('An error occurred while subscribing to notifications. ', err instanceof Error ? err : String(err));
            toast({ variant: 'destructive', title: 'Subscription Failed', description: getErrorMessage(err) || 'An unexpected error occurred.' });
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
