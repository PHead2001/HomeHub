import { limit, orderBy, query, where, type CollectionReference, type DocumentData, type Query } from 'firebase/firestore';
import { categoryViewPermission, type ViewPermission } from '@functions/shared/push-audience';
import { notificationCategories } from '@/lib/notifications';
import type { NotificationCategory } from '@/lib/types';

/**
 * The notification categories a member may see (module categories need that
 * module's view permission; `system` and `general` need none), or `null` when
 * they may see every category and the query needs no category filter.
 */
export function viewableNotificationCategories(
  canView: (permission: ViewPermission) => boolean,
): NotificationCategory[] | null {
  const allowed = notificationCategories.filter((category) => {
    const permission = categoryViewPermission(category);
    return permission === null || canView(permission);
  });
  return allowed.length === notificationCategories.length ? null : allowed;
}

/** Stable string for effect dependencies. */
export const categoriesKey = (categories: NotificationCategory[] | null) => (categories ? categories.join(',') : '*');

/**
 * The household's notifications from `since`, newest first. When the member
 * cannot see every category, the category filter is part of the query, so a
 * `max` cap counts only notifications they can see: a busy category they
 * cannot view never pushes their own notifications out of the window.
 * Needs the composite index (category ASC, createdAt DESC) in
 * firestore.indexes.json. Stored categories are always one of the known
 * values (rules and upkeep write nothing else).
 */
export function notificationWindowQuery(
  ref: CollectionReference<DocumentData>,
  since: Date,
  categories: NotificationCategory[] | null,
  max?: number,
): Query<DocumentData> {
  return query(
    ref,
    ...(categories ? [where('category', 'in', categories)] : []),
    where('createdAt', '>=', since),
    orderBy('createdAt', 'desc'),
    ...(max ? [limit(max)] : []),
  );
}
