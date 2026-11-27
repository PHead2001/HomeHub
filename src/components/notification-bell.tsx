"use client";

import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Bell, BellDot, CheckCheck, ExternalLink, MailCheck, X } from "lucide-react";
import Link from "next/link";
import { formatDistance } from "date-fns";
import { collection, doc, onSnapshot, updateDoc } from "firebase/firestore";
import { Button } from "./ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { Notification } from "@/lib/types";
import { cn } from "@/lib/utils";
import { useAuth } from "@/hooks/use-auth";
import { useNow } from "@/hooks/use-now";
import { db } from "@/lib/firebase";
import { errorEmitter } from '@/lib/error-emitter';
import { FirestorePermissionError } from '@/lib/errors';
import { useReducedMotion } from "@/hooks/use-reduced-motion";
import { useSwipeDismiss } from "@/app/notifications/swipe-dismiss";
import { useDismissNotifications } from "@/app/notifications/use-dismiss-notifications";
import { useMarkRead } from "@/app/notifications/use-mark-read";
import { categoriesKey, notificationWindowQuery, viewableNotificationCategories } from "@/app/notifications/notification-query";
import { useAppBadge } from "@/hooks/use-app-badge";
import { NumberTicker } from "@/components/motion/number-ticker";
import { EmptyState } from "@/components/empty-state";
import { BELL_LIMIT, activeNotifications as activeFor, caughtUpLine, groupNotifications, unreadCount as countUnread } from "@/lib/dashboard/notification-display";
import styles from "@/components/dashboard/dashboard.module.css";
import {
  createNotificationAction,
  deduplicateNotifications,
  getNotificationLink,
  isNotificationReadBy,
  notificationSince,
  parseNotificationDoc,
} from "@/lib/notifications";

function NotificationItem({
  notification,
  isRead,
  canDismiss,
  now,
  onDismiss,
  onOpen,
}: {
  notification: Notification;
  isRead: boolean;
  /** NO-8: dismissing needs notifications.dismiss (guests only read). */
  canDismiss: boolean;
  now: Date;
  onDismiss: (id: string) => void;
  onOpen: (notification: Notification) => void;
}) {
  const reducedMotion = useReducedMotion();
  // The wrapper and the link never move (they are the hit targets); only the
  // content layer slides.
  const swipe = useSwipeDismiss({
    disabled: !canDismiss,
    reducedMotion,
    onDismiss: () => onDismiss(notification.id),
  });
  const link = getNotificationLink(notification);
  const title = notification.title || "HomeHub";

  const content = (
    // Opaque only while it moves, so the item's own highlight shows at rest.
    <div
      data-swipe-visual
      className={cn("pointer-events-none relative p-2 pl-5", canDismiss && "pr-12", swipe.engaged && "bg-popover")}
      style={swipe.visualStyle}
    >
      {swipe.engaged && !isRead && <span aria-hidden className="absolute inset-0 bg-accent/50" />}
      {/* NO-20: unread is a dot and words, not colour alone. */}
      {!isRead && <span aria-hidden className="absolute left-1.5 top-3.5 h-2 w-2 rounded-full bg-primary" />}
      <span className="relative block text-sm font-medium leading-tight">
        {!isRead && <span className="sr-only">Unread: </span>}
        {title}
      </span>
      <span className="relative block text-sm">{notification.message}</span>
      <span className="relative block text-xs text-muted-foreground">
        {formatDistance(notificationSince(notification), now, { addSuffix: true })}
      </span>
    </div>
  );

  return (
    <li
      {...swipe.handlers}
      className={cn(
        "group relative w-full touch-pan-y overflow-hidden rounded-sm",
        !isRead && "bg-accent/50",
        // NO-20: the grab cursor only where a swipe works (touch).
        canDismiss && "[@media(pointer:coarse)]:cursor-grab",
        swipe.dragging && "cursor-grabbing",
      )}
    >
      <div
        aria-hidden
        className={cn("pointer-events-none absolute inset-0 flex items-center justify-end bg-muted pr-4 text-muted-foreground", reducedMotion && "z-10")}
        style={{ opacity: swipe.hintOpacity }}
      >
        <X className="h-5 w-5" />
      </div>
      {link !== "#" ? (
        <Link
          href={link}
          className="block h-full w-full rounded-sm outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
          draggable={false}
          onClick={() => onOpen(notification)}
        >
          {content}
        </Link>
      ) : (
        // NO-11, NO-20: nothing to open, so a button that marks it read, never a link to "#".
        <button
          type="button"
          className="block w-full rounded-sm text-left outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
          onClick={() => onOpen(notification)}
        >
          {content}
        </button>
      )}
      {canDismiss && (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className={cn(
            "absolute right-1 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground",
            swipe.engaged && "opacity-0",
          )}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onDismiss(notification.id);
          }}
        >
          <X className="h-4 w-4" />
          <span className="sr-only">Dismiss {title}</span>
        </Button>
      )}
    </li>
  );
}

