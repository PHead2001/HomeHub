'use client';

import { useEffect, useId, useMemo, useState } from 'react';
import { doc, getDoc, onSnapshot, serverTimestamp, setDoc, updateDoc } from 'firebase/firestore';
import { Loader2, Smartphone } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { useAuth } from '@/hooks/use-auth';
import { useToast } from '@/hooks/use-toast';
import { db } from '@/lib/firebase';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { notificationCategories, notificationCategoryLabels } from '@/lib/notifications';
import { canSeeCategory } from '@functions/shared/push-audience';
import { readPushPrefs, validatePushPrefs } from '@functions/shared/push-prefs';
import { myPushDevices, readPushDevice, type MyPushDevice } from '@/lib/push-tokens';
import { deviceStorage } from '@/lib/dashboard/house-snapshot';
import { removePushDevice, turnOffPushOnThisDevice } from '@/lib/push-registration';
import { friendlyError } from '@/lib/friendly-error';

/**
 * NO-24 and NO-26: the member's own push preferences (categories never pushed, quiet
 * hours in the household's time zone) and "My devices" (every browser getting their
 * pushes, with Turn off). Stored in the owner-only users/{email}/private/push document,
 * which the push function already reads; the bell is unaffected.
 */
export function NotificationPreferencesCard() {
  const { currentUser, permissions } = useAuth();
  const { toast, toastError } = useToast();
  const id = useId();
  const email = currentUser?.email ?? null;
  const [loaded, setLoaded] = useState(false);
  const [stored, setStored] = useState<Record<string, unknown> | null>(null);
  const [muted, setMuted] = useState<string[] | null>(null);
  const [quietOn, setQuietOn] = useState<boolean | null>(null);
  const [start, setStart] = useState<string | null>(null);
  const [end, setEnd] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);

  useEffect(() => {
    if (!email) return;
    return onSnapshot(doc(db, 'users', email, 'private', 'push'), (snapshot) => {
      setStored(snapshot.exists() ? snapshot.data() : null);
      setLoaded(true);
    }, () => setLoaded(true));
  }, [email]);

  const prefs = readPushPrefs(stored?.prefs);
  const mutedValue = muted ?? prefs.mutedCategories;
  const quietValue = quietOn ?? Boolean(prefs.quietHours);
  const startValue = start ?? prefs.quietHours?.start ?? '21:00';
  const endValue = end ?? prefs.quietHours?.end ?? '07:00';
  const categories = notificationCategories.filter((category) => canSeeCategory(category, (permission) => Boolean(permissions[permission])));
  const thisToken = useMemo(() => (typeof window === 'undefined' ? null : readPushDevice(deviceStorage())?.token ?? null), []);
  const devices: MyPushDevice[] = myPushDevices(stored?.fcmTokens, stored?.devices, thisToken);

  const save = async () => {
    if (!email) return;
    const next = validatePushPrefs({ mutedCategories: mutedValue, quietHours: quietValue ? { start: startValue, end: endValue } : null });
    if (!next) {
      toast({ variant: 'destructive', title: 'Check the quiet hours', description: 'Use two different times.' });
      return;
    }
    setSaving(true);
    try {
      const ref = doc(db, 'users', email, 'private', 'push');
      const value = { prefs: { mutedCategories: next.mutedCategories, quietHours: next.quietHours }, updatedAt: serverTimestamp() };
      if ((await getDoc(ref)).exists()) await updateDoc(ref, value);
      else await setDoc(ref, { fcmTokens: [], ...value });
      setMuted(null);
      setQuietOn(null);
      setStart(null);
      setEnd(null);
      toast({ title: 'Notification settings saved' });
    } catch (error) {
      toastError(error, 'Could not save notification settings');
    } finally {
      setSaving(false);
    }
  };

  const turnOff = async (device: MyPushDevice) => {
    if (!email) return;
    setRemoving(device.key);
    try {
      if (device.thisDevice) await turnOffPushOnThisDevice(email);
      else await removePushDevice(email, device.token);
      toast({ title: 'Turned off', description: `${device.label} no longer gets your notifications.` });
    } catch (error) {
      toast({ variant: 'destructive', title: 'Could not turn it off', description: friendlyError(error) });
    } finally {
      setRemoving(null);
    }
  };

  return (
    <Card data-testid="notification-preferences">
      <CardHeader>
        <CardTitle className="font-headline">Notification settings</CardTitle>
        <CardDescription>What reaches your phone. Everything still shows in the bell. Times use the household&apos;s time zone.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">Don&apos;t push these</legend>
          <div className="grid grid-cols-2 gap-2">
            {categories.map((category) => (
              <label key={category} className="flex min-h-[var(--target-min)] items-center gap-3 rounded-md border px-3">
                <Checkbox
                  checked={mutedValue.includes(category)}
                  onCheckedChange={(checked) => setMuted(checked ? [...mutedValue, category] : mutedValue.filter((c) => c !== category))}
                />
                <span className="text-sm">{notificationCategoryLabels[category]}</span>
              </label>
            ))}
          </div>
        </fieldset>
        <div className="space-y-3">
          <div className="flex min-h-[var(--target-min)] items-center justify-between gap-4">
            <Label htmlFor={`${id}-quiet`}>Quiet hours (pushes wait until they end)</Label>
            <Switch id={`${id}-quiet`} checked={quietValue} onCheckedChange={setQuietOn} />
          </div>
          {quietValue && (
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1">
                <Label htmlFor={`${id}-start`}>From</Label>
                <Input id={`${id}-start`} type="time" value={startValue} onChange={(event) => setStart(event.target.value)} />
              </div>
              <div className="space-y-1">
                <Label htmlFor={`${id}-end`}>Until</Label>
                <Input id={`${id}-end`} type="time" value={endValue} onChange={(event) => setEnd(event.target.value)} />
              </div>
            </div>
          )}
        </div>
        <Button onClick={save} disabled={saving || !loaded} className="w-full">
          {saving && <Loader2 className="animate-spin" aria-hidden />}
          Save notification settings
        </Button>
        <section aria-labelledby={`${id}-devices`} className="space-y-2">
          <h3 id={`${id}-devices`} className="text-sm font-medium">My devices</h3>
          {!loaded ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : devices.length === 0 ? (
            <p className="text-sm text-muted-foreground">No device gets your push notifications.</p>
          ) : (
            <ul className="space-y-2" data-testid="my-push-devices">
              {devices.map((device) => (
                <li key={device.key} className="flex items-center gap-3 rounded-md border p-3">
                  <Smartphone aria-hidden className="h-5 w-5 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{device.label}{device.thisDevice ? ' (this device)' : ''}</p>
                    <p className="text-xs text-muted-foreground">{device.lastSeenAt ? `Last seen ${formatDistanceToNow(device.lastSeenAt, { addSuffix: true })}` : 'Last seen: unknown'}</p>
                  </div>
                  <Button variant="outline" size="sm" disabled={removing !== null} onClick={() => void turnOff(device)}>
                    {removing === device.key && <Loader2 className="animate-spin" aria-hidden />}
                    Turn off
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </CardContent>
    </Card>
  );
}
