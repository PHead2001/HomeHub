'use client';

import { ArrowDown, ArrowUp } from 'lucide-react';
import type { HouseholdPerson } from '@/lib/member-directory';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { MemberAvatar } from '@/components/member-avatar';
import { MAX_ROTATION, moveRotationMember, toggleRotationMember } from '@/lib/chores/rotation';
import { memberName } from './assignee-select';

/**
 * The rotation editor (CH-28): tick who takes turns, then set the order. The
 * first person in the list does the next occurrence. Rows and the order buttons
 * are 48 px on touch screens (D-2).
 */
export function RotationFields({
  idPrefix,
  users,
  value,
  onChange,
  invalid,
  describedBy,
}: {
  idPrefix: string;
  users: HouseholdPerson[];
  value: string[];
  onChange: (next: string[]) => void;
  invalid?: boolean;
  describedBy?: string;
}) {
  const byUid = new Map(users.map(user => [user.uid, user]));
  const ordered = value.filter(uid => byUid.has(uid));
  const others = users.filter(user => !value.includes(user.uid));
  return (
    <div className="space-y-3" aria-invalid={invalid || undefined} aria-describedby={describedBy} data-testid={`${idPrefix}-rotation`}>
      {ordered.length > 0 && (
        <ol className="space-y-1" aria-label="Turn order">
          {ordered.map((uid, index) => {
            const user = byUid.get(uid)!;
            const name = memberName(user);
            return (
              <li key={uid} className="flex min-h-[var(--target-min)] items-center gap-2 rounded-md border px-2">
                <span className="w-5 text-right text-sm tabular-nums text-muted-foreground">{index + 1}.</span>
                <Checkbox id={`${idPrefix}-rotation-${uid}`} checked onCheckedChange={() => onChange(toggleRotationMember(value, uid))} aria-label={`Remove ${name} from the turns`} />
                <MemberAvatar uid={uid} name={name} photoUrl={user.avatarUrl} size="sm" decorative />
                <Label htmlFor={`${idPrefix}-rotation-${uid}`} className="min-w-0 flex-1 truncate font-normal">{name}</Label>
                <Button type="button" variant="ghost" size="icon" disabled={index === 0} aria-label={`Move ${name} earlier`} onClick={() => onChange(moveRotationMember(ordered, index, -1))}>
                  <ArrowUp className="h-4 w-4" />
                </Button>
                <Button type="button" variant="ghost" size="icon" disabled={index === ordered.length - 1} aria-label={`Move ${name} later`} onClick={() => onChange(moveRotationMember(ordered, index, 1))}>
                  <ArrowDown className="h-4 w-4" />
                </Button>
              </li>
            );
          })}
        </ol>
      )}
      {others.length > 0 && ordered.length < MAX_ROTATION && (
        <div className="grid gap-1 sm:grid-cols-2">
          {others.map(user => {
            const name = memberName(user);
            return (
              <div key={user.uid} className="flex min-h-[var(--target-min)] items-center gap-2 px-2">
                <Checkbox id={`${idPrefix}-rotation-${user.uid}`} checked={false} onCheckedChange={() => onChange(toggleRotationMember(value, user.uid))} />
                <Label htmlFor={`${idPrefix}-rotation-${user.uid}`} className="min-w-0 flex-1 truncate font-normal">{name}</Label>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
