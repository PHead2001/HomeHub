/**
 * Presentation helpers for the notification bell and center (H11): date groups
 * and plain-language source labels. Internal `sourceType` values and expiry stamps
 * are never shown to people.
 */
import { startOfLocalDay } from './dates';
import { isNotificationDismissedBy, isNotificationExpired, isNotificationReadBy, isNotificationVisibleToUser } from '../notifications';
import type { Notification } from '../types';
import { canSeeCategory, type ViewPermission } from '@functions/shared/push-audience';

/** The bell lists at most this many active notifications; counts and Dismiss all cover every active one (NO-7). */
export const BELL_LIMIT = 10;

/**
 * Every active notification: not expired, meant for this member, allowed by category,
 * not resolved and not dismissed by them, newest first, uncapped. The bell's badge,
 * the dashboard tile and the center's Unread count all count from this (NO-7), and the
 * bell's Dismiss all dismisses all of it.
 */
export function activeNotifications(
  notifications: Notification[],
  user: { uid: string; email: string; canView?: (permission: ViewPermission) => boolean },
  now = new Date(),
): Notification[] {
  return notifications
    .filter((notification) => !isNotificationExpired(notification, now))
    .filter((notification) => isNotificationVisibleToUser(notification, user))
    // A module's notifications need that module's view permission (as pushes do).
    .filter((notification) => !user.canView || canSeeCategory(notification.category, user.canView))
    .filter((notification) => !notification.resolvedAt)
    .filter((notification) => !isNotificationDismissedBy(notification, user.uid));
}

/**
 * The bell's list: {@link activeNotifications} capped at {@link BELL_LIMIT}. Pass
 * notifications already merged with `deduplicateNotifications`.
 */
export function activeBellNotifications(
  notifications: Notification[],
  user: { uid: string; email: string; canView?: (permission: ViewPermission) => boolean },
  now = new Date(),
): Notification[] {
  return activeNotifications(notifications, user, now).slice(0, BELL_LIMIT);
}

/** Unread among the active notifications, counted before any cap (NO-7). */
export const unreadCount = (active: Notification[], uid: string): number =>
  active.filter((notification) => !isNotificationReadBy(notification, uid)).length;

/** The bell's (and the dashboard's) notification window. */
export const NOTIFICATION_WINDOW_DAYS = 7;

/**
 * Unread among the active notifications at `now`: the last {@link NOTIFICATION_WINDOW_DAYS}
 * days, then {@link activeNotifications} (expiry, audience, category, resolved,
 * dismissed), counted before the bell's cap (NO-7). Recomputed as time passes from the retained documents, so a notice
 * that expires (or leaves the window) drops out of the count without a new snapshot.
 */
export function unreadBellCount(
  notifications: Notification[],
  user: { uid: string; email: string; canView?: (permission: ViewPermission) => boolean },
  now: Date,
): number {
  const since = now.getTime() - NOTIFICATION_WINDOW_DAYS * 86_400_000;
  const recent = notifications.filter((notification) => notification.createdAt.getTime() >= since);
  return unreadCount(activeNotifications(recent, user, now), user.uid);
}

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

/** Where a notification's link goes, in words, for its peek card (H26). */
const DESTINATIONS: Array<[string, string]> = [
  ['/chores', 'Chores'],
  ['/calendar', 'Calendar'],
  ['/shopping', 'Shopping'],
  ['/pets', 'Pets'],
  ['/maintenance', 'Maintenance'],
  ['/automation', 'Automation'],
  ['/household', 'Household'],
  ['/notifications', 'Notification Center'],
];

export function notificationDestination(link: string): string | null {
  if (!link || link === '#') return null;
  const path = link.split(/[?#]/)[0];
  if (path === '/') return 'Home';
  return DESTINATIONS.find(([prefix]) => path === prefix || path.startsWith(`${prefix}/`))?.[1] ?? null;
}
