'use client';

import { useMemo, useState } from 'react';
import { Globe, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useToast } from '@/hooks/use-toast';
import { auth } from '@/lib/firebase';
import { timeZoneLabel, timeZoneOptions } from '@/lib/time-zones';
import { updateHouseholdTimeZoneAction } from '@/app/household/actions';

/** The zone households without one use (server upkeep's default, D-6). */
const DEFAULT_ZONE = 'America/Chicago';

/**
 * Household settings, time zone (HO-19, D-6): reminders, "today", midnight and repeating
 * chores all follow it. Captured from the creator's browser at creation; owners and admins
 * change it here (server action, validated and logged). Everyone else sees it read-only.
 */
export function TimeZoneSetting({
  householdId,
  timeZone,
  canEdit,
}: {
  householdId: string;
  timeZone: string | null | undefined;
  canEdit: boolean;
}) {
  const { toast, toastError } = useToast();
  const current = timeZone || DEFAULT_ZONE;
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const selected = draft ?? current;
  // Labels are built once per stored zone (about 400 of them).
  const options = useMemo(() => timeZoneOptions(current).map((zone) => ({ zone, label: timeZoneLabel(zone) })), [current]);
  const deviceZone = typeof Intl !== 'undefined' ? Intl.DateTimeFormat().resolvedOptions().timeZone : '';

  const save = async (zone: string) => {
    const user = auth.currentUser;
    if (!user || saving) return;
    setSaving(true);
    try {
      const result = await updateHouseholdTimeZoneAction({ idToken: await user.getIdToken(), householdId, timeZone: zone });
      if (!result.ok) {
        toast({ variant: 'destructive', title: 'Could not change the time zone', description: result.message });
        return;
      }
      setDraft(null);
      toast({ title: 'Time zone saved', description: `Reminders and "today" now follow ${timeZoneLabel(result.data.timeZone)}.` });
    } catch (error) {
      toastError(error, 'Could not change the time zone');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><Globe aria-hidden className="h-5 w-5" /> Time zone</CardTitle>
        <CardDescription>
          Reminders, &quot;today&quot; and repeating chores follow the household&apos;s time zone for everyone, wherever they are.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {canEdit ? (
          <form
            className="grid gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (selected !== current) void save(selected);
            }}
          >
            <Label htmlFor="household-time-zone">Household time zone</Label>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-start">
              <Select value={selected} onValueChange={setDraft} disabled={saving}>
                <SelectTrigger id="household-time-zone" className="sm:max-w-sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="max-h-80">
                  {options.map(({ zone, label }) => (
                    <SelectItem key={zone} value={zone}>{label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button type="submit" disabled={saving || selected === current}>
                {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                {/* Its own name: Overview also has the household name's Save. */}
                Save time zone
              </Button>
            </div>
            {deviceZone && deviceZone !== current && (
              <Button type="button" variant="link" className="justify-start px-0" disabled={saving} onClick={() => setDraft(deviceZone)}>
                Use this device&apos;s time zone ({timeZoneLabel(deviceZone)})
              </Button>
            )}
          </form>
        ) : (
          <p className="font-semibold" data-testid="household-time-zone">{timeZoneLabel(current)}</p>
        )}
      </CardContent>
    </Card>
  );
}
