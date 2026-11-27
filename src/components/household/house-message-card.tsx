'use client';

import { useId, useState, type FormEvent } from 'react';
import { Loader2, Megaphone } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { useUnsavedInput } from '@/hooks/use-shell-busy';
import { auth } from '@/lib/firebase-app';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import {
  HOUSE_ANNOUNCEMENT_DEFAULT_HOURS,
  HOUSE_ANNOUNCEMENT_HOURS,
  HOUSE_ANNOUNCEMENT_MAX_LENGTH,
  validateHouseAnnouncement,
} from '@/lib/house-announcements';
import { postHouseAnnouncementAction } from '@/app/household/announcement-actions';

const hoursLabel = (hours: number) => (hours < 24 ? `${hours} hours` : hours === 24 ? '1 day' : `${hours / 24} days`);

/**
 * "Message the house" (NO-25), for owners and admins (the server checks the role): a short
 * message every member sees in the bell, pinned on wall tablets until it expires, with an
 * optional push to phones.
 */
export function HouseMessageCard({ householdId }: { householdId: string }) {
  const { toast } = useToast();
  const id = useId();
  const [message, setMessage] = useState('');
  const [hours, setHours] = useState<number>(HOUSE_ANNOUNCEMENT_DEFAULT_HOURS);
  const [push, setPush] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  useUnsavedInput(message.trim().length > 0 || saving);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (saving || !auth.currentUser) return;
    const checked = validateHouseAnnouncement({ message, hours, push });
    if (!checked.ok) {
      setError(checked.message);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const result = await postHouseAnnouncementAction({ idToken: await auth.currentUser.getIdToken(), householdId, ...checked.value });
      if (!result.ok) {
        setError(result.message);
        return;
      }
      setMessage('');
      toast({ title: 'Message sent to the house', description: `It stays up for ${hoursLabel(checked.value.hours)}${checked.value.push ? ' and was pushed to phones' : ''}.` });
    } catch {
      setError("Couldn't send. Try again.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card data-testid="house-message-card">
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><Megaphone aria-hidden className="h-5 w-5" /> Message the house</CardTitle>
        <CardDescription>Everyone sees it in their notifications, and wall tablets show it at the top until it expires.</CardDescription>
      </CardHeader>
      <CardContent>
        <form noValidate onSubmit={submit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor={`${id}-message`}>Message</Label>
            <Textarea
              id={`${id}-message`}
              value={message}
              maxLength={HOUSE_ANNOUNCEMENT_MAX_LENGTH}
              placeholder="Dinner at 6"
              onChange={(event) => { setMessage(event.target.value); setError(null); }}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? `${id}-error` : undefined}
            />
            <p className="text-xs text-muted-foreground">{message.trim().length}/{HOUSE_ANNOUNCEMENT_MAX_LENGTH}</p>
          </div>
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">Keep it up for</legend>
            <div className="flex flex-wrap gap-2">
              {HOUSE_ANNOUNCEMENT_HOURS.map((option) => (
                <Button key={option} type="button" size="sm" variant={hours === option ? 'default' : 'outline'} aria-pressed={hours === option} onClick={() => setHours(option)}>
                  {hoursLabel(option)}
                </Button>
              ))}
            </div>
          </fieldset>
          <div className="flex min-h-[var(--target-min)] items-center justify-between gap-4">
            <Label htmlFor={`${id}-push`}>Also send a push to phones</Label>
            <Switch id={`${id}-push`} checked={push} onCheckedChange={setPush} disabled={saving} />
          </div>
          {error && <p id={`${id}-error`} role="alert" className="text-sm text-destructive">{error}</p>}
          <Button type="submit" disabled={saving || !message.trim()} className="w-full">
            {saving && <Loader2 className="animate-spin" aria-hidden />}
            Send to the house
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
