"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type React from "react";
import Link from "next/link";
import { format, formatDistanceToNow } from "date-fns";
import { Bell, CheckCheck, Clock, ExternalLink, Loader2, X } from "lucide-react";
import { collection, doc, onSnapshot, orderBy, query, updateDoc, where, writeBatch } from "firebase/firestore";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { useAuth } from "@/hooks/use-auth";
import { useToast } from "@/hooks/use-toast";
import { db } from "@/lib/firebase";
import type { Notification, NotificationCategory, NotificationUserAction } from "@/lib/types";
import { cn } from "@/lib/utils";
import {
  createNotificationAction,
  getNotificationLink,
  isNotificationDismissedBy,
  isNotificationExpired,
  isNotificationReadBy,
  isNotificationVisibleToUser,
  notificationCategoryLabels,
  parseNotificationDoc,
} from "@/lib/notifications";

type NotificationFilter =
  | "unread"
  | "all"
  | "dismissed"
  | NotificationCategory;

const filterOptions: { value: NotificationFilter; label: string }[] = [
  { value: "unread", label: "Unread" },
  { value: "all", label: "All" },
  { value: "dismissed", label: "Dismissed" },
  { value: "chores", label: "Chores" },
  { value: "pets", label: "Pets" },
  { value: "shopping", label: "Shopping" },
  { value: "maintenance", label: "Maintenance" },
  { value: "automation", label: "Automation" },
];

const getActionName = (action?: NotificationUserAction) => {
  return action?.displayName || action?.email || (action?.uid ? "Household member" : null);
};

function NotificationCenterItem({
  notification,
  isRead,
  isDismissed,
  onDismiss,
  onOpen,
}: {
  notification: Notification;
  isRead: boolean;
  isDismissed: boolean;
  onDismiss: (id: string) => void;
  onOpen: (notification: Notification, event: React.MouseEvent<HTMLAnchorElement>) => void;
}) {
  const [dragX, setDragX] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  const itemRef = useRef<HTMLDivElement>(null);
  const startXRef = useRef(0);
  const wasDraggedRef = useRef(false);
  const SWIPE_THRESHOLD = -70;

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!event.isPrimary || isDismissed) return;

    wasDraggedRef.current = false;
    setIsDragging(true);
    startXRef.current = event.clientX;
    itemRef.current?.setPointerCapture(event.pointerId);
    if (itemRef.current) itemRef.current.style.transition = "none";
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!isDragging || !event.isPrimary) return;

    const deltaX = event.clientX - startXRef.current;
    if (Math.abs(deltaX) > 5) wasDraggedRef.current = true;
    if (wasDraggedRef.current) event.preventDefault();
    if (deltaX < 50) setDragX(deltaX < 0 ? deltaX : deltaX / 5);
  };

  const handlePointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!isDragging || !event.isPrimary) return;

    setIsDragging(false);
    itemRef.current?.releasePointerCapture(event.pointerId);
    if (itemRef.current) itemRef.current.style.transition = "transform 0.2s ease-out";

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
    itemRef.current?.releasePointerCapture(event.pointerId);
    if (itemRef.current) itemRef.current.style.transition = "transform 0.2s ease-out";
    setDragX(0);
  };

  const dismissedAction = Object.values(notification.dismissedBy)[0];
  const resolvedName = getActionName(notification.resolvedBy);
  const dismissedName = getActionName(dismissedAction);
  const hasDeepLink = getNotificationLink(notification) !== "#";
  const backgroundOpacity = isDismissed ? 0 : Math.min(Math.abs(dragX / SWIPE_THRESHOLD), 1);

  return (
    <div className="group relative overflow-hidden rounded-lg border bg-background">
      <div
        className="absolute inset-y-0 right-0 flex w-full items-center justify-end bg-muted pr-5 text-muted-foreground"
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
        className={cn("relative bg-background transition-opacity", isDismissed && "opacity-70")}
        style={{ transform: `translateX(${dragX}px)`, cursor: isDismissed ? "default" : (isDragging ? "grabbing" : "grab") }}
      >
        <Link
          href={getNotificationLink(notification)}
          onClick={(event) => onOpen(notification, event)}
          className="block p-4 pr-12"
          draggable={false}
        >
          <div className="flex flex-wrap items-start gap-2">
            <Badge variant={isDismissed ? "outline" : "secondary"}>
              {notificationCategoryLabels[notification.category]}
            </Badge>
            {!isRead && <Badge>Unread</Badge>}
            {isDismissed && <Badge variant="outline">Dismissed</Badge>}
            {notification.resolvedAt && <Badge variant="outline">Resolved</Badge>}
          </div>
          <div className="mt-3 space-y-1">
            <div className="flex items-start justify-between gap-3">
              <h2 className="font-headline text-base font-semibold leading-tight">{notification.title || "HomeHub"}</h2>
              {hasDeepLink && <ExternalLink className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />}
            </div>
            <p className="text-sm text-muted-foreground">{notification.message}</p>
          </div>
          <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1">
              <Clock className="h-3 w-3" />
              {formatDistanceToNow(notification.createdAt, { addSuffix: true })}
            </span>
            <span>Expires {format(notification.expiresAt, "MMM d, h:mm a")}</span>
            {notification.sourceType && <span>Source: {notification.sourceType}</span>}
            {dismissedName && <span>Dismissed by {dismissedName}</span>}
            {resolvedName && <span>Completed by {resolvedName}</span>}
          </div>
        </Link>
        {!isDismissed && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="absolute right-2 top-1/2 hidden h-8 w-8 -translate-y-1/2 text-muted-foreground hover:text-foreground group-hover:flex focus:flex"
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onDismiss(notification.id);
            }}
          >
            <X className="h-4 w-4" />
            <span className="sr-only">Dismiss notification</span>
          </Button>
        )}
      </div>
    </div>
  );
}

