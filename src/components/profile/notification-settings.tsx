'use client';

import { useEffect, useMemo, useState } from 'react';
import { BellRing, Loader2 } from 'lucide-react';
import { useAuth } from '@/hooks/use-auth';
import { useToast } from '@/hooks/use-toast';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { PushNotificationSettings } from '@/components/PushNotificationSettings';
import { cn } from '@/lib/utils';
import {
  REMINDER_HOURS,
  hourLabel,
  reminderHourFrom,
  reminderTimeFor,
  reminderZoneNote,
} from '@/lib/profile/reminders';

/** How many devices get this person's alerts: the owner-only push document's token list. */
async function readDeviceCount(email: string | null): Promise<number | null> {
  if (!email) return null;
  try {
    const [{ db }, { doc, getDoc }] = await Promise.all([import('@/lib/firebase'), import('firebase/firestore')]);
    const snap = await getDoc(doc(db, 'users', email, 'private', 'push'));
    const tokens = snap.exists() ? snap.get('fcmTokens') : [];
    return Array.isArray(tokens) ? tokens.length : 0;
  } catch {
    return null;
  }
}

type ReminderChoice = { enabled: boolean; hour: number; overdueAlerts: boolean };

/**
 * PR-17: one Notifications card. The daily chore reminder (PR-4 hour picker, PR-5
 * household time zone, PR-15 saved as soon as it changes), the overdue alert switch
 * (NO-4), and this device's push panel (NO-5, NO-17, `PushNotificationSettings`
 * embedded), stated together: a reminder always lands in the bell, and reaches a
 * device as a notification only where push is on.
 */
export function NotificationSettings() {
  const { currentUser, household, updateUser } = useAuth();
  const { toast } = useToast();
  const [choice, setChoice] = useState<ReminderChoice>({
    enabled: currentUser?.choreSettings?.reminderEnabled === true,
    hour: reminderHourFrom(currentUser?.choreSettings?.reminderTime),
    overdueAlerts: currentUser?.choreSettings?.overdueAlerts !== false,
  });
  const [saving, setSaving] = useState(false);
  const [deviceCount, setDeviceCount] = useState<number | null>(null);
  const email = currentUser?.email ?? null;

  useEffect(() => {
    let live = true;
    void readDeviceCount(email).then((count) => { if (live) setDeviceCount(count); });
    return () => { live = false; };
  }, [email]);

  const hours = useMemo(() => REMINDER_HOURS.map((h) => ({ value: String(h), label: hourLabel(h) })), []);

  const save = async (next: ReminderChoice, message: { title: string; description: string }) => {
    const previous = choice;
    setChoice(next);
    setSaving(true);
    try {
      const saved = await updateUser({
        choreSettings: { reminderEnabled: next.enabled, reminderTime: reminderTimeFor(next.hour), overdueAlerts: next.overdueAlerts },
      }, { silent: true });
      // PR-1: a failed write puts the controls back; the error toast has been shown.
      if (!saved) {
        setChoice(previous);
        return;
      }
      toast(message);
    } finally {
      setSaving(false);
    }
  };

  const saveReminder = (next: ReminderChoice) => save(next, {
    title: 'Reminder saved',
    description: next.enabled ? `We'll remind you around ${hourLabel(next.hour)} each day.` : 'Daily chore reminders are off.',
  });

  return (
    <Card data-testid="notification-settings">
      <CardHeader>
        <CardTitle as="h2" className="font-headline flex items-center gap-2"><BellRing aria-hidden /> Notifications</CardTitle>
        <CardDescription>
          Reminders and alerts always appear in the bell. Where notifications are on, they also reach that device.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <section aria-labelledby="reminder-heading" className="space-y-4">
          <h3 id="reminder-heading" className="font-semibold">Daily chore reminder</h3>
          <div className="flex min-h-12 items-center justify-between gap-3 rounded-lg border p-4">
            <Label htmlFor="reminder-enabled" className="text-base">Remind me every day</Label>
            <Switch id="reminder-enabled" checked={choice.enabled} disabled={saving} onCheckedChange={(on) => void saveReminder({ ...choice, enabled: on })} />
          </div>
          <div className={cn('space-y-2', !choice.enabled && 'opacity-60')}>
            <Label htmlFor="reminder-hour">Around</Label>
            <Select value={String(choice.hour)} disabled={!choice.enabled || saving} onValueChange={(value) => void saveReminder({ ...choice, hour: Number(value) })}>
              <SelectTrigger id="reminder-hour" className="min-h-12 w-48" aria-describedby="reminder-zone">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {hours.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}
              </SelectContent>
            </Select>
            <p id="reminder-zone" className="text-sm text-muted-foreground">
              {reminderZoneNote(household?.timeZone)} Reminders are sent once an hour, so they arrive around the time you pick.
            </p>
          </div>
          {/* NO-4: overdue pushes can be turned off; the bell still lists overdue chores. */}
          <div className="flex min-h-12 items-center justify-between gap-3 rounded-lg border p-4">
            <Label htmlFor="overdue-alerts" className="text-base">Alert me when a chore becomes overdue</Label>
            <Switch
              id="overdue-alerts"
              checked={choice.overdueAlerts}
              disabled={saving}
              onCheckedChange={(on) => void save({ ...choice, overdueAlerts: on }, {
                title: 'Saved',
                description: on ? "We'll alert you when a chore becomes overdue." : 'Overdue chores stay in the bell without an alert.',
              })}
            />
          </div>
          {saving && <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Saving…</p>}
        </section>

        <PushNotificationSettings embedded />
        {choice.enabled && (
          <p className="text-sm text-muted-foreground">Your daily reminder reaches a device as a notification only where it is registered for alerts; otherwise it waits in the bell.</p>
        )}
        {deviceCount !== null && (
          <p className="text-sm text-muted-foreground" data-testid="push-device-count">
            {deviceCount === 0 ? 'No device gets your alerts as notifications yet.' : `${deviceCount} ${deviceCount === 1 ? 'device gets' : 'devices get'} your alerts as notifications.`}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
