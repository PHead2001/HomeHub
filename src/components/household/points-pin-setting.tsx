'use client';

import { useId, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { useAuth } from '@/hooks/use-auth';
import { useToast } from '@/hooks/use-toast';
import { auth } from '@/lib/firebase-app';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { readPointsPinPolicy, type PointsPinPolicy } from '@/lib/devices/action-policy';
import { updatePointsPinAction } from '@/app/household/pin-actions';

// The household's points-PIN setting for wall tablets (WT-9d, WT-22, D-T10): whether
// completing, undoing or taking a chore on a tablet needs the person's PIN. Off (the
// default), Kids only (everyone with the Child role, kid profiles included) or
// Everyone. Feeding and medication never ask. Owners and admins (role) change it; the
// server enforces it on every tablet action.

const OPTIONS: Array<{ value: PointsPinPolicy; label: string; hint: string }> = [
  { value: 'off', label: 'Off', hint: 'A tap on your face is enough to tick a chore.' },
  { value: 'kids', label: 'Kids only', hint: 'Children type their PIN to tick, undo or take a chore.' },
  { value: 'everyone', label: 'Everyone', hint: 'Everyone types their PIN to tick, undo or take a chore.' },
];

export function PointsPinSetting({ householdId }: { householdId: string }) {
  const { household } = useAuth();
  const { toast, toastError } = useToast();
  const id = useId();
  const current = readPointsPinPolicy(household);
  const [saving, setSaving] = useState<PointsPinPolicy | null>(null);

  const choose = async (value: string) => {
    const next = value as PointsPinPolicy;
    if (next === current || saving || !auth.currentUser) return;
    setSaving(next);
    try {
      const result = await updatePointsPinAction({ idToken: await auth.currentUser.getIdToken(), householdId, pointsPin: next });
      if (!result.ok) {
        toast({ variant: 'destructive', title: "Couldn't change the points PIN", description: result.message });
        return;
      }
      toast({ title: 'Points PIN updated', description: OPTIONS.find(o => o.value === next)?.hint });
    } catch (error) {
      toastError(error, "Couldn't change the points PIN");
    } finally {
      setSaving(null);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Points PIN</CardTitle>
        <CardDescription>
          Whether ticking, undoing or taking a chore on a wall tablet needs the person&apos;s PIN. Feeding pets and giving doses never ask.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <RadioGroup value={saving ?? current} onValueChange={(value) => void choose(value)} aria-label="Points PIN" className="grid gap-3">
          {OPTIONS.map(option => (
            <div key={option.value} className="flex items-start gap-3">
              <RadioGroupItem id={`${id}-${option.value}`} value={option.value} disabled={saving !== null} className="mt-1" />
              <Label htmlFor={`${id}-${option.value}`} className="grid min-h-[var(--target-min)] cursor-pointer content-center gap-0.5 font-normal">
                <span className="flex items-center gap-2 font-medium">
                  {option.label}
                  {saving === option.value && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
                </span>
                <span className="text-sm text-muted-foreground">{option.hint}</span>
              </Label>
            </div>
          ))}
        </RadioGroup>
      </CardContent>
    </Card>
  );
}
