# Notifications, Reminders, and Push Delivery

## Purpose and Scope

This module owns household notification records, bell/history presentation, per-user read/dismiss state, FCM subscription and delivery, foreground/background handling, and deep-link navigation. Feature modules own the events and due calculations that create records.

## User-Facing Capabilities

- View recent active notifications from the header bell, grouped into Today, This week and Earlier. The bell is named "Notifications" (with the unread count), rings briefly and pops its badge when a new unread notification arrives, and shows an "All caught up" illustration when empty.
- Open seven-day history at `/notifications`, grouped into Today, This week and Earlier. Cards show the title, message, age, a plain-language source ("Home maintenance", "Warranty", "Chore assignment", "New member"...) and who dismissed or completed it; internal source names and expiry stamps are never shown.
- An empty Unread filter shows the shared `EmptyState` (notifications illustration, "All caught up" with a friendly line that stays the same all day); other empty filters offer "Show all".
- On a hovering pointer, a card's dismiss button appears on hover or when the card has keyboard focus; on touch, swipe left to dismiss.
- Filter unread, all, dismissed, and feature categories.
- Mark a notification read by opening it.
- Dismiss one or all active notifications without deleting history.
- Follow supported deep links to source pages.
- Enable/disable browser push notifications from Profile.
- See the unread count as a badge on the installed app's home-screen or taskbar icon where the browser supports the Badging API.

## Entry Points

- `src/app/notifications/page.tsx`
- `src/components/notification-center-client.tsx`
- `src/components/notification-bell.tsx`
- `src/components/PushNotificationManager.tsx`
- `src/components/PushNotificationSettings.tsx`
- `src/app/api/sw/route.ts`
- `src/lib/service-worker.ts`
- `src/hooks/use-app-badge.ts`
- `src/lib/notifications.ts`
- `src/lib/dashboard/notification-display.ts` (date groups, source labels, the caught-up line)
- `functions/src/index.ts`
- Notification types in `src/lib/types.ts`

## Architecture and Data Flow

Feature code creates household notification documents with `buildNotificationDocument`. Bell and center queries parse legacy/current shapes, merge duplicate semantic identities for presentation, filter per-user target/read/dismiss state, and write only the current UID's map entries. Mobile cards reserve horizontal pointer movement while preserving vertical pan, and track drag position synchronously so a fast swipe can dismiss reliably. Gesture capture ignores the desktop dismiss button so pointer capture cannot swallow its click.

Presentation helpers in `src/lib/dashboard/notification-display.ts` group items by local day (`today` since local midnight, `week` for the six days before, `earlier`) and map `sourceType` values to plain labels (unknown values show nothing rather than the raw name). Bell ring and badge pop are CSS animations from `src/components/dashboard/dashboard.module.css`, keyed so they replay only when the unread count increases after the first load; both are removed under reduced motion. Load failures in the center show `friendlyError` text; dismiss failures use `toastError`.

A Firestore create trigger resolves recipients, sends FCM, and removes invalid registration tokens. Foreground messages become toasts. `/api/sw` serves HomeHub's single service worker: Firebase Messaging background display and deep-link clicks, plus the offline app shell owned by [Application Shell and Dashboard](../application-shell/README.md). Production builds register it on every page load through `PushNotificationManager`; `PushNotificationSettings` registers the same URL and scope (`src/lib/service-worker.ts`) on push opt-in and so receives the same registration for `getToken`. Background notifications use `/icons/icon-192.png` when the payload has no icon. If the Firebase scripts cannot be imported (CDN blocked or offline at install), the worker still installs without push and retries on its next update.

`NotificationBell` passes its unread count to `useAppBadge`, which calls `navigator.setAppBadge(count)` (or `clearAppBadge()` at zero) when the Badging API exists. The badge is left unchanged while notifications are loading or failed to load, and cleared when the bell unmounts (sign-out, or loss of `notifications.view`). The badge updates only while HomeHub is open; push messages received in the background do not change it.

## Data Model and Persistence

- Notifications: `households/{householdId}/notifications/{notificationId}`.
- Push tokens: `users/{email}.fcmTokens`.
- `users/{email}/notifications/{notificationId}` is a legacy inbox: its owner may read, update and delete it, and rules deny creation by anyone.

`Notification`, `NotificationCategory`, `NotificationUserAction`, and `NotificationUserActionMap` define categories, source/deep-link fields, optional `stateKey`, targeting, UID-keyed `readBy`/`dismissedBy`, and optional resolution metadata. `expiresAt` defaults to seven days after `createdAt`; parsing supplies that fallback for older records.

## Authentication, Roles, and Security

Approved household members can read household notification documents. Rule updates permit only the caller UID key in `readBy` and `dismissedBy`; deletion is denied. Maintenance records may also update `resolvedAt`/`resolvedBy`.

`notifications.view` controls navigation, but `notifications.dismiss` is not checked by the notification UI/rules. Action-map keys are UID-restricted, but rules do not validate email/display-name values inside the action object.

Creation rules require an approved sender, the household's own `householdId`, Timestamp `createdAt`/`expiresAt`, a known category, bounded title/message, an allow-listed set of fields, a `/`-relative `deepLink` (no scheme, no `//`), and targets that belong to the household (a `targetUserUid` membership record; a `targetUserEmail` profile pointing at the household). The push function independently re-validates targets and links.

