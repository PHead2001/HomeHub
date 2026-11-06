'use client';

import { Crown, MoreHorizontal, SlidersHorizontal, UserMinus } from 'lucide-react';
import { MemberAvatar } from '@/components/member-avatar';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import type { MemberColor } from '@/lib/member-colors';
import type { HouseholdMember, HouseholdRole } from '@/lib/types';
import { cn } from '@/lib/utils';
import { customizedPermissions, memberName, relativeTime, roleLabel, type MemberChoreStats } from './household-model';

export type MemberActions = {
  /** Roles this actor may assign to the member (empty: no role control). */
  roles: readonly HouseholdRole[];
  canCustomize: boolean;
  canTransfer: boolean;
  canRemove: boolean;
};

export function memberActionCount(actions: MemberActions): number {
  return (actions.roles.length > 0 ? 1 : 0) + Number(actions.canCustomize) + Number(actions.canTransfer) + Number(actions.canRemove);
}

/**
 * One household member (D13): avatar in the member color, name, role chip and
 * simple stats. Rare actions live in a "⋯" menu that only lists what the viewer
 * is allowed to do; members with no available actions get no menu at all.
 */
export function MemberCard({
  member,
  color,
  isSelf,
  stats,
  actions,
  onRoleChange,
  onCustomize,
  onTransfer,
  onRemove,
}: {
  member: HouseholdMember;
  color: MemberColor;
  isSelf: boolean;
  stats?: MemberChoreStats;
  actions: MemberActions;
  onRoleChange: (member: HouseholdMember, role: HouseholdRole) => void;
  onCustomize: (member: HouseholdMember) => void;
  onTransfer: (member: HouseholdMember) => void;
  onRemove: (member: HouseholdMember) => void;
}) {
  const name = memberName(member);
  const customized = customizedPermissions(member.role, member.permissions).length;
  const joined = relativeTime(member.joinedAt);
  const hasMenu = memberActionCount(actions) > 0;

  return (
    <Card className="overflow-hidden" data-member-card={member.uid}>
      {/* Thin stripe in the member's color ties the card to their avatar everywhere else. */}
      <div aria-hidden className={cn('h-1 w-full', color.classes.bg)} />
      <CardContent className="flex items-start gap-3 p-4">
        <MemberAvatar uid={member.uid} name={name} photoUrl={member.avatarUrl} color={color} ring size="lg" decorative />
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <h3 className="min-w-0 break-words font-semibold leading-tight">{name}</h3>
            {isSelf && <span className="text-xs text-muted-foreground">(you)</span>}
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <span className={cn('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold', color.classes.softChip)}>
              {member.role === 'owner' && <Crown aria-hidden className="h-3 w-3" />}
              {roleLabel(member.role)}
            </span>
            {customized > 0 && (
              <span className="rounded-full border px-2 py-0.5 text-xs text-muted-foreground">
                {customized} custom {customized === 1 ? 'permission' : 'permissions'}
              </span>
            )}
          </div>
          {member.displayName && <p className="truncate text-sm text-muted-foreground">{member.email}</p>}
          <p className="text-xs text-muted-foreground">
            {joined && <>Joined {joined}</>}
            {stats && (
              <>
                {joined && ' · '}
                {stats.doneThisWeek} {stats.doneThisWeek === 1 ? 'chore' : 'chores'} done this week · {stats.open} open
              </>
            )}
          </p>
        </div>
        {hasMenu && (
          // Not modal: the confirm dialog opened from an item must not inherit a locked body.
          <DropdownMenu modal={false}>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="shrink-0" aria-label={`Actions for ${name}`}>
                <MoreHorizontal className="h-5 w-5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              {actions.roles.length > 0 && (
                <>
                  <DropdownMenuLabel>Role</DropdownMenuLabel>
                  <DropdownMenuRadioGroup
                    value={member.role}
                    onValueChange={(value) => {
                      if (value !== member.role) onRoleChange(member, value as HouseholdRole);
                    }}
                  >
                    {actions.roles.map((role) => (
                      <DropdownMenuRadioItem key={role} value={role}>{roleLabel(role)}</DropdownMenuRadioItem>
                    ))}
                  </DropdownMenuRadioGroup>
                </>
              )}
              {(actions.canCustomize || actions.canTransfer) && (
                <>
                  {actions.roles.length > 0 && <DropdownMenuSeparator />}
                  {actions.canCustomize && (
                    <DropdownMenuItem onSelect={() => onCustomize(member)}>
                      <SlidersHorizontal className="mr-2 h-4 w-4" /> Customize permissions
                    </DropdownMenuItem>
                  )}
                  {actions.canTransfer && (
                    <DropdownMenuItem onSelect={() => onTransfer(member)}>
                      <Crown className="mr-2 h-4 w-4" /> Make owner
                    </DropdownMenuItem>
                  )}
                </>
              )}
              {actions.canRemove && (
                <>
                  {(actions.roles.length > 0 || actions.canCustomize || actions.canTransfer) && <DropdownMenuSeparator />}
                  <DropdownMenuItem onSelect={() => onRemove(member)} className="text-destructive focus:text-destructive">
                    <UserMinus className="mr-2 h-4 w-4" /> Remove from household
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </CardContent>
    </Card>
  );
}
