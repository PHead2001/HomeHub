'use client';

import { useId, useState } from 'react';
import { doc, updateDoc } from 'firebase/firestore';
import { useAuth } from '@/hooks/use-auth';
import { useToast } from '@/hooks/use-toast';
import { db } from '@/lib/firebase';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { WEEK_START_OPTIONS, readWeekStartsOn, type WeekStartsOn } from '@/lib/chores/week-start';

// "Week starts on" (CA-16; HO-19's household settings reuse it): the household's first
// weekday for the Calendar's Week and Month views, the Chores leaderboard week and the
// member counts on Household. Stored on `households/{h}.weekStartsOn` (0 Sunday, 1 Monday;
// absent = Monday). Owners and admins change it (the household update rule allows this
// field, with a valid value, only for them); everyone else sees it read-only.

export function WeekStartSetting({ householdId, canEdit }: { householdId: string; canEdit: boolean }) {
  const { household } = useAuth();
  const { toast, toastError } = useToast();
  const id = useId();
  const stored = readWeekStartsOn(household?.weekStartsOn);
  const [saving, setSaving] = useState<WeekStartsOn | null>(null);
  const shown = saving ?? stored;

  const save = async (value: WeekStartsOn) => {
    if (!canEdit || saving !== null || value === stored) return;
    setSaving(value);
    try {
      await updateDoc(doc(db, 'households', householdId), { weekStartsOn: value, updatedAt: new Date().toISOString() });
      toast({ title: 'Week start saved', description: `Weeks now start on ${value === 0 ? 'Sunday' : 'Monday'}.` });
    } catch (error) {
      toastError(error, "Couldn't save the week start");
    } finally {
      setSaving(null);
    }
  };

  return (
    <Card data-testid="week-start-setting">
      <CardHeader>
        <CardTitle>Week starts on</CardTitle>
        <CardDescription>Used by the Calendar&apos;s week and month, the Chores leaderboard week and this week&apos;s counts.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        <Label id={`${id}-label`}>First day of the week</Label>
        {canEdit ? (
          <ToggleGroup
            type="single"
            value={String(shown)}
            onValueChange={(value) => { if (value) void save(readWeekStartsOn(Number(value))); }}
            aria-labelledby={`${id}-label`}
            className="justify-start"
          >
            {WEEK_START_OPTIONS.map((option) => (
              <ToggleGroupItem key={option.value} value={String(option.value)} disabled={saving !== null} className="min-h-[var(--target-min)] px-4 data-[state=on]:bg-primary data-[state=on]:text-primary-foreground">
                {option.label}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        ) : (
          <p className="font-semibold" aria-labelledby={`${id}-label`}>{shown === 0 ? 'Sunday' : 'Monday'}</p>
        )}
      </CardContent>
    </Card>
  );
}
