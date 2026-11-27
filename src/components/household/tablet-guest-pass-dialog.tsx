'use client';

import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { FieldError, fieldErrorProps } from '@/components/field-error';
import { useToast } from '@/hooks/use-toast';
import { auth } from '@/lib/firebase-app';
import { GUEST_NAME_MAX, GUEST_PASS_HOURS, guestPassLabel, readGuestName, type GuestPassHours } from '@/lib/guest-pass';
import { createTabletGuestPassAction } from '@/app/household/guest-actions';

/**
 * "Add a tablet guest pass" (HO-24, WT-21): a temporary face on the household's wall
 * tablets for a babysitter or a dog walker, with no account. It may feed pets and/or
 * tick chores (face level, with Undo) and disappears from "Who's here?" when it ends.
 * Owners and admins only (the server checks again).
 */
export function TabletGuestPassDialog({
  open,
  householdId,
  onOpenChange,
}: {
  open: boolean;
  householdId: string;
  onOpenChange: (open: boolean) => void;
}) {
  const { toast, toastError } = useToast();
  const [name, setName] = useState('');
  const [hours, setHours] = useState<GuestPassHours>(4);
  const [feedPets, setFeedPets] = useState(true);
  const [tickChores, setTickChores] = useState(true);
  const [submitted, setSubmitted] = useState(false);
  const [saving, setSaving] = useState(false);
  const nameError = submitted && !readGuestName(name) ? `Give the pass a name (1 to ${GUEST_NAME_MAX} characters), for example "Babysitter".` : null;
  const abilityError = submitted && !feedPets && !tickChores ? 'Choose at least one thing they may do.' : null;

  const save = async () => {
    setSubmitted(true);
    if (!readGuestName(name) || (!feedPets && !tickChores) || saving) return;
    const user = auth.currentUser;
    if (!user) return;
    setSaving(true);
    try {
      const result = await createTabletGuestPassAction({ idToken: await user.getIdToken(), householdId, name, hours, feedPets, tickChores });
      if (!result.ok) {
        toast({ variant: 'destructive', title: "Couldn't add the guest pass", description: result.message });
        return;
      }
      toast({ title: 'Guest pass added', description: `${result.data.name} can use the wall tablets for ${guestPassLabel(hours)}.` });
      setName('');
      setSubmitted(false);
      onOpenChange(false);
    } catch (error) {
      toastError(error, "Couldn't add the guest pass");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!saving) onOpenChange(next); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Add a tablet guest pass</DialogTitle>
          <DialogDescription>
            A face on the wall tablets for a babysitter or a dog walker, with no account. It disappears when the pass ends, and what they do is logged under its name.
          </DialogDescription>
        </DialogHeader>
        <form
          noValidate
          className="grid gap-4"
          onSubmit={(event) => { event.preventDefault(); void save(); }}
        >
          <div className="grid gap-1.5">
            <Label htmlFor="guest-pass-name">Name on the tablet</Label>
            <Input
              {...fieldErrorProps('guest-pass-name', nameError)}
              value={name}
              maxLength={GUEST_NAME_MAX}
              autoComplete="off"
              placeholder="Babysitter"
              onChange={(event) => setName(event.target.value)}
            />
            <FieldError id="guest-pass-name">{nameError}</FieldError>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="guest-pass-length">For</Label>
            <Select value={String(hours)} onValueChange={(value) => setHours(Number(value) as GuestPassHours)}>
              <SelectTrigger id="guest-pass-length"><SelectValue /></SelectTrigger>
              <SelectContent>
                {GUEST_PASS_HOURS.map((value) => <SelectItem key={value} value={String(value)}>{guestPassLabel(value)}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <fieldset className="grid gap-2" aria-describedby={abilityError ? 'guest-pass-abilities-error' : undefined}>
            <legend className="text-sm font-medium">They may</legend>
            <label className="flex min-h-[var(--target-min)] items-center gap-3 text-sm">
              <Checkbox checked={feedPets} onCheckedChange={(value) => setFeedPets(value === true)} /> Feed pets and log care
            </label>
            <label className="flex min-h-[var(--target-min)] items-center gap-3 text-sm">
              <Checkbox checked={tickChores} onCheckedChange={(value) => setTickChores(value === true)} /> Tick chores done
            </label>
            {abilityError && <p id="guest-pass-abilities-error" className="text-sm text-destructive">{abilityError}</p>}
          </fieldset>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={saving} onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={saving}>
              {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Add guest pass
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
