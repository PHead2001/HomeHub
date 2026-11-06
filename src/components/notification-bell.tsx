"use client";

import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { Bell, BellDot, CheckCheck, ExternalLink, X } from "lucide-react";
import Link from "next/link";
import { formatDistanceToNow } from "date-fns";
import { collection, doc, limit, onSnapshot, orderBy, query, updateDoc, where, writeBatch } from "firebase/firestore";
import { Button } from "./ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ScrollArea } from "./ui/scroll-area";
import type { Notification } from "@/lib/types";
import { cn } from "@/lib/utils";
import { useAuth } from "@/hooks/use-auth";
import { db } from "@/lib/firebase";
import { errorEmitter } from '@/lib/error-emitter';
import { FirestorePermissionError } from '@/lib/errors';
import { useToast } from "@/hooks/use-toast";
import { useAppBadge } from "@/hooks/use-app-badge";
import { EmptyState } from "@/components/empty-state";
import { caughtUpLine, groupNotifications } from "@/lib/dashboard/notification-display";
import styles from "@/components/dashboard/dashboard.module.css";
import {
  createNotificationAction,
  deduplicateNotifications,
  getNotificationLink,
  isNotificationDismissedBy,
  isNotificationExpired,
  isNotificationReadBy,
  isNotificationVisibleToUser,
  parseNotificationDoc,
} from "@/lib/notifications";

function NotificationItem({
  notification,
  isRead,
  onDismiss,
  onOpen,
}: {
  notification: Notification;
  isRead: boolean;
  onDismiss: (id: string) => void;
  onOpen: (notification: Notification) => void;
}) {
  const [dragX, setDragX] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  const itemRef = useRef<HTMLDivElement>(null);
  const startXRef = useRef(0);
  const wasDraggedRef = useRef(false);
  const SWIPE_THRESHOLD = -60;

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    // Swipe-to-dismiss is a touch gesture; capturing on a mouse press would
    // retarget the click away from the item's link.
    if (!event.isPrimary || event.pointerType === 'mouse') return;

    wasDraggedRef.current = false;
    setIsDragging(true);
    startXRef.current = event.clientX;
    if (itemRef.current) {
      itemRef.current.style.transition = 'none';
    }
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!isDragging || !event.isPrimary) return;

    const deltaX = event.clientX - startXRef.current;
    if (Math.abs(deltaX) > 5 && !wasDraggedRef.current) {
      itemRef.current?.setPointerCapture(event.pointerId);
    }
    if (Math.abs(deltaX) > 5) {
      wasDraggedRef.current = true;
    }

    if (wasDraggedRef.current) {
      event.preventDefault();
    }

    if (deltaX < 50) {
      setDragX(deltaX < 0 ? deltaX : deltaX / 5);
    }
  };

  const handlePointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!isDragging || !event.isPrimary) return;

    setIsDragging(false);
    if (itemRef.current?.hasPointerCapture(event.pointerId)) itemRef.current.releasePointerCapture(event.pointerId);
    if (itemRef.current) {
      itemRef.current.style.transition = 'transform 0.2s ease-out';
    }

    if (wasDraggedRef.current && dragX < SWIPE_THRESHOLD) {
      setDragX(-itemRef.current!.offsetWidth);
      setTimeout(() => onDismiss(notification.id), 200);
    } else {
      setDragX(0);
    }
  };

  const handlePointerCancel = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!isDragging) return;

    setIsDragging(false);
    wasDraggedRef.current = false;
    if (itemRef.current?.hasPointerCapture(event.pointerId)) itemRef.current.releasePointerCapture(event.pointerId);
    if (itemRef.current) itemRef.current.style.transition = 'transform 0.2s ease-out';
    setDragX(0);
  };

  const backgroundOpacity = Math.min(Math.abs(dragX / SWIPE_THRESHOLD), 1);

  return (
    <div className="group relative w-full overflow-hidden rounded-sm bg-popover">
      <div
        className="absolute inset-y-0 right-0 flex w-full items-center justify-end bg-muted pr-4 text-muted-foreground"
        style={{ opacity: backgroundOpacity }}
      >
        <X className="h-5 w-5" />
      </div>
      <div
        ref={itemRef}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerCancel}
        className="w-full touch-pan-y bg-popover"
        style={{ transform: `translateX(${dragX}px)`, cursor: isDragging ? 'grabbing' : 'grab' }}
      >
        <DropdownMenuItem
          asChild
          className={cn("flex flex-col items-start gap-1 whitespace-normal p-0 pr-8", !isRead && "bg-accent/50")}
          onSelect={(event) => {
            if (wasDraggedRef.current) event.preventDefault();
          }}
        >
          <Link
            href={getNotificationLink(notification)}
            className="block h-full w-full p-2"
            draggable={false}
            onClick={() => onOpen(notification)}
          >
            <p className="text-sm font-medium leading-tight pointer-events-none">{notification.title || "HomeHub"}</p>
            <p className="text-sm pointer-events-none">{notification.message}</p>
            <p className="text-xs text-muted-foreground pointer-events-none">
              {formatDistanceToNow(notification.createdAt, { addSuffix: true })}
            </p>
          </Link>
        </DropdownMenuItem>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="absolute right-1 top-1/2 hidden h-7 w-7 -translate-y-1/2 text-muted-foreground hover:text-foreground group-hover:flex group-focus-within:flex"
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onDismiss(notification.id);
          }}
        >
          <X className="h-4 w-4" />
          <span className="sr-only">Dismiss {notification.title || "HomeHub notification"}</span>
        </Button>
      </div>
    </div>
  );
}

