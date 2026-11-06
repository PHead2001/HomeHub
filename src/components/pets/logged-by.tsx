import { MemberAvatar } from '@/components/member-avatar';
import type { LoggedBy as LoggedByFields } from '@/lib/pets/types';
import { cn } from '@/lib/utils';

/** "by Alex" with the member's avatar; renders nothing for entries without an author. */
export function LoggedBy({ entry, className }: { entry: LoggedByFields; className?: string }) {
  const name = entry.loggedByName?.trim();
  if (!name) return null;
  return (
    <span className={cn('inline-flex items-center gap-1.5 text-xs text-muted-foreground', className)}>
      <MemberAvatar uid={entry.loggedByUid || name} name={name} size="sm" decorative />
      <span>by {name}</span>
    </span>
  );
}