export function NotificationCenterClient() {
  const { currentUser } = useAuth();
  const { toast } = useToast();
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [activeFilter, setActiveFilter] = useState<NotificationFilter>("unread");
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!currentUser?.householdId) {
      setNotifications([]);
      setIsLoading(false);
      return;
    }

    setIsLoading(true);
    setError(null);
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const notificationsQuery = query(
      collection(db, "households", currentUser.householdId, "notifications"),
      where("createdAt", ">=", sevenDaysAgo),
      orderBy("createdAt", "desc")
    );

    const unsubscribe = onSnapshot(
      notificationsQuery,
      (snapshot) => {
        setNotifications(snapshot.docs.map(parseNotificationDoc));
        setIsLoading(false);
      },
      () => {
        setError("Could not load notification history.");
        setIsLoading(false);
      }
    );

    return () => unsubscribe();
  }, [currentUser?.householdId]);

  const validNotifications = useMemo(() => {
    return notifications.filter((notification) => !isNotificationExpired(notification));
  }, [notifications]);

  const filteredNotifications = useMemo(() => {
    if (!currentUser?.uid || !currentUser.email) return [];

    return validNotifications.filter((notification) => {
      if (!isNotificationVisibleToUser(notification, currentUser)) return false;

      const isDismissed = isNotificationDismissedBy(notification, currentUser.uid);
      const isRead = isNotificationReadBy(notification, currentUser.uid);

      if (activeFilter === "unread") return !isRead && !isDismissed;
      if (activeFilter === "all") return true;
      if (activeFilter === "dismissed") return isDismissed;
      return notification.category === activeFilter;
    });
  }, [activeFilter, currentUser, validNotifications]);

  const dismissNotifications = async (notificationIds: string[]) => {
    if (!currentUser?.householdId || !currentUser.uid || notificationIds.length === 0) return;

    const batch = writeBatch(db);
    const action = createNotificationAction(currentUser);

    notificationIds.forEach((notificationId) => {
      const notificationRef = doc(db, "households", currentUser.householdId!, "notifications", notificationId);
      batch.update(notificationRef, {
        [`dismissedBy.${currentUser.uid}`]: action,
      });
    });

    try {
      await batch.commit();
    } catch (dismissError) {
      console.error("Error dismissing notifications:", dismissError);
      toast({ variant: "destructive", title: "Error", description: "Could not dismiss notifications." });
    }
  };

  const handleDismissVisible = () => {
    if (!currentUser?.uid) return;
    const activeVisibleIds = filteredNotifications
      .filter((notification) => !isNotificationDismissedBy(notification, currentUser.uid))
      .map((notification) => notification.id);
    void dismissNotifications(activeVisibleIds);
  };

  const handleOpenNotification = async (notification: Notification, event: React.MouseEvent<HTMLAnchorElement>) => {
    if (getNotificationLink(notification) === "#") {
      event.preventDefault();
    }

    if (!currentUser?.householdId || !currentUser.uid || isNotificationReadBy(notification, currentUser.uid)) return;

    const notificationRef = doc(db, "households", currentUser.householdId, "notifications", notification.id);
    try {
      await updateDoc(notificationRef, {
        [`readBy.${currentUser.uid}`]: createNotificationAction(currentUser),
      });
    } catch (readError) {
      console.error("Error marking notification as read:", readError);
    }
  };

  const activeVisibleCount = currentUser?.uid
    ? filteredNotifications.filter((notification) => !isNotificationDismissedBy(notification, currentUser.uid)).length
    : 0;

  return (
    <div className="container mx-auto px-4 py-6 md:py-8">
      <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="font-headline text-2xl font-bold tracking-tight md:text-3xl">Notification Center</h1>
          <p className="text-sm text-muted-foreground">Last 7 days of household notification history.</p>
        </div>
        {activeVisibleCount > 0 && (
          <Button onClick={handleDismissVisible} className="sm:self-center">
            <CheckCheck className="mr-2 h-4 w-4" />
            Dismiss visible
          </Button>
        )}
      </div>

      <div className="mb-5 flex gap-2 overflow-x-auto pb-2">
        {filterOptions.map((filter) => (
          <Button
            key={filter.value}
            type="button"
            variant={activeFilter === filter.value ? "default" : "outline"}
            size="sm"
            className="shrink-0"
            onClick={() => setActiveFilter(filter.value)}
          >
            {filter.label}
          </Button>
        ))}
      </div>

      {isLoading ? (
        <Card>
          <CardContent className="flex items-center justify-center gap-2 p-8 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading notification history...
          </CardContent>
        </Card>
      ) : error ? (
        <Card>
          <CardContent className="p-8 text-center text-sm text-destructive">{error}</CardContent>
        </Card>
      ) : filteredNotifications.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center gap-2 p-8 text-center text-sm text-muted-foreground">
            <Bell className="h-6 w-6" />
            No notifications match this filter.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {filteredNotifications.map((notification) => (
            <NotificationCenterItem
              key={notification.id}
              notification={notification}
              isRead={currentUser?.uid ? isNotificationReadBy(notification, currentUser.uid) : false}
              isDismissed={currentUser?.uid ? isNotificationDismissedBy(notification, currentUser.uid) : false}
              onDismiss={(id) => dismissNotifications([id])}
              onOpen={handleOpenNotification}
            />
          ))}
        </div>
      )}
    </div>
  );
}
