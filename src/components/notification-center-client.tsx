"use client";

import { useEffect, useMemo, useState } from "react";
import type React from "react";
import Link from "next/link";
import { format, formatDistanceToNow } from "date-fns";
import { CheckCheck, Clock, ExternalLink, Loader2, X } from "lucide-react";
import { collection, doc, onSnapshot, updateDoc } from "firebase/firestore";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { useAuth } from "@/hooks/use-auth";
import { useReducedMotion } from "@/hooks/use-reduced-motion";
import { useSwipeDismiss } from "@/app/notifications/swipe-dismiss";
import { useDismissNotifications } from "@/app/notifications/use-dismiss-notifications";
import { db } from "@/lib/firebase";
import type { Notification, NotificationCategory, NotificationUserAction } from "@/lib/types";
import { cn } from "@/lib/utils";
import { EmptyState } from "@/components/empty-state";
import { NumberTicker } from "@/components/motion/number-ticker";
import { Stagger } from "@/components/motion/stagger";
import { PeekCard, PeekFacts } from "@/components/ui/peek-link";
import { canSeeCategory } from "@functions/shared/push-audience";
import { categoriesKey, notificationWindowQuery, viewableNotificationCategories } from "@/app/notifications/notification-query";
import { friendlyError } from "@/lib/friendly-error";
import { publicDisplayName } from "@/lib/member-directory";
import { caughtUpLine, groupNotifications, notificationDestination, notificationSourceLabel } from "@/lib/dashboard/notification-display";
import {
  createNotificationAction,
  deduplicateNotifications,
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
  // Never the email, which older entries may still hold.
  if (action?.displayName) return publicDisplayName(action.displayName, "Household member");
  return action?.uid || action?.email ? "Household member" : null;
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
  const reducedMotion = useReducedMotion();
  // The wrapper and the link never move (they are the hit targets); only the
  // card's visual layer slides, so a tap always lands where it was aimed.
  const swipe = useSwipeDismiss({
    disabled: isDismissed,
    reducedMotion,
    onDismiss: () => onDismiss(notification.id),
  });

  const dismissedAction = Object.values(notification.dismissedBy)[0];
  const resolvedName = getActionName(notification.resolvedBy);
  const dismissedName = getActionName(dismissedAction);
  const hasDeepLink = getNotificationLink(notification) !== "#";
  const sourceLabel = notificationSourceLabel(notification.sourceType);

  const destination = notificationDestination(getNotificationLink(notification));
  // Peek (H26): the exact time and where the link goes, beyond the card's relative time.
  const peek = (
    <PeekFacts
      title={notification.title || "HomeHub"}
      facts={[
        ["When", format(notification.createdAt, "EEE d MMM, p")],
        ...(destination ? [["Opens", destination] as [string, string]] : []),
        ...(resolvedName ? [["Completed by", resolvedName] as [string, string]] : []),
      ]}
    />
  );

  return (
    <PeekCard peek={peek}>
    <div
      {...swipe.handlers}
      data-testid="notification-card"
      className={cn("group relative overflow-hidden rounded-lg border bg-background", !isDismissed && "touch-pan-y")}
      style={{ cursor: isDismissed ? "default" : (swipe.dragging ? "grabbing" : "grab") }}
    >
      <div
        aria-hidden
        // Behind the sliding card; with reduced motion the card stays put, so
        // the hint fades in over it instead.
        className={cn("pointer-events-none absolute inset-0 flex items-center justify-end bg-muted pr-5 text-muted-foreground", reducedMotion && "z-10")}
        style={{ opacity: swipe.hintOpacity }}
      >
        <X className="h-5 w-5" />
      </div>
      <Link
        href={getNotificationLink(notification)}
        onClick={(event) => onOpen(notification, event)}
        className="relative block"
        draggable={false}
      >
        <div
          data-swipe-visual
          className={cn("bg-background p-4 pr-12", isDismissed && "opacity-70")}
          style={swipe.visualStyle}
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
              <h3 className="font-headline text-base font-semibold leading-tight">{notification.title || "HomeHub"}</h3>
              {hasDeepLink && <ExternalLink aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />}
            </div>
            <p className="text-sm text-muted-foreground">{notification.message}</p>
          </div>
          <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1">
              <Clock aria-hidden className="h-3 w-3" />
              {formatDistanceToNow(notification.createdAt, { addSuffix: true })}
            </span>
            {sourceLabel && <span>{sourceLabel}</span>}
            {dismissedName && <span>Dismissed by {dismissedName}</span>}
            {resolvedName && <span>Completed by {resolvedName}</span>}
          </div>
        </div>
      </Link>
      {!isDismissed && (
        // The button alternative to swiping. Hover pointers reveal it on hover
        // or keyboard focus; touch screens always show it.
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className={cn(
            "absolute right-2 top-1/2 hidden h-8 w-8 -translate-y-1/2 text-muted-foreground hover:text-foreground group-hover:flex group-focus-within:flex [@media(pointer:coarse)]:flex",
            swipe.engaged && "opacity-0",
          )}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onDismiss(notification.id);
          }}
        >
          <X className="h-4 w-4" />
          <span className="sr-only">Dismiss {notification.title || "HomeHub notification"}</span>
        </Button>
      )}
    </div>
    </PeekCard>
  );
}