## Integrations and Background Processing

- FCM web config uses `NEXT_PUBLIC_FIREBASE_*` and `NEXT_PUBLIC_FIREBASE_VAPID_KEY`.
- Cloud Function `sendPushOnNewNotification` runs on notification creation.
- The push function re-validates every document: it ignores documents whose `householdId` does not match their path, loads the household's membership records, and pushes only to approved active members. A `targetUserUid`/`targetUserEmail` that is not an approved member receives nothing; untargeted notifications go to approved members only (never pending joiners). Links are reduced to `/`-relative in-app paths, and title/body are bounded (`functions/src/push-policy.ts`, tested in `tests/server/push-policy.test.ts`).
- Reminders are never written by browser code: there is no per-minute timer on Chores and no synchronization when Maintenance opens. Opening Chores does call the server-side `syncHouseholdUpkeep` action, which runs the full upkeep step (recurring chores, retention, maintenance and chore reminders) on demand. Direct Temporary Task creation writes one deterministic targeted assignment notification in the same batch as its chore.
- Pending-member reminders are client-triggered after 24 hours.
- Maintenance and chore reminders are scheduled server-side. The hourly `householdUpkeep` Cloud Function (`functions/src/index.ts` → `functions/src/reminders.ts`) runs the same idempotent step for every household; the Chores page also runs it on demand through `syncHouseholdUpkeep` (`src/app/chores/actions.ts`, authorized by `chores.view`) on each load so a new recurring assignment appears immediately. Maintenance Center computes its due/overdue list locally from the same shared rules (`functions/src/shared/maintenance-reminders.ts`) for display only and writes no reminder notifications.
- Physical expiration: a Firestore TTL policy on collection group `notifications`, field `expiresAt`, deletes documents after they expire (Firestore usually acts within a day). It is versioned in `firestore.indexes.json` (`fieldOverrides`, `ttl: true`, with the field's default single-field indexes) and deployed by the release workflow. Nothing visible is lost: `expiresAt` is seven days after `createdAt`, and the bell and center only list the last seven days by `createdAt`. Still-overdue maintenance reminders are re-surfaced by hourly upkeep before they expire. Legacy `users/{email}/notifications` documents have no `expiresAt` and are not affected.

## Cross-Module Dependencies

The homepage overview counts only active notifications visible to the verified user, respecting UID/email targeting, expiration, dismissal, resolution, and read state. It sends at most five bounded maintenance/system titles to the optional narrative.

- [Chores](../chores/README.md), [Maintenance Center](../maintenance-center/README.md), and [Household Governance](../household-governance/README.md) create records.
- [Identity and Profile](../identity-profile/README.md) stores FCM tokens.
- [Application Shell and Dashboard](../application-shell/README.md) mounts bell/foreground handlers and owns the offline half of the shared service worker.
- [Firebase Platform](../firebase-platform/README.md) owns Functions and rules.

## Invariants and Failure Behavior

- Notification UI never displays `sourceType`, `stateKey` or `expiresAt` values directly.

- Bell queries the last seven days, reads at most 30 records, and displays up to 10 active unresolved/undismissed items.
- Center hides expired records and supports system/general records under broad filters, but has no dedicated system/general category filter.
- Dismissal is per user and does not delete the record.
- Deterministic maintenance identity is `(sourceType, sourceId, stateKey)`; `stateKey` changes only for a meaningful due-state/date/mileage cycle change.
- Deleting a maintenance asset or vehicle resolves its active schedule and expiration reminders from a fresh notification snapshot; unrelated notification history remains intact.
- Bell and center presentation deduplicate legacy documents with the same semantic source while merging read, dismiss, and resolution history.
- Reminders appear without anyone opening a page; IDs are deterministic, so overlapping runs never duplicate.
- Push recipients come from the household's membership records: a notification targeted by `targetUserUid` (or `targetUserEmail`) goes only to that approved member, an untargeted one to every approved member, never to pending or former members. Each recipient's profile is then read directly by email (`users/{email}`) for its FCM tokens; no `users.uid` query is involved, so profiles without a stored `uid` still receive pushes.
- New-member approval notifications are targeted at each active owner/admin.

## Validation

- Run `npm.cmd run lint`, `npm.cmd run typecheck`, and relevant functions lint/build after implementation changes.
- Run `npm.cmd run test:e2e:local` for deterministic read, unread, dismissed, system, shopping, and maintenance notification fixtures in desktop/mobile views.
- Manually test own-UID read/dismiss updates, dismiss-all scope, seven-day filtering, deep links, foreground/background delivery, denied permission, invalid-token cleanup, and target/broadcast recipients.
- Verify expired records with and without TTL and test cross-household access/targeting.

Unit coverage for grouping and source labels lives in `tests/unit/dashboard-ambience.test.ts`; `tests/e2e/dashboard-shell.spec.ts` checks the center shows no internal names or expiry stamps.

## When This Document Must Be Updated

Update this README when notification fields/paths/categories, filters, read/dismiss/resolution rules, reminder generators, FCM token handling, recipient selection, service-worker behavior, deep links, retention, or TTL setup changes.
