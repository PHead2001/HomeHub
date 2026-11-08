/**
 * The service worker's push-link check. It is the same implementation the
 * Cloud Function uses for `fcmOptions.link` (`safeDeepLink`), defined once in
 * `functions/src/shared/push-link.ts`. `route.ts` embeds its source in the
 * worker script (`safePushLink.toString()`), so it stays self-contained.
 */
export { safePushLink } from '@functions/shared/push-link';
