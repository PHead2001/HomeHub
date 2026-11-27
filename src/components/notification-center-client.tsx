"use client";

import { useEffect, useMemo, useState } from "react";
import type React from "react";
import Link from "next/link";
import { format, formatDistance } from "date-fns";
import { CheckCheck, Clock, ExternalLink, Loader2, MailCheck, X } from "lucide-react";
import { collection, doc, onSnapshot, updateDoc } from "firebase/firestore";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { useAuth } from "@/hooks/use-auth";
import { useReducedMotion } from "@/hooks/use-reduced-motion";
import { swipeCursorClass, useSwipeDismiss } from "@/app/notifications/swipe-dismiss";
import { useDismissNotifications } from "@/app/notifications/use-dismiss-notifications";
import { useMarkRead } from "@/app/notifications/use-mark-read";
import { useNow } from "@/hooks/use-now";
import { db } from "@/lib/firebase";
import type { Notification, NotificationCategory } from "@/lib/types";
import { cn } from "@/lib/utils";
import { EmptyState } from "@/components/empty-state";
import { NumberTicker } from "@/components/motion/number-ticker";
import { Stagger } from "@/components/motion/stagger";
import { PeekCard, PeekFacts } from "@/components/ui/peek-link";
import { canSeeCategory } from "@functions/shared/push-audience";
import { categoriesKey, notificationWindowQuery, viewableNotificationCategories } from "@/app/notifications/notification-query";
import { friendlyError } from "@/lib/friendly-error";
import { publicDisplayName } from "@/lib/member-directory";
import {
  CENTER_PAGE_SIZE,
  caughtUpLine,
  groupNotifications,
  matchesNotificationFilter,
  notificationDestination,
  notificationFilterOptions,
  notificationSourceLabel,
  type NotificationFilter,
} from "@/lib/dashboard/notification-display";
import type { NotificationUserAction } from "@/lib/types";
import {
  createNotificationAction,
  deduplicateNotifications,
  getNotificationLink,
  isNotificationDismissedBy,
  isNotificationExpired,
  isNotificationReadBy,
  isNotificationVisibleToUser,
  notificationCategoryLabels,
  notificationSince,
  parseNotificationDoc,
} from "@/lib/notifications";

const getActionName = (action?: NotificationUserAction) => {
  // Never the email, which older entries may still hold.
  if (action?.displayName) return publicDisplayName(action.displayName, "Household member");
  return action?.uid || action?.email ? "Household member" : null;
};

