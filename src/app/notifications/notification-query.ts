import { limit, orderBy, query, where, type CollectionReference, type DocumentData, type Query } from 'firebase/firestore';
import { audienceQueryValues } from '@functions/shared/notification-audience';
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
 * The audience filter every client list query of notifications carries:
 * documents addressed to the member (`[uid]`) or to everyone (`['*']`). The
 * read rule only lets a query through when it is constrained this way.
 * Documents without `audience` (written before the field existed and not
 * backfilled) do not match and are unreadable.
 */
export const audienceConstraint = (uid: string) => where('audience', 'array-contains-any', audienceQueryValues(uid));

/**
 * The member's notifications from `since`, newest first: only those whose
 * `audience` names them or everyone (`audienceConstraint`). When the member
 * cannot see every category, the category filter is part of the query, so a
 * `max` cap counts only notifications they can see: a busy category they
 * cannot view never pushes their own notifications out of the window.
 * Needs the composite indexes (audience CONTAINS, createdAt DESC) and
 * (audience CONTAINS, category ASC, createdAt DESC) in firestore.indexes.json.
 * Stored categories are always one of the known values (rules and upkeep
 * write nothing else).
 */
export function notificationWindowQuery(
  ref: CollectionReference<DocumentData>,
  uid: string,
  since: Date,
  categories: NotificationCategory[] | null,
  max?: number,
): Query<DocumentData> {
  return query(
    ref,
    audienceConstraint(uid),
    ...(categories ? [where('category', 'in', categories)] : []),
    where('createdAt', '>=', since),
    orderBy('createdAt', 'desc'),
    ...(max ? [limit(max)] : []),
  );
}

/**
 * The member's notifications from the given sources (`sourceType` equal to one
 * of `sourceTypes`, and `sourceId` one of `sourceIds` when given), audience
 * constrained like every list query. Used by Maintenance Center to resolve a
 * schedule's or a deleted record's reminders; those are household-wide
 * (`['*']`), so the caller sees all of them. At most 10 source ids (`in`
 * limit). Needs (audience CONTAINS, sourceType ASC) and (audience CONTAINS,
 * sourceType ASC, sourceId ASC) in firestore.indexes.json.
 */
export function notificationsBySourceQuery(
  ref: CollectionReference<DocumentData>,
  uid: string,
  sourceTypes: string[],
  sourceIds?: string[],
): Query<DocumentData> {
  return query(
    ref,
    audienceConstraint(uid),
    sourceTypes.length === 1 ? where('sourceType', '==', sourceTypes[0]) : where('sourceType', 'in', sourceTypes),
    ...(sourceIds ? [sourceIds.length === 1 ? where('sourceId', '==', sourceIds[0]) : where('sourceId', 'in', sourceIds)] : []),
  );
}
