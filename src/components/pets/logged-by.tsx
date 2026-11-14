import { MemberAvatar } from '@/components/member-avatar';
import type { LoggedBy as LoggedByFields } from '@/lib/pets/types';
import { cn } from '@/lib/utils';

/** The tablet a device-written entry came from ("Kitchen tablet"), or null (PE-17c). */
export const loggedOnDevice = (entry: LoggedByFields): string | null => {
  const name = entry.deviceAttribution && typeof entry.deviceAttribution.deviceName === 'string' ? entry.deviceAttribution.deviceName.trim() : '';
  return name ? name.slice(0, 40) : null;
};

/**
 * "by Alex" with the member's avatar, and "by Alex on Kitchen tablet" for an entry a wall
 * tablet wrote for the person chosen there (PE-17c); nothing for entries without an author.
 */
export function LoggedBy({ entry, className }: { entry: LoggedByFields; className?: string }) {
  const name = entry.loggedByName?.trim();
  if (!name) return null;
  const device = loggedOnDevice(entry);
  return (
    <span className={cn('inline-flex items-center gap-1.5 text-xs text-muted-foreground', className)}>
      <MemberAvatar uid={entry.loggedByUid || name} name={name} size="sm" decorative />
      <span>by {name}{device ? ` on ${device}` : ''}</span>
    </span>
  );
}