function NotificationCenterItem({
  notification,
  isRead,
  isDismissed,
  canDismiss,
  now,
  onDismiss,
  onOpen,
}: {
  notification: Notification;
  isRead: boolean;
  isDismissed: boolean;
  /** NO-8: dismissing needs notifications.dismiss (guests only read). */
  canDismiss: boolean;
  now: Date;
  onDismiss: (id: string) => void;
  onOpen: (notification: Notification, event: React.MouseEvent<HTMLElement>) => void;
}) {
  const reducedMotion = useReducedMotion();
  // The wrapper and the link never move (they are the hit targets); only the
  // card's visual layer slides, so a tap always lands where it was aimed.
  const swipe = useSwipeDismiss({
    disabled: isDismissed || !canDismiss,
    reducedMotion,
    onDismiss: () => onDismiss(notification.id),
  });

  // NO-11: dismissal is per person, so only the viewer's own is shown.
  const resolvedName = getActionName(notification.resolvedBy);
  const hasDeepLink = getNotificationLink(notification) !== "#";
  const sourceLabel = notificationSourceLabel(notification.sourceType);

  const destination = notificationDestination(getNotificationLink(notification));
  // Peek (H26): the exact time and where the link goes, beyond the card's relative time.
  const peek = (
    <PeekFacts
      title={notification.title || "HomeHub"}
      facts={[
        ["When", format(notificationSince(notification), "EEE d MMM, p")],
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
      className={cn(
        "group relative overflow-hidden rounded-lg border bg-background",
        !isDismissed && "touch-pan-y",
        // NO-20: the grab cursor only where a swipe works (touch).
        swipeCursorClass(!isDismissed && canDismiss, swipe.dragging),
      )}
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
      {hasDeepLink ? (
      <Link
        href={getNotificationLink(notification)}
        onClick={(event) => onOpen(notification, event)}
        className="relative block"
        draggable={false}
      >
        <div
          data-swipe-visual
          className={cn("bg-background p-4", canDismiss && !isDismissed && "pr-14", isDismissed && "bg-muted/40")}
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
              <h3 className={cn("font-headline text-base font-semibold leading-tight", isDismissed && "text-muted-foreground")}>{notification.title || "HomeHub"}</h3>
              {hasDeepLink && <ExternalLink aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />}
            </div>
            <p className="text-sm text-muted-foreground">{notification.message}</p>
          </div>
          <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1">
              <Clock aria-hidden className="h-3 w-3" />
              {formatDistance(notificationSince(notification), now, { addSuffix: true })}
            </span>
            {sourceLabel && <span>{sourceLabel}</span>}
            {isDismissed && <span>You dismissed this</span>}
            {resolvedName && <span>Completed by {resolvedName}</span>}
          </div>
        </div>
      </Link>
      ) : (
        // NO-11, NO-20: nothing to open, so a button that marks it read, never a link to "#".
        <button type="button" onClick={(event) => onOpen(notification, event)} className="relative block w-full text-left">
        <div
          data-swipe-visual
          className={cn("bg-background p-4", canDismiss && !isDismissed && "pr-14", isDismissed && "bg-muted/40")}
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
              <h3 className={cn("font-headline text-base font-semibold leading-tight", isDismissed && "text-muted-foreground")}>{notification.title || "HomeHub"}</h3>
              {hasDeepLink && <ExternalLink aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />}
            </div>
            <p className="text-sm text-muted-foreground">{notification.message}</p>
          </div>
          <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1">
              <Clock aria-hidden className="h-3 w-3" />
              {formatDistance(notificationSince(notification), now, { addSuffix: true })}
            </span>
            {sourceLabel && <span>{sourceLabel}</span>}
            {isDismissed && <span>You dismissed this</span>}
            {resolvedName && <span>Completed by {resolvedName}</span>}
          </div>
        </div>
        </button>
      )}
      {!isDismissed && canDismiss && (
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
  const markRead = useMarkRead();
  const canDismiss = Boolean(permissions['notifications.dismiss']);
  const now = useNow();
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [activeFilter, setActiveFilter] = useState<NotificationFilter>("unread");
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // NO-21: the center reads a page at a time; Load more widens the window.
  const [pageSize, setPageSize] = useState(CENTER_PAGE_SIZE);
  const [hasMore, setHasMore] = useState(false);
  // NO-18: only the categories this member may see, plus Household (NO-13).
  const filterOptions = useMemo(() => notificationFilterOptions((permission) => Boolean(permissions[permission])), [permissions]);
  // Same category filter as the bell, applied in the query.
  const viewKey = categoriesKey(viewableNotificationCategories((permission) => Boolean(permissions[permission])));

  useEffect(() => {
    if (!currentUser?.householdId || !currentUser.uid) {
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
      currentUser.uid,
      sevenDaysAgo,
      categories,
      pageSize,
    );

    const unsubscribe = onSnapshot(
      notificationsQuery,
      (snapshot) => {
        setNotifications(deduplicateNotifications(snapshot.docs.map(parseNotificationDoc)));
        setHasMore(snapshot.size >= pageSize);
        setIsLoading(false);
      },
      (loadError) => {
        setError(friendlyError(loadError));
        setIsLoading(false);
      }
    );

    return () => unsubscribe();
  }, [currentUser?.householdId, currentUser?.uid, viewKey, pageSize]);

  const validNotifications = useMemo(() => {
    return notifications.filter((notification) => !isNotificationExpired(notification, now));
  }, [notifications, now]);

  const filteredNotifications = useMemo(() => {
    if (!currentUser?.uid || !currentUser.email) return [];

    return validNotifications.filter((notification) => {
      if (!isNotificationVisibleToUser(notification, currentUser)) return false;
      // A module's notifications need that module's view permission (as pushes do).
      if (!canSeeCategory(notification.category, (permission) => Boolean(permissions[permission]))) return false;

      // NO-7: a resolved notification (a dose already given) is not unread.
      return matchesNotificationFilter(notification, activeFilter, currentUser.uid);
    });
  }, [activeFilter, currentUser, permissions, validNotifications]);

  const handleDismissVisible = () => {
    if (!currentUser?.uid) return;
    const activeVisibleIds = filteredNotifications
      .filter((notification) => !isNotificationDismissedBy(notification, currentUser.uid))
      .map((notification) => notification.id);
    void dismissNotifications(activeVisibleIds);
  };

  const handleOpenNotification = async (notification: Notification, event: React.MouseEvent<HTMLElement>) => {
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
      && !notification.resolvedAt
      && !isNotificationReadBy(notification, currentUser.uid)).length;
  }, [currentUser, permissions, validNotifications]);

  const activeVisibleCount = currentUser?.uid
    ? filteredNotifications.filter((notification) => !isNotificationDismissedBy(notification, currentUser.uid)).length
    : 0;

  // NO-14: every unread notification this member can see, whatever the filter.
  const unreadIds = useMemo(() => {
    if (!currentUser?.uid || !currentUser.email) return [];
    return validNotifications.filter((notification) =>
      isNotificationVisibleToUser(notification, currentUser)
      && canSeeCategory(notification.category, (permission) => Boolean(permissions[permission]))
      && matchesNotificationFilter(notification, "unread", currentUser.uid)).map((notification) => notification.id);
  }, [currentUser, permissions, validNotifications]);

  return (
    // NO-16: a readable column on wide screens, with the dismiss button close to the text.
    <div className="container mx-auto max-w-3xl px-4 py-6 md:py-8">
      <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="font-headline text-2xl font-bold tracking-tight md:text-3xl">Notification Center</h1>
          <p className="text-sm text-muted-foreground">Your notifications and the household&apos;s from the last 7 days.</p>
        </div>
        <div className="flex flex-wrap gap-2 sm:self-center">
          {unreadIds.length > 0 && (
            <Button variant="outline" onClick={() => void markRead(unreadIds)}>
              <MailCheck className="mr-2 h-4 w-4" aria-hidden />
              Mark all read
            </Button>
          )}
          {canDismiss && activeVisibleCount > 0 && (
            <Button onClick={handleDismissVisible}>
              <CheckCheck className="mr-2 h-4 w-4" />
              Dismiss visible
            </Button>
          )}
        </div>
      </div>

      {/* NO-16: the chips stay in reach while scrolling, and a fade shows there are more to the side. */}
      <div
        className="sticky top-0 z-10 -mx-4 mb-5 flex gap-2 overflow-x-auto bg-background/95 px-4 pb-2 pt-1 backdrop-blur [mask-image:linear-gradient(to_right,black_calc(100%-2rem),transparent)] sm:[mask-image:none]"
        role="group"
        aria-label="Filter notifications"
        data-testid="notification-filters"
      >
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
            <EmptyState kind="notifications" title="All caught up" description={caughtUpLine(now)} />
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
          {groupNotifications(filteredNotifications, now).map((group) => (
            <section key={group.id} aria-labelledby={`notification-group-${group.id}`}>
              <h2 id={`notification-group-${group.id}`} className="mb-2 text-sm font-medium text-muted-foreground">{group.label}</h2>
              {/* Keyed by filter, so switching filters plays the entrance again. */}
              <Stagger key={activeFilter} className="space-y-3">
                {group.items.map((notification) => (
                    <NotificationCenterItem
                      now={now}
                      key={notification.id}
                      notification={notification}
                      isRead={currentUser?.uid ? isNotificationReadBy(notification, currentUser.uid) : false}
                      isDismissed={currentUser?.uid ? isNotificationDismissedBy(notification, currentUser.uid) : false}
                      canDismiss={canDismiss}
                      onDismiss={(id) => dismissNotifications([id])}
                      onOpen={handleOpenNotification}
                    />
                ))}
              </Stagger>
            </section>
          ))}
        </div>
      )}
      {!isLoading && !error && hasMore && (
        <div className="mt-6 flex justify-center">
          <Button variant="outline" onClick={() => setPageSize((size) => size + CENTER_PAGE_SIZE)} data-testid="notification-load-more">
            Load more
          </Button>
        </div>
      )}
    </div>
  );
}
