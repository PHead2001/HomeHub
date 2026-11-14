'use client';

import { assignablePeople, publicDisplayName, type HouseholdPerson } from '@/lib/member-directory';
import { MemberAvatar } from '@/components/member-avatar';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

/** A member's name as housemates see it: never their email address. */
export const memberName = (user: Pick<HouseholdPerson, 'displayName'>) => publicDisplayName(user.displayName);

/** Assignee picker: each member with their avatar. Values are member uids. */
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
  users: HouseholdPerson[];
  value: string;
  onChange: (uid: string) => void;
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
        {/* Kid profiles are not assignees yet (HO-15d); the current value always stays listed. */}
        {assignablePeople(users, value).map(user => (
          <SelectItem key={user.uid} value={user.uid}>
            <span className="flex items-center gap-2">
              <MemberAvatar uid={user.uid} name={memberName(user)} photoUrl={user.avatarUrl} size="sm" decorative />
              {memberName(user)}
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
