
'use client';

import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '@/hooks/use-auth';
import { useToast } from '@/hooks/use-toast';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { BellOff, BellRing, Loader2, RefreshCw, Share } from 'lucide-react';
import {
    PushSetupError,
    pushRegisteredHere,
    registerPushOnThisDevice,
    turnOffPushOnThisDevice,
    turnOnPushOnThisDevice,
} from '@/lib/push-registration';
import { readPushOff } from '@/lib/push-tokens';
import { deviceStorage } from '@/lib/dashboard/house-snapshot';
import { isIOSDevice, pushCardState, pushSupport, type PushSupport } from '@/lib/push-status';
import { friendlyError } from '@/lib/friendly-error';

const detectSupport = (): PushSupport => {
    const standalone = window.matchMedia?.('(display-mode: standalone)').matches ||
        (navigator as Navigator & { standalone?: boolean }).standalone === true;
    return pushSupport({
        hasNotification: 'Notification' in window,
        hasServiceWorker: 'serviceWorker' in navigator,
        hasPushManager: 'PushManager' in window,
        isIOS: isIOSDevice({ userAgent: navigator.userAgent, platform: navigator.platform, maxTouchPoints: navigator.maxTouchPoints }),
        standalone,
    });
};

/**
 * Profile's push card (NO-5, NO-17): the real state of this device (registered,
 * needs re-connecting, turned off, blocked, or an iPhone that must add HomeHub to
 * the Home Screen first), one outcome toast per action, and a short explanation
 * before the browser's permission prompt, whose "Block" is usually permanent.
 */