export function NotificationCenterClient() {
  const { currentUser, permissions } = useAuth();
  const dismissNotifications = useDismissNotifications();
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [activeFilter, setActiveFilter] = useState<NotificationFilter>("unread");
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Same category filter as the bell, applied in the query.
  const viewKey = categoriesKey(viewableNotificationCategories((permission) => Boolean(permissions[permission])));

  useEffect(() => {
    if (!currentUser?.householdId) {
      setNotifications([]);
      setIsLoading(false);
      return;
    }

    setIsLoading(true);
    setError(null);
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const categories = viewKey === "*" ? null : (viewKey.split(",") as NotificationCategory[]);
    const notificationsQuery = notificationWindowQuery(
      collection(db, "households", currentUser.householdId, "notifications"),
      sevenDaysAgo,
      categories,
    );

    const unsubscribe = onSnapshot(
      notificationsQuery,
      (snapshot) => {
        setNotifications(deduplicateNotifications(snapshot.docs.map(parseNotificationDoc)));
        setIsLoading(false);
      },
      (loadError) => {
        setError(friendlyError(loadError));
        setIsLoading(false);
      }
    );

    return () => unsubscribe();
  }, [currentUser?.householdId, viewKey]);

  const validNotifications = useMemo(() => {
    return notifications.filter((notification) => !isNotificationExpired(notification));
  }, [notifications]);

  const filteredNotifications = useMemo(() => {
    if (!currentUser?.uid || !currentUser.email) return [];

    return validNotifications.filter((notification) => {
      if (!isNotificationVisibleToUser(notification, currentUser)) return false;
      // A module's notifications need that module's view permission (as pushes do).
      if (!canSeeCategory(notification.category, (permission) => Boolean(permissions[permission]))) return false;

      const isDismissed = isNotificationDismissedBy(notification, currentUser.uid);
      const isRead = isNotificationReadBy(notification, currentUser.uid);

      if (activeFilter === "unread") return !isRead && !isDismissed;
      if (activeFilter === "all") return true;
      if (activeFilter === "dismissed") return isDismissed;
      return notification.category === activeFilter;
    });
  }, [activeFilter, currentUser, permissions, validNotifications]);

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

  const unreadCount = useMemo(() => {
    if (!currentUser?.uid || !currentUser.email) return 0;
    return validNotifications.filter((notification) =>
      isNotificationVisibleToUser(notification, currentUser)
      && canSeeCategory(notification.category, (permission) => Boolean(permissions[permission]))
      && !isNotificationDismissedBy(notification, currentUser.uid)
      && !isNotificationReadBy(notification, currentUser.uid)).length;
  }, [currentUser, permissions, validNotifications]);

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
            aria-pressed={activeFilter === filter.value}
            onClick={() => setActiveFilter(filter.value)}
          >
            {filter.label}
            {filter.value === "unread" && !isLoading && !error && unreadCount > 0 && (
              <>
                {/* A real space, so the button reads and is named "Unread 3". */}
                {" "}
                <span className="rounded-full bg-background/20 px-1.5 text-xs font-semibold" data-testid="notification-unread-count">
                  <NumberTicker value={unreadCount} animateOnMount={false} />
                </span>
              </>
            )}
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
          <CardContent role="alert" className="p-8 text-center text-sm text-destructive">Could not load notification history. {error}</CardContent>
        </Card>
      ) : filteredNotifications.length === 0 ? (
        <Card>
          {activeFilter === "unread" ? (
            <EmptyState kind="notifications" title="All caught up" description={caughtUpLine(new Date())} />
          ) : (
            <EmptyState
              kind="notifications"
              title="Nothing here"
              description="No notifications match this filter in the last 7 days."
              action={{ label: "Show all", onClick: () => setActiveFilter("all") }}
            />
          )}
        </Card>
      ) : (
        <div className="space-y-6">
          {groupNotifications(filteredNotifications, new Date()).map((group) => (
            <section key={group.id} aria-labelledby={`notification-group-${group.id}`}>
              <h2 id={`notification-group-${group.id}`} className="mb-2 text-sm font-medium text-muted-foreground">{group.label}</h2>
              {/* Keyed by filter, so switching filters plays the entrance again. */}
              <Stagger key={activeFilter} className="space-y-3">
                {group.items.map((notification) => (
                    <NotificationCenterItem
                      key={notification.id}
                      notification={notification}
                      isRead={currentUser?.uid ? isNotificationReadBy(notification, currentUser.uid) : false}
                      isDismissed={currentUser?.uid ? isNotificationDismissedBy(notification, currentUser.uid) : false}
                      onDismiss={(id) => dismissNotifications([id])}
                      onOpen={handleOpenNotification}
                    />
                ))}
              </Stagger>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
