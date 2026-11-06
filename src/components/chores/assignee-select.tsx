'use client';

import type { User as HomeHubUser } from '@/lib/types';
import { MemberAvatar } from '@/components/member-avatar';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

export const memberName = (user: Pick<HomeHubUser, 'displayName' | 'email'>) => user.displayName || user.email;

/** Assignee picker: each member with their avatar. */
export function AssigneeSelect({
  id,
  users,
  value,
  onChange,
  disabled,
  invalid,
  describedBy,
}: {
  id: string;
  users: HomeHubUser[];
  value: string;
  onChange: (email: string) => void;
  disabled?: boolean;
  invalid?: boolean;
  describedBy?: string;
}) {
  return (
    <Select value={value} onValueChange={onChange} disabled={disabled}>
      <SelectTrigger id={id} aria-invalid={invalid || undefined} aria-describedby={describedBy}>
        <SelectValue placeholder="Choose a member" />
      </SelectTrigger>
      <SelectContent>
        {users.map(user => (
          <SelectItem key={user.email} value={user.email}>
            <span className="flex items-center gap-2">
              <MemberAvatar uid={user.uid || user.email} name={memberName(user)} photoUrl={user.avatarUrl} size="sm" decorative />
              {memberName(user)}
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
