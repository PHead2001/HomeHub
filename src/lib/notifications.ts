import { addDays, isAfter } from 'date-fns';
import type { DocumentData, QueryDocumentSnapshot, Timestamp } from 'firebase/firestore';
import type { Notification, NotificationCategory, NotificationUserAction } from '@/lib/types';
import type { User as HomeHubUser } from '@/lib/types';

const NOTIFICATION_TTL_DAYS = 7;

export const notificationCategories: NotificationCategory[] = [
  'chores',
  'pets',
  'shopping',
  'maintenance',
  'automation',
  'general',
];

export const notificationCategoryLabels: Record<NotificationCategory, string> = {
  chores: 'Chores',
  pets: 'Pets',
  shopping: 'Shopping',
  maintenance: 'Maintenance',
  automation: 'Automation',
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

export const buildNotificationDocument = ({
  householdId,
  category,
  title,
  message,
  deepLink,
  sourceType,
  sourceId,
  targetUser,
}: {
  householdId: string;
  category: NotificationCategory;
  title?: string;
  message: string;
  deepLink?: string;
  sourceType?: string;
  sourceId?: string;
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
    targetUserUid: targetUser?.uid,
    targetUserEmail: targetUser?.email,
    readBy: {},
    dismissedBy: {},
  };

  return Object.fromEntries(
    Object.entries(document).filter(([, value]) => value !== undefined)
  );
};
