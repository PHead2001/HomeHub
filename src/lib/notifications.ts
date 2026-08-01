import { addDays, isAfter } from 'date-fns';
import type { DocumentData, QueryDocumentSnapshot, Timestamp } from 'firebase/firestore';
import type { Notification, NotificationCategory, NotificationUserAction } from '@/lib/types';
import type { User as HomeHubUser } from '@/lib/types';
import { stableSlugify } from '@/lib/utils';

const NOTIFICATION_TTL_DAYS = 7;

export const notificationCategories: NotificationCategory[] = [
  'chores',
  'pets',
  'shopping',
  'maintenance',
  'automation',
  'system',
  'general',
];

export const notificationCategoryLabels: Record<NotificationCategory, string> = {
  chores: 'Chores',
  pets: 'Pets',
  shopping: 'Shopping',
  maintenance: 'Maintenance',
  automation: 'Automation',
  system: 'System',
  general: 'General',
};

export const getNotificationExpiry = (createdAt: Date) => addDays(createdAt, NOTIFICATION_TTL_DAYS);

export const createNotificationAction = (user: HomeHubUser): NotificationUserAction => ({
  at: new Date(),
  uid: user.uid,
  email: user.email,
  displayName: user.displayName,
});

const toDate = (value: unknown, fallback = new Date()): Date => {
  if (value instanceof Date) return value;
  if (value && typeof value === 'object' && 'toDate' in value && typeof (value as Timestamp).toDate === 'function') {
    return (value as Timestamp).toDate();
  }
  if (typeof value === 'string' || typeof value === 'number') {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return fallback;
};

const parseAction = (value: unknown): NotificationUserAction | null => {
  if (!value || typeof value !== 'object') return null;
  const action = value as Record<string, unknown>;

  return {
    at: toDate(action.at),
    uid: typeof action.uid === 'string' ? action.uid : undefined,
    email: typeof action.email === 'string' ? action.email : undefined,
    displayName: typeof action.displayName === 'string' ? action.displayName : undefined,
  };
};

const parseActionMap = (value: unknown): Record<string, NotificationUserAction> => {
  if (!value || typeof value !== 'object') return {};

  return Object.entries(value as Record<string, unknown>).reduce<Record<string, NotificationUserAction>>((actions, [uid, action]) => {
    const parsed = parseAction(action);
    if (parsed) actions[uid] = parsed;
    return actions;
  }, {});
};

export const parseNotificationDoc = (snapshot: QueryDocumentSnapshot<DocumentData>): Notification => {
  const data = snapshot.data();
  const createdAt = toDate(data.createdAt);
  const expiresAt = data.expiresAt ? toDate(data.expiresAt) : getNotificationExpiry(createdAt);

  return {
    id: snapshot.id,
    householdId: typeof data.householdId === 'string' ? data.householdId : '',
    category: notificationCategories.includes(data.category) ? data.category : 'general',
    title: typeof data.title === 'string' ? data.title : undefined,
    message: typeof data.message === 'string' ? data.message : '',
    createdAt,
    expiresAt,
    deepLink: typeof data.deepLink === 'string' ? data.deepLink : (typeof data.href === 'string' ? data.href : undefined),
    href: typeof data.href === 'string' ? data.href : undefined,
    sourceType: typeof data.sourceType === 'string' ? data.sourceType : undefined,
    sourceId: typeof data.sourceId === 'string' ? data.sourceId : undefined,
    stateKey: typeof data.stateKey === 'string' ? data.stateKey : undefined,
    targetUserUid: typeof data.targetUserUid === 'string' ? data.targetUserUid : undefined,
    targetUserEmail: typeof data.targetUserEmail === 'string' ? data.targetUserEmail : undefined,
    readBy: parseActionMap(data.readBy),
    dismissedBy: parseActionMap(data.dismissedBy),
    resolvedAt: data.resolvedAt ? toDate(data.resolvedAt) : undefined,
    resolvedBy: parseAction(data.resolvedBy) || undefined,
    isRead: typeof data.isRead === 'boolean' ? data.isRead : undefined,
  };
};

export const isNotificationExpired = (notification: Notification, now = new Date()) => {
  return !isAfter(notification.expiresAt, now);
};

export const isNotificationReadBy = (notification: Notification, uid: string) => {
  return Boolean(notification.readBy[uid] || notification.isRead);
};

export const isNotificationDismissedBy = (notification: Notification, uid: string) => {
  return Boolean(notification.dismissedBy[uid]);
};

export const isNotificationVisibleToUser = (
  notification: Notification,
  user: Pick<HomeHubUser, 'uid' | 'email'>
) => {
  if (notification.targetUserUid) return notification.targetUserUid === user.uid;
  if (notification.targetUserEmail) return notification.targetUserEmail === user.email;
  return true;
};

export const getNotificationLink = (notification: Notification) => notification.deepLink || notification.href || '#';

const hashNotificationIdentity = (value: string) => {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
};

export const getDeterministicNotificationId = ({
  sourceType,
  sourceId,
  stateKey,
}: {
  sourceType: string;
  sourceId: string;
  stateKey: string;
}) => {
  const identity = `${sourceType}|${sourceId}|${stateKey}`;
  return `${stableSlugify(sourceType) || 'notification'}-${hashNotificationIdentity(identity)}`;
};

const getNotificationSemanticKey = (notification: Notification) => {
  if (!notification.sourceType || !notification.sourceId) return `document:${notification.id}`;
  return `${notification.sourceType}|${notification.sourceId}|${notification.stateKey || 'legacy'}`;
};

export const deduplicateNotifications = (notifications: Notification[]) => {
  const grouped = new Map<string, Notification>();

  notifications.forEach((notification) => {
    const key = getNotificationSemanticKey(notification);
    const existing = grouped.get(key);
    if (!existing) {
      grouped.set(key, notification);
      return;
    }

    const newer = notification.createdAt > existing.createdAt ? notification : existing;
    const older = newer === notification ? existing : notification;
    grouped.set(key, {
      ...newer,
      createdAt: older.createdAt,
      expiresAt: newer.expiresAt > older.expiresAt ? newer.expiresAt : older.expiresAt,
      readBy: { ...older.readBy, ...newer.readBy },
      dismissedBy: { ...older.dismissedBy, ...newer.dismissedBy },
      resolvedAt: newer.resolvedAt || older.resolvedAt,
      resolvedBy: newer.resolvedBy || older.resolvedBy,
    });
  });

  return Array.from(grouped.values()).sort((left, right) => {
    const createdAtDifference = right.createdAt.getTime() - left.createdAt.getTime();
    if (createdAtDifference) return createdAtDifference;
    const semanticDifference = getNotificationSemanticKey(left).localeCompare(getNotificationSemanticKey(right));
    return semanticDifference || left.id.localeCompare(right.id);
  });
};

export const buildNotificationDocument = ({
  householdId,
  category,
  title,
  message,
  deepLink,
  sourceType,
  sourceId,
  stateKey,
  targetUser,
}: {
  householdId: string;
  category: NotificationCategory;
  title?: string;
  message: string;
  deepLink?: string;
  sourceType?: string;
  sourceId?: string;
  stateKey?: string;
  targetUser?: HomeHubUser;
}) => {
  const createdAt = new Date();

  const document = {
    householdId,
    category,
    title: title || notificationCategoryLabels[category],
    message,
    createdAt,
    expiresAt: getNotificationExpiry(createdAt),
    deepLink,
    sourceType,
    sourceId,
    stateKey,
    targetUserUid: targetUser?.uid,
    targetUserEmail: targetUser?.email,
    readBy: {},
    dismissedBy: {},
  };

  return Object.fromEntries(
    Object.entries(document).filter(([, value]) => value !== undefined)
  );
};
