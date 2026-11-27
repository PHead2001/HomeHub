'use client';

import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { GUEST_PASS_HOURS, guestPassLabel, type GuestPassHours } from '@/lib/guest-pass';

export type InvitePassChoice = GuestPassHours | 'none';

/**
 * "Guest pass" for a new invite code (HO-14): 4 hours, 1 day or 1 week. The person
 * joins with their own account and waits for approval as usual; approving them as Guest
 * starts the pass, and access ends on its own when it runs out.
 */
export function InvitePassSelect({
  value,
  onChange,
  disabled,
}: {
  value: InvitePassChoice;
  onChange: (value: InvitePassChoice) => void;
  disabled?: boolean;
}) {
  return (
    <div className="grid gap-1 sm:max-w-xs">
      <Label htmlFor="invite-guest-pass">Guest pass (optional)</Label>
      <Select value={String(value)} onValueChange={(next) => onChange(next === 'none' ? 'none' : Number(next) as GuestPassHours)} disabled={disabled}>
        <SelectTrigger id="invite-guest-pass" aria-describedby="invite-guest-pass-hint">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="none">No, a regular invite</SelectItem>
          {GUEST_PASS_HOURS.map((hours) => (
            <SelectItem key={hours} value={String(hours)}>Guest for {guestPassLabel(hours)}</SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p id="invite-guest-pass-hint" className="text-xs text-muted-foreground">
        {value === 'none'
          ? 'For a babysitter or a visitor: access that ends on its own.'
          : `They join as a Guest when you approve them, and lose access ${guestPassLabel(value)} later.`}
      </p>
    </div>
  );
}