export function NotificationBell() {
  const { currentUser } = useAuth();
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [hasError, setHasError] = useState(false);
  const { toastError } = useToast();
  // H11: the bell rings and the badge pops when a new unread notification arrives.
  const [ringKey, setRingKey] = useState(0);
  const previousUnread = useRef<number | null>(null);

  useEffect(() => {
    if (!currentUser?.householdId || !currentUser.uid) {
      setNotifications([]);
      setIsLoading(false);
      return;
    }

    setIsLoading(true);
    setHasError(false);
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const notificationsQuery = query(
      collection(db, 'households', currentUser.householdId, 'notifications'),
      where('createdAt', '>=', sevenDaysAgo),
      orderBy('createdAt', 'desc'),
      limit(30)
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
  }, [currentUser?.householdId, currentUser?.uid]);

  const activeNotifications = useMemo(() => {
    if (!currentUser?.uid || !currentUser.email) return [];
    return notifications
      .filter((notification) => !isNotificationExpired(notification))
      .filter((notification) => isNotificationVisibleToUser(notification, currentUser))
      .filter((notification) => !notification.resolvedAt)
      .filter((notification) => !isNotificationDismissedBy(notification, currentUser.uid))
      .slice(0, 10);
  }, [currentUser, notifications]);

  const unreadCount = useMemo(() => {
    if (!currentUser?.uid) return 0;
    return activeNotifications.filter((notification) => !isNotificationReadBy(notification, currentUser.uid)).length;
  }, [activeNotifications, currentUser?.uid]);

  // Mirror the unread count on the installed app icon (Badging API).
  useAppBadge(isLoading || hasError ? null : unreadCount);

  useEffect(() => {
    if (isLoading || hasError) return;
    if (previousUnread.current !== null && unreadCount > previousUnread.current) setRingKey((key) => key + 1);
    previousUnread.current = unreadCount;
  }, [unreadCount, isLoading, hasError]);

  const groups = useMemo(() => groupNotifications(activeNotifications, new Date()), [activeNotifications]);
  const bellLabel = unreadCount > 0 ? `Notifications, ${unreadCount} unread` : 'Notifications';

  const dismissNotifications = async (notificationIds: string[]) => {
    if (!currentUser?.householdId || !currentUser.uid || notificationIds.length === 0) return;

    const batch = writeBatch(db);
    const action = createNotificationAction(currentUser);

    notificationIds.forEach((notificationId) => {
      const notificationRef = doc(db, 'households', currentUser.householdId!, 'notifications', notificationId);
      batch.update(notificationRef, {
        [`dismissedBy.${currentUser.uid}`]: action,
      });
    });

    try {
      await batch.commit();
    } catch (error) {
      console.error("Error dismissing notifications:", error);
      toastError(error, 'Could not dismiss notifications');
    }
  };

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

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="relative" aria-label={bellLabel} data-testid="notification-bell">
          <span key={`bell-${ringKey}`} aria-hidden className={cn("flex", ringKey > 0 && styles.ring)}>
            {unreadCount > 0 ? <BellDot className="h-5 w-5" /> : <Bell className="h-5 w-5" />}
          </span>
          {unreadCount > 0 && (
            <span
              key={`badge-${ringKey}`}
              aria-hidden
              className={cn("absolute right-0 top-0 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-0.5 text-[10px] font-semibold text-destructive-foreground", ringKey > 0 && styles.pop)}
            >
              {unreadCount > 9 ? "9+" : unreadCount}
            </span>
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-80 p-0">
        <div className="p-2">
          <DropdownMenuLabel className="flex items-center justify-between gap-2">
            <span className="font-headline">Notifications</span>
            {activeNotifications.length > 0 && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => dismissNotifications(activeNotifications.map((notification) => notification.id))}
                className="h-auto px-2 py-1 text-xs"
              >
                <CheckCheck className="mr-1 h-3 w-3" />
                Dismiss all
              </Button>
            )}
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
        </div>
        <ScrollArea className="h-64">
          {isLoading ? (
            <p className="py-8 text-center text-sm text-muted-foreground">Loading notifications...</p>
          ) : hasError ? (
            <p role="alert" className="px-4 py-8 text-center text-sm text-destructive">Could not load notifications. Check your connection and try again.</p>
          ) : activeNotifications.length > 0 ? (
            <div className="space-y-1 p-1">
              {groups.map((group) => (
                <Fragment key={group.id}>
                  <p className="px-2 pb-0.5 pt-2 text-xs font-medium text-muted-foreground">{group.label}</p>
                  {group.items.map((notification) => (
                    <NotificationItem
                      key={notification.id}
                      notification={notification}
                      isRead={currentUser?.uid ? isNotificationReadBy(notification, currentUser.uid) : false}
                      onDismiss={(id) => dismissNotifications([id])}
                      onOpen={handleOpenNotification}
                    />
                  ))}
                </Fragment>
              ))}
            </div>
          ) : (
            <EmptyState kind="notifications" compact headingLevel={3} title="All caught up" description={caughtUpLine(new Date())} />
          )}
        </ScrollArea>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild className="cursor-pointer">
          <Link href="/notifications" className="flex w-full items-center justify-center gap-2 py-2 text-sm">
            See notification center
            <ExternalLink className="h-3.5 w-3.5" />
          </Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
