'use client';

import { useId, useState, type FormEvent } from 'react';
import { Loader2 } from 'lucide-react';
import { useAuth } from '@/hooks/use-auth';
import { useToast } from '@/hooks/use-toast';
import { useUnsavedInput } from '@/hooks/use-shell-busy';
import { auth } from '@/lib/firebase-app';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { describeQuietHours, readQuietHours, validateQuietHours } from '@/lib/devices/quiet-hours';
import { updateQuietHoursAction } from '@/app/household/quiet-hours-actions';

// Household quiet hours (docs/modules/devices/README.md, "Night dimming"; D-T1, JC-20):
// wall tablets dim their screen during them, in the household's time zone. Owners and
// admins (role) change them; the server validates and stores them. Push notifications are
// not muted by them.

export function QuietHoursSetting({ householdId }: { householdId: string }) {
  const { household } = useAuth();
  const { toast } = useToast();
  const id = useId();
  const current = readQuietHours(household?.quietHours);
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [start, setStart] = useState<string | null>(null);
  const [end, setEnd] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const on = enabled ?? Boolean(current);
  const startValue = start ?? current?.start ?? '22:00';
  const endValue = end ?? current?.end ?? '07:00';
  const next = on ? { start: startValue, end: endValue } : null;
  const dirty = JSON.stringify(next) !== JSON.stringify(current);
  useUnsavedInput(dirty);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!dirty || saving || !auth.currentUser) return;
    const checked = validateQuietHours(next);
    if (!checked.ok) {
      setError(checked.message);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const result = await updateQuietHoursAction({ idToken: await auth.currentUser.getIdToken(), householdId, quietHours: checked.value });
      if (!result.ok) {
        setError(result.message);
        return;
      }
      setEnabled(null);
      setStart(null);
      setEnd(null);
      toast({ title: 'Quiet hours saved', description: `Wall tablets dim: ${describeQuietHours(result.data.quietHours)}.` });
    } catch {
      setError("Couldn't save. Try again.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Quiet hours</CardTitle>
        <CardDescription>Wall tablets dim their screen during these hours, in the household&apos;s time zone. Now: {describeQuietHours(current)}.</CardDescription>
      </CardHeader>
      <CardContent>
        <form noValidate onSubmit={submit} className="space-y-4" data-testid="quiet-hours-form">
          <div className="flex min-h-[var(--target-min)] items-center justify-between gap-4">
            <Label htmlFor={`${id}-on`}>Dim wall tablets at night</Label>
            <Switch id={`${id}-on`} checked={on} onCheckedChange={(value) => { setEnabled(value); setError(null); }} disabled={saving} />
          </div>
          {on && (
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1">
                <Label htmlFor={`${id}-start`}>From</Label>
                <Input id={`${id}-start`} type="time" value={startValue} onChange={(e) => { setStart(e.target.value); setError(null); }} disabled={saving} aria-invalid={Boolean(error)} aria-describedby={error ? `${id}-error` : undefined} />
              </div>
              <div className="space-y-1">
                <Label htmlFor={`${id}-end`}>Until</Label>
                <Input id={`${id}-end`} type="time" value={endValue} onChange={(e) => { setEnd(e.target.value); setError(null); }} disabled={saving} aria-invalid={Boolean(error)} aria-describedby={error ? `${id}-error` : undefined} />
              </div>
            </div>
          )}
          <p id={`${id}-error`} role="alert" className="min-h-5 text-sm text-destructive">{error}</p>
          <Button type="submit" disabled={!dirty || saving}>
            {saving && <Loader2 aria-hidden className="mr-2 h-4 w-4 animate-spin" />}
            Save quiet hours
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
