/**
 * NO-9: a push opens its link with the notification's ID as `?n=<id>` (added by
 * the service worker, `pushOpenLink` in functions/src/shared/push-link.ts). The
 * page that opens marks that notification read for the member and removes the
 * parameter from the address. Pure.
 */
export const OPENED_NOTIFICATION_PARAM = 'n';

const ID = /^[A-Za-z0-9_-]{1,200}$/;

/** The opened notification's ID from a URL search string, or null. */
export function openedNotificationId(search: string): string | null {
  const value = new URLSearchParams(search).get(OPENED_NOTIFICATION_PARAM);
  return value && ID.test(value) ? value : null;
}

/** The same URL (path, other parameters, hash) without the `n` parameter. */
export function withoutOpenedNotification(href: string): string {
  const url = new URL(href);
  url.searchParams.delete(OPENED_NOTIFICATION_PARAM);
  return `${url.pathname}${url.search}${url.hash}`;
}
