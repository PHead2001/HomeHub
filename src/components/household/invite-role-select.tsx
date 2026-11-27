'use client';

import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import type { HouseholdRole } from '@/lib/types';
import { roleLabel, roleSummary } from './household-model';

export type InviteRoleChoice = HouseholdRole | 'none';

/**
 * "Suggested role" for a new invite code (HO-16): only roles below the creator's own
 * (the server checks again). It pre-selects the role on the approval banner; the person
 * still waits for an owner or admin to approve them.
 */
export function InviteRoleSelect({
  value,
  roles,
  onChange,
  disabled,
}: {
  value: InviteRoleChoice;
  roles: readonly HouseholdRole[];
  onChange: (value: InviteRoleChoice) => void;
  disabled?: boolean;
}) {
  if (roles.length === 0) return null;
  return (
    <div className="grid gap-1 sm:max-w-xs">
      <Label htmlFor="invite-suggested-role">Suggested role (optional)</Label>
      <Select value={value} onValueChange={(next) => onChange(next as InviteRoleChoice)} disabled={disabled}>
        <SelectTrigger id="invite-suggested-role" aria-describedby="invite-suggested-role-hint">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="none">No suggestion</SelectItem>
          {roles.map((role) => (
            <SelectItem key={role} value={role}>{roleLabel(role)}</SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p id="invite-suggested-role-hint" className="text-xs text-muted-foreground">
        {value === 'none' ? 'Whoever approves picks the role.' : `${roleSummary(value)} Whoever approves can still change it.`}
      </p>
    </div>
  );
}
