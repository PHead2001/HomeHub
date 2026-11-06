'use client';

import { useState } from 'react';
import { motion } from 'motion/react';
import { Check, Loader2, X } from 'lucide-react';
import { MemberAvatar } from '@/components/member-avatar';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useReducedMotion } from '@/hooks/use-reduced-motion';
import { SPRING_UI } from '@/lib/motion';
import type { MemberColor } from '@/lib/member-colors';
import type { HouseholdMember, HouseholdRole } from '@/lib/types';
import { memberFirstName, memberName, relativeTime, roleLabel, roleSummary } from './household-model';

/**
 * "Approve Jamie?" (D13/H25). Slides in at the top of Members when someone joins
 * with an invite. Approve assigns the chosen role through the normal role-change
 * path; Deny removes the request through the normal remove path. Each button is
 * rendered only when the viewer may perform it.
 */
export function PendingMemberBanner({
  member,
  color,
  roles,
  canDeny,
  onApprove,
  onDeny,
}: {
  member: HouseholdMember;
  color: MemberColor;
  /** Roles the viewer may assign; empty hides Approve. */
  roles: readonly HouseholdRole[];
  canDeny: boolean;
  onApprove: (member: HouseholdMember, role: HouseholdRole) => Promise<void>;
  onDeny: (member: HouseholdMember) => void;
}) {
  const reduced = useReducedMotion();
  const [role, setRole] = useState<HouseholdRole>(roles.includes('member') ? 'member' : roles[0] ?? 'member');
  const [busy, setBusy] = useState(false);
  const name = memberName(member);
  const first = memberFirstName(member);
  const roleFieldId = `approve-role-${member.uid}`;
  const asked = relativeTime(member.joinedAt);

  return (
    <motion.section
      layout={false}
      initial={reduced ? false : { opacity: 0, y: -12 }}
      animate={{ opacity: 1, y: 0 }}
      exit={reduced ? undefined : { opacity: 0, y: -8 }}
      transition={reduced ? { duration: 0 } : SPRING_UI}
      aria-labelledby={`approve-${member.uid}-title`}
      className="rounded-xl border border-warning/50 bg-warning/10 p-4 shadow-raised"
      data-pending-banner={member.uid}
    >
      <div className="flex flex-col gap-4 md:flex-row md:items-center">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <MemberAvatar uid={member.uid} name={name} photoUrl={member.avatarUrl} color={color} ring size="lg" decorative />
          <div className="min-w-0">
            <h3 id={`approve-${member.uid}-title`} className="break-words font-semibold">Approve {first}?</h3>
            <p className="break-words text-sm text-muted-foreground">
              {name !== first ? `${name} · ` : ''}{member.email} asked to join{asked ? ` ${asked}` : ''}. They can&apos;t see anything until you choose a role.
            </p>
          </div>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
          {roles.length > 0 && (
            <div className="grid gap-1">
              <Label htmlFor={roleFieldId} className="text-xs text-muted-foreground">Role</Label>
              <Select value={role} onValueChange={(value) => setRole(value as HouseholdRole)} disabled={busy}>
                <SelectTrigger id={roleFieldId} className="w-full sm:w-36" aria-describedby={`${roleFieldId}-hint`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {roles.map((option) => (
                    <SelectItem key={option} value={option}>{roleLabel(option)}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <span id={`${roleFieldId}-hint`} className="sr-only">{roleSummary(role)}</span>
            </div>
          )}
          <div className="flex gap-2">
            {roles.length > 0 && (
              <Button
                className="flex-1 sm:flex-none"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  try {
                    await onApprove(member, role);
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Check className="mr-2 h-4 w-4" />}
                Approve
              </Button>
            )}
            {canDeny && (
              <Button variant="outline" className="flex-1 sm:flex-none" disabled={busy} onClick={() => onDeny(member)}>
                <X className="mr-2 h-4 w-4" />
                Deny
              </Button>
            )}
          </div>
        </div>
      </div>
    </motion.section>
  );
}