/**
 * The header bell (NO-14, NO-16, NO-20): a popover with a real list, so every link and
 * dismiss button is reachable with Tab; sized to the screen; Mark all read; new
 * notifications are announced politely.
 */
export function NotificationBell() {
  const { currentUser, permissions } = useAuth();
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [hasError, setHasError] = useState(false);
  const dismissNotifications = useDismissNotifications();
  const markRead = useMarkRead();
  const canDismiss = Boolean(permissions['notifications.dismiss']);
  // NO-11: ages tick and Today / This week roll over on an always-on screen.
  const now = useNow();
  // H11: the bell rings and the badge pops when a new unread notification arrives.
  const [ringKey, setRingKey] = useState(0);
  const [announcement, setAnnouncement] = useState('');
  const previousUnread = useRef<number | null>(null);

  // The category filter is part of the query, so the 30-item cap counts only
  // notifications this member may see.
  const viewKey = categoriesKey(viewableNotificationCategories((permission) => Boolean(permissions[permission])));

  useEffect(() => {
    if (!currentUser?.householdId || !currentUser.uid) {
      setNotifications([]);
      setIsLoading(false);
      return;
    }

    setIsLoading(true);
    setHasError(false);
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const categories = viewKey === '*' ? null : (viewKey.split(',') as Notification['category'][]);
    const notificationsQuery = notificationWindowQuery(
      collection(db, 'households', currentUser.householdId, 'notifications'),
      currentUser.uid,
      sevenDaysAgo,
      categories,
      30,
    );

    const unsubscribe = onSnapshot(notificationsQuery, (snapshot) => {
      setNotifications(deduplicateNotifications(snapshot.docs.map(parseNotificationDoc)));
      setIsLoading(false);
    },
    () => {
      setIsLoading(false);
      setHasError(true);
      const permissionError = new FirestorePermissionError({
        path: `households/${currentUser.householdId}/notifications`,
        operation: 'list',
      });
      errorEmitter.emit('permission-error', permissionError);
    });

    return () => unsubscribe();
  }, [currentUser?.householdId, currentUser?.uid, viewKey]);

  // NO-7: every active notification is counted and dismissed; the list shows the newest BELL_LIMIT.
  const allActive = useMemo(() => {
    if (!currentUser?.uid || !currentUser.email) return [];
    return activeFor(notifications, {
      uid: currentUser.uid,
      email: currentUser.email,
      canView: (permission) => Boolean(permissions[permission]),
    }, now);
  }, [currentUser, notifications, permissions, now]);
  const activeNotifications = useMemo(() => allActive.slice(0, BELL_LIMIT), [allActive]);
  const unread = useMemo(() => (currentUser?.uid ? allActive.filter((n) => !isNotificationReadBy(n, currentUser.uid)) : []), [allActive, currentUser?.uid]);
  const unreadCount = currentUser?.uid ? countUnread(allActive, currentUser.uid) : 0;

  // Mirror the unread count on the installed app icon (Badging API).
  useAppBadge(isLoading || hasError ? null : unreadCount);

  useEffect(() => {
    if (isLoading || hasError) return;
    if (previousUnread.current !== null && unreadCount > previousUnread.current) {
      setRingKey((key) => key + 1);
      // NO-20: screen readers hear about new notifications without moving focus.
      const added = unreadCount - previousUnread.current;
      setAnnouncement(added === 1 ? `New notification: ${unread[0]?.title || 'HomeHub'}` : `${added} new notifications`);
    }
    previousUnread.current = unreadCount;
  }, [unreadCount, isLoading, hasError, unread]);

  const groups = useMemo(() => groupNotifications(activeNotifications, now), [activeNotifications, now]);
  const bellLabel = unreadCount > 0 ? `Notifications, ${unreadCount} unread` : 'Notifications';

  const handleOpenNotification = async (notification: Notification) => {
    if (!currentUser?.householdId || !currentUser.uid || isNotificationReadBy(notification, currentUser.uid)) return;

    const notificationRef = doc(db, 'households', currentUser.householdId, 'notifications', notification.id);
    try {
      await updateDoc(notificationRef, {
        [`readBy.${currentUser.uid}`]: createNotificationAction(currentUser),
      });
    } catch (error) {
      console.error("Error marking notification as read:", error);
    }
  };

  let body: ReactNode;
  if (isLoading) {
    body = <p className="py-8 text-center text-sm text-muted-foreground">Loading notifications...</p>;
  } else if (hasError) {
    body = <p role="alert" className="px-4 py-8 text-center text-sm text-destructive">Could not load notifications. Check your connection and try again.</p>;
  } else if (activeNotifications.length === 0) {
    body = <EmptyState kind="notifications" compact headingLevel={3} title="All caught up" description={caughtUpLine(now)} />;
  } else {
    body = (
      <div className="space-y-1 p-1">
        {groups.map((group) => (
          <Fragment key={group.id}>
            <p className="px-2 pb-0.5 pt-2 text-xs font-medium text-muted-foreground" id={`bell-group-${group.id}`}>{group.label}</p>
            <ul className="space-y-1" aria-labelledby={`bell-group-${group.id}`}>
              {group.items.map((notification) => (
                <NotificationItem
                  key={notification.id}
                  notification={notification}
                  isRead={currentUser?.uid ? isNotificationReadBy(notification, currentUser.uid) : false}
                  canDismiss={canDismiss}
                  now={now}
                  onDismiss={(id) => dismissNotifications([id])}
                  onOpen={handleOpenNotification}
                />
              ))}
            </ul>
          </Fragment>
        ))}
        {allActive.length > activeNotifications.length && (
          <p className="px-2 py-1 text-xs text-muted-foreground">
            {allActive.length - activeNotifications.length} more in the notification center.
          </p>
        )}
      </div>
    );
  }

  return (
    <Popover>
      <span aria-live="polite" className="sr-only">{announcement}</span>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon" className="relative" aria-label={bellLabel} data-testid="notification-bell">
          <span key={`bell-${ringKey}`} aria-hidden className={cn("flex", ringKey > 0 && styles.ring)}>
            {unreadCount > 0 ? <BellDot className="h-5 w-5" /> : <Bell className="h-5 w-5" />}
          </span>
          {unreadCount > 0 && (
            <span
              key={`badge-${ringKey}`}
              aria-hidden
              className={cn("absolute -right-0.5 -top-0.5 flex h-5 min-w-5 items-center justify-center rounded-full bg-destructive px-1 text-xs font-semibold text-destructive-foreground", ringKey > 0 && styles.pop)}
            >
              {/* Ticks to a new count (H12); the button's label carries the number. */}
              {unreadCount > 9 ? "9+" : <NumberTicker value={unreadCount} animateOnMount={false} />}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      {/* NO-16: sized to the screen, not a fixed 320 x 256 box. */}
      <PopoverContent align="end" className="flex max-h-[min(80dvh,40rem)] w-[min(26rem,calc(100vw-1rem))] flex-col p-0" data-testid="notification-bell-panel">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b p-2">
          <h2 className="px-2 font-headline text-sm font-semibold">Notifications</h2>
          <div className="flex gap-1">
            {unread.length > 0 && (
              <Button variant="ghost" size="sm" onClick={() => void markRead(unread.map((n) => n.id))}>
                <MailCheck className="h-4 w-4" aria-hidden />
                Mark all read
              </Button>
            )}
            {canDismiss && allActive.length > 0 && (
              <Button variant="ghost" size="sm" onClick={() => dismissNotifications(allActive.map((notification) => notification.id))}>
                <CheckCheck className="h-4 w-4" aria-hidden />
                Dismiss all
              </Button>
            )}
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">{body}</div>
        <div className="border-t">
          <Link href="/notifications" className="flex min-h-[var(--target-min)] w-full items-center justify-center gap-2 py-2 text-sm hover:bg-accent">
            See notification center
            <ExternalLink className="h-3.5 w-3.5" aria-hidden />
          </Link>
        </div>
      </PopoverContent>
    </Popover>
  );
}
