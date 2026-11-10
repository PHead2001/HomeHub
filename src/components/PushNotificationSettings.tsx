
'use client';

import { useState, useEffect } from 'react';
import { useAuth } from '@/hooks/use-auth';
import { useToast } from '@/hooks/use-toast';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { BellRing, Loader2 } from 'lucide-react';
import { PushSetupError, registerPushOnThisDevice } from '@/lib/push-registration';
import { friendlyError } from '@/lib/friendly-error';

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

            // Gets this device's token and stores it in the owner-only push document.
            await registerPushOnThisDevice(currentUser);
            toast({ title: 'Subscription Successful!', description: 'Push notifications are now active on this device.' });

        } catch (err) {
            console.error('An error occurred while subscribing to notifications. ', err instanceof Error ? err : String(err));
            toast({ variant: 'destructive', title: 'Subscription Failed', description: err instanceof PushSetupError ? err.message : friendlyError(err) });
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
