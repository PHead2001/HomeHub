/**
 * Presentation helpers for the notification bell and center (H11): date groups
 * and plain-language source labels. Internal `sourceType` values and expiry stamps
 * are never shown to people.
 */
import { startOfLocalDay } from './dates';

export type NotificationGroupId = 'today' | 'week' | 'earlier';

export const NOTIFICATION_GROUP_LABELS: Record<NotificationGroupId, string> = {
  today: 'Today',
  week: 'This week',
  earlier: 'Earlier',
};

export function notificationGroupFor(createdAt: Date, now: Date): NotificationGroupId {
  const today = startOfLocalDay(now).getTime();
  const created = createdAt.getTime();
  if (created >= today) return 'today';
  if (created >= today - 6 * 86_400_000) return 'week';
  return 'earlier';
}

/** Groups items (already sorted newest first) into Today / This week / Earlier, skipping empty groups. */
export function groupNotifications<T extends { createdAt: Date }>(items: T[], now: Date): Array<{ id: NotificationGroupId; label: string; items: T[] }> {
  const groups: Record<NotificationGroupId, T[]> = { today: [], week: [], earlier: [] };
  items.forEach((item) => groups[notificationGroupFor(item.createdAt, now)].push(item));
  return (Object.keys(groups) as NotificationGroupId[])
    .filter((id) => groups[id].length > 0)
    .map((id) => ({ id, label: NOTIFICATION_GROUP_LABELS[id], items: groups[id] }));
}

const SOURCE_LABELS: Record<string, string> = {
  'chore-assignment': 'Chore assignment',
  chore_assignment: 'Chore assignment',
  chore_reminder: 'Chore reminder',
  'chore-reminder': 'Chore reminder',
  maintenance_asset_schedule: 'Home maintenance',
  maintenance_asset_warranty: 'Warranty',
  maintenance_vehicle_service: 'Vehicle service',
  maintenance_vehicle_registration: 'Vehicle registration',
  maintenance_vehicle_inspection: 'Vehicle inspection',
  chore: 'Chores',
  shopping_list: 'Shopping list',
  household_member: 'Household',
  'household-newuser': 'New member',
  'household-newuser-reminder': 'New member',
  'household-member-left': 'Household change',
  'household-ownership-transfer': 'Household change',
};

/**
 * A short human label for where a notification came from, or `null` when the
 * source is unknown (never the raw internal value).
 */
export function notificationSourceLabel(sourceType: string | undefined): string | null {
  if (!sourceType) return null;
  if (SOURCE_LABELS[sourceType]) return SOURCE_LABELS[sourceType];
  if (/warranty/i.test(sourceType)) return 'Warranty';
  if (/vehicle/i.test(sourceType)) return 'Vehicle';
  if (/maintenance/i.test(sourceType)) return 'Home maintenance';
  if (/chore/i.test(sourceType)) return 'Chores';
  if (/member|household/i.test(sourceType)) return 'Household';
  return null;
}

/** A friendly line for an empty, fully read inbox. Stable per day so it does not flicker. */
export function caughtUpLine(now: Date): string {
  const lines = [
    'Nothing new. The house is quiet.',
    'All caught up. Put the kettle on.',
    'Inbox zero. Nicely done.',
    'No news is good news.',
  ];
  return lines[(now.getFullYear() * 400 + now.getMonth() * 31 + now.getDate()) % lines.length];
}
