'use client';

import { useState } from 'react';
import { Cake, Check, Loader2 } from 'lucide-react';
import { useAuth } from '@/hooks/use-auth';
import { useToast } from '@/hooks/use-toast';
import { auth } from '@/lib/firebase-app';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { setMemberColorAction, setMyBirthdayAction } from '@/app/household/actions';
import { memberColorFromIndex, type MemberColorIndex } from '@/lib/member-colors';
import { MEMBER_COLOR_COUNT } from '@/lib/theme/tokens';
import { parseBirthday } from '@/lib/profile/member-extras';
import { cn } from '@/lib/utils';

const COLOR_NAMES = ['Teal', 'Sky', 'Blue', 'Violet', 'Pink', 'Coral', 'Amber', 'Lime'] as const;
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/**
 * PR-24: choose your member colour. Stored on your membership record by the server
 * (`setMemberColorAction`), so Chores, the calendar and Household show it; when two
 * people pick the same colour, the one who joined first keeps it and an owner or
 * admin can change the other's.
 */
export function MemberColorPicker() {
  const { currentUser, currentMember, household } = useAuth();
  const { toast } = useToast();
  const [saving, setSaving] = useState<number | 'auto' | null>(null);
  if (!currentUser || !household || !currentMember || currentMember.status !== 'active') return null;
  const chosen = typeof currentMember.color === 'number' ? currentMember.color : null;

  const choose = async (color: number | null) => {
    const user = auth.currentUser;
    if (!user) return;
    setSaving(color ?? 'auto');
    try {
      const result = await setMemberColorAction({ idToken: await user.getIdToken(), householdId: household.id, color });
      if (!result.ok) toast({ variant: 'destructive', title: 'Could not change your colour', description: result.message });
    } catch {
      toast({ variant: 'destructive', title: 'Could not change your colour', description: 'We could not reach HomeHub. Try again.' });
    } finally {
      setSaving(null);
    }
  };

  return (
    <div className="space-y-2" data-testid="member-color-picker">
      <p id="member-color-label" className="text-sm font-medium">Your colour</p>
      <div role="radiogroup" aria-labelledby="member-color-label" className="flex flex-wrap gap-2">
        <button
          type="button"
          role="radio"
          aria-checked={chosen === null}
          disabled={saving !== null}
          onClick={() => void choose(null)}
          className={cn('touch-target min-h-11 rounded-full border px-3 text-sm', chosen === null && 'border-primary bg-primary/10')}
        >
          {saving === 'auto' ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : 'Automatic'}
        </button>
        {Array.from({ length: MEMBER_COLOR_COUNT }, (_, i) => (i + 1) as MemberColorIndex).map((index) => {
          const color = memberColorFromIndex(index);
          const selected = chosen === index;
          return (
            <button
              key={index}
              type="button"
              role="radio"
              aria-checked={selected}
              aria-label={COLOR_NAMES[index - 1]}
              disabled={saving !== null}
              onClick={() => void choose(index)}
              className={cn('touch-target flex h-11 w-11 items-center justify-center rounded-full ring-offset-2 ring-offset-background', color.classes.bg, selected && 'ring-2 ring-foreground')}
            >
              {saving === index ? <Loader2 className="h-4 w-4 animate-spin text-member-foreground" aria-hidden /> : selected ? <Check className="h-4 w-4 text-member-foreground" aria-hidden /> : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/**
 * PR-25: an optional birthday (month and day only, no year), typed by you and shown
 * to your household as "Happy birthday" on the dashboard that day. Google's birthday
 * is never collected.
 */
export function BirthdayField() {
  const { currentUser, currentMember, household } = useAuth();
  const { toast } = useToast();
  const stored = parseBirthday(currentMember?.birthday ?? null) ?? null;
  const [month, setMonth] = useState<string>(stored ? String(stored.month) : '');
  const [day, setDay] = useState<string>(stored ? String(stored.day) : '');
  const [saving, setSaving] = useState(false);
  if (!currentUser || !household || !currentMember || currentMember.status !== 'active') return null;

  const days = month ? DAYS_IN_MONTH[Number(month) - 1] : 31;
  const candidate = month && day ? parseBirthday({ month: Number(month), day: Number(day) }) : undefined;
  const changed = candidate ? !stored || stored.month !== candidate.month || stored.day !== candidate.day : false;

  const save = async (birthday: { month: number; day: number } | null) => {
    const user = auth.currentUser;
    if (!user) return;
    setSaving(true);
    try {
      const result = await setMyBirthdayAction({ idToken: await user.getIdToken(), householdId: household.id, birthday });
      if (!result.ok) {
        toast({ variant: 'destructive', title: 'Could not save your birthday', description: result.message });
        return;
      }
      if (!birthday) {
        setMonth('');
        setDay('');
      }
      toast({ title: birthday ? 'Birthday saved' : 'Birthday removed', description: birthday ? 'Your household will see a birthday greeting that day.' : 'Your household no longer sees it.' });
    } catch {
      toast({ variant: 'destructive', title: 'Could not save your birthday', description: 'We could not reach HomeHub. Try again.' });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-2" data-testid="birthday-field">
      <p className="flex items-center gap-2 text-sm font-medium"><Cake className="h-4 w-4" aria-hidden /> Birthday <span className="font-normal text-muted-foreground">(optional)</span></p>
      <p className="text-xs text-muted-foreground">Month and day only. Your household sees a birthday greeting on the day.</p>
      <div className="flex flex-wrap items-end gap-2">
        <div className="space-y-1">
          <Label htmlFor="birthday-month" className="sr-only">Month</Label>
          <Select value={month} onValueChange={(value) => { setMonth(value); if (day && Number(day) > DAYS_IN_MONTH[Number(value) - 1]) setDay(''); }}>
            <SelectTrigger id="birthday-month" className="min-h-12 w-40"><SelectValue placeholder="Month" /></SelectTrigger>
            <SelectContent>{MONTHS.map((name, i) => <SelectItem key={name} value={String(i + 1)}>{name}</SelectItem>)}</SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="birthday-day" className="sr-only">Day</Label>
          <Select value={day} onValueChange={setDay}>
            <SelectTrigger id="birthday-day" className="min-h-12 w-24"><SelectValue placeholder="Day" /></SelectTrigger>
            <SelectContent>{Array.from({ length: days }, (_, i) => <SelectItem key={i + 1} value={String(i + 1)}>{i + 1}</SelectItem>)}</SelectContent>
          </Select>
        </div>
        <Button type="button" variant="outline" disabled={saving || !changed || !candidate} onClick={() => candidate && void save(candidate)}>
          {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />}
          Save birthday
        </Button>
        {stored && (
          <Button type="button" variant="ghost" disabled={saving} onClick={() => void save(null)}>Remove</Button>
        )}
      </div>
    </div>
  );
}