export function PushNotificationSettings({ embedded = false }: { embedded?: boolean } = {}) {
    const { currentUser } = useAuth();
    const { toast } = useToast();
    const email = currentUser?.email;
    const [support, setSupport] = useState<PushSupport>('supported');
    const [permission, setPermission] = useState<NotificationPermission | 'unsupported'>('default');
    const [optedOut, setOptedOut] = useState(false);
    const [registered, setRegistered] = useState<boolean | null>(null);
    const [busy, setBusy] = useState(false);

    const refresh = useCallback(async () => {
        const found = detectSupport();
        setSupport(found);
        const current = found === 'supported' ? Notification.permission : 'unsupported';
        setPermission(current);
        setOptedOut(readPushOff(deviceStorage(), email));
        if (current !== 'granted' || !email) return;
        setRegistered(null);
        try {
            setRegistered(await pushRegisteredHere(email));
        } catch {
            setRegistered(false);
        }
    }, [email]);

    useEffect(() => {
        // After the effect: the checks read the browser and storage, then set state.
        void Promise.resolve().then(refresh);
    }, [refresh]);

    const run = async (work: () => Promise<{ title: string; description: string } | null>) => {
        if (!currentUser?.email) return;
        setBusy(true);
        try {
            const outcome = await work();
            if (outcome) toast(outcome);
        } catch (err) {
            console.error('Push setup failed.', err instanceof Error ? err : String(err));
            toast({ variant: 'destructive', title: 'Push notifications are not on', description: err instanceof PushSetupError ? err.message : friendlyError(err) });
        } finally {
            setBusy(false);
            await refresh();
        }
    };

    const enable = () => run(async () => {
        const result = await Notification.requestPermission();
        setPermission(result);
        if (result !== 'granted') {
            return { title: 'Notifications are blocked', description: 'You can allow them later in your browser settings.' };
        }
        await turnOnPushOnThisDevice(currentUser!);
        return { title: 'Push notifications are on', description: 'This device will get HomeHub alerts.' };
    });

    const reconnect = () => run(async () => {
        await registerPushOnThisDevice(currentUser!);
        return { title: 'Reconnected', description: 'This device will get HomeHub alerts again.' };
    });

    const turnOn = () => run(async () => {
        await turnOnPushOnThisDevice(currentUser!);
        return { title: 'Push notifications are on', description: 'This device will get HomeHub alerts.' };
    });

    const turnOff = () => run(async () => {
        const removed = await turnOffPushOnThisDevice(currentUser!.email);
        return removed
            ? { title: 'Push notifications are off on this device', description: 'Your other devices still get them.' }
            : { title: 'Turned off on this device', description: 'It finishes the next time this device is online.' };
    });

    const state = pushCardState({ support, permission, optedOut, registered });
    const spinner = busy ? <Loader2 className="animate-spin" aria-hidden /> : null;

    const renderContent = () => {
        switch (state) {
            case 'ios-install':
                return (
                    <div className="space-y-2 rounded-lg border p-4 text-sm" data-testid="push-ios-install">
                        <p className="font-medium">Add HomeHub to your Home Screen first.</p>
                        <p className="text-muted-foreground">
                            On iPhone and iPad, notifications work only in the installed app: tap <Share className="inline h-4 w-4 align-text-bottom" aria-label="Share" /> Share, choose Add to Home Screen, open HomeHub from the new icon, then come back here to turn them on.
                        </p>
                    </div>
                );
            case 'unsupported':
                return <p className="rounded-lg border p-4 text-center text-sm text-muted-foreground">This browser can&apos;t receive push notifications.</p>;
            case 'denied':
                return (
                    <div className="rounded-lg border border-destructive/50 p-4 text-center">
                        <p className="text-sm text-destructive">Notifications are blocked for HomeHub in this browser.</p>
                        <p className="mt-1 text-xs text-muted-foreground">Allow them in the browser&apos;s site settings, then reload this page.</p>
                    </div>
                );
            case 'ask':
                return (
                    <div className="space-y-3">
                        <p className="text-sm text-muted-foreground">Your browser will ask next. Choose Allow: if you block it, it can only be changed in the browser&apos;s settings.</p>
                        <Button onClick={enable} disabled={busy} className="w-full">
                            {spinner ?? <BellRing aria-hidden />}
                            Turn on push notifications
                        </Button>
                    </div>
                );
            case 'off':
                return (
                    <div className="space-y-3">
                        <p className="text-sm text-muted-foreground">Push notifications are turned off on this device.</p>
                        <Button onClick={turnOn} disabled={busy} className="w-full">
                            {spinner ?? <BellRing aria-hidden />}
                            Turn on for this device
                        </Button>
                    </div>
                );
            case 'checking':
                return <p className="flex items-center justify-center gap-2 p-4 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Checking this device…</p>;
            case 'reconnect':
                return (
                    <div className="space-y-3">
                        <p className="text-sm text-muted-foreground" data-testid="push-status">This device is not connected for alerts right now.</p>
                        <Button onClick={reconnect} disabled={busy} className="w-full">
                            {spinner ?? <RefreshCw aria-hidden />}
                            Re-connect this device
                        </Button>
                    </div>
                );
            case 'registered':
                return (
                    <div className="space-y-3">
                        <div className="rounded-lg border bg-secondary/50 p-4 text-center">
                            <p className="text-sm font-medium" data-testid="push-status">This device is registered for alerts.</p>
                        </div>
                        <Button variant="outline" onClick={turnOff} disabled={busy} className="w-full">
                            {spinner ?? <BellOff aria-hidden />}
                            Turn off on this device
                        </Button>
                    </div>
                );
        }
    };

    // PR-17: inside Profile's Notifications card it is a section, not a card of its own.
    if (embedded) {
        return (
            <section aria-labelledby="push-heading" className="space-y-3" data-testid="push-settings">
                <h3 id="push-heading" className="font-semibold">On this device</h3>
                {renderContent()}
            </section>
        );
    }

    return (
        <Card>
            <CardHeader>
                <CardTitle className="font-headline flex items-center gap-2"><BellRing aria-hidden /> Push Notifications</CardTitle>
                <CardDescription>Receive notifications directly on your device, even when the app is closed.</CardDescription>
            </CardHeader>
            <CardContent>
                {renderContent()}
            </CardContent>
        </Card>
    );
}
