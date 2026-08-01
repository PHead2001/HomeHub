# Notifications, Reminders, and Push Delivery

## Purpose and Scope

This module owns household notification records, bell/history presentation, per-user read/dismiss state, FCM subscription and delivery, foreground/background handling, and deep-link navigation. Feature modules own the events and due calculations that create records.

## User-Facing Capabilities

- View recent active notifications from the header bell.
- Open seven-day history at `/notifications`.
- Filter unread, all, dismissed, and feature categories.
- Mark a notification read by opening it.
- Dismiss one or all active notifications without deleting history.
- Follow supported deep links to source pages.
- Enable/disable browser push notifications from Profile.

## Entry Points

- `src/app/notifications/page.tsx`
- `src/components/notification-center-client.tsx`
- `src/components/notification-bell.tsx`
- `src/components/PushNotificationManager.tsx`
- `src/components/PushNotificationSettings.tsx`
- `src/app/api/sw/route.ts`
- `src/lib/notifications.ts`
- `functions/src/index.ts`
- Notification types in `src/lib/types.ts`

## Architecture and Data Flow

Feature code creates household notification documents with `buildNotificationDocument`. Bell and center queries parse legacy/current shapes, merge duplicate semantic identities for presentation, filter per-user target/read/dismiss state, and write only the current UID's map entries. Mobile cards reserve horizontal pointer movement while preserving vertical pan, and track drag position synchronously so a fast swipe can dismiss reliably. Gesture capture ignores the desktop dismiss button so pointer capture cannot swallow its click.

A Firestore create trigger resolves recipients, sends FCM, and removes invalid registration tokens. Foreground messages become toasts. `/api/sw` serves a Firebase Messaging service worker for background display and deep-link clicks.

## Data Model and Persistence

- Notifications: `households/{householdId}/notifications/{notificationId}`.
- Push tokens: `users/{email}.fcmTokens`.
- Legacy rules remain for `users/{email}/notifications/{notificationId}`, but no current writer was found.

`Notification`, `NotificationCategory`, `NotificationUserAction`, and `NotificationUserActionMap` define categories, source/deep-link fields, optional `stateKey`, targeting, UID-keyed `readBy`/`dismissedBy`, and optional resolution metadata. `expiresAt` defaults to seven days after `createdAt`; parsing supplies that fallback for older records.

## Authentication, Roles, and Security

Approved household members can read household notification documents. Rule updates permit only the caller UID key in `readBy` and `dismissedBy`; deletion is denied. Maintenance records may also update `resolvedAt`/`resolvedBy`.

`notifications.view` controls navigation, but `notifications.dismiss` is not checked by the notification UI/rules. Action-map keys are UID-restricted, but rules do not validate email/display-name values inside the action object.

Creation rules do not verify that optional target UID/email belongs to the household. The Admin SDK push function trusts targeting fields.

## Integrations and Background Processing

- FCM web config uses `NEXT_PUBLIC_FIREBASE_*` and `NEXT_PUBLIC_FIREBASE_VAPID_KEY`.
- Cloud Function `sendPushOnNewNotification` runs on notification creation.
- Recipient order is target email, then target UID query, otherwise legacy `households.memberEmails`.
- Chore checks run every minute while Chores is mounted. Direct Temporary Task creation writes one deterministic targeted assignment notification in the same batch as its chore.
- Maintenance synchronization runs when Maintenance opens.
- Pending-member reminders are client-triggered after 24 hours.
- No scheduled reminder or cleanup function exists.
- Physical expiration requires manual Firestore TTL configuration on collection group `notifications`, field `expiresAt`.

## Cross-Module Dependencies

- [Chores](../chores/README.md), [Maintenance Center](../maintenance-center/README.md), and [Household Governance](../household-governance/README.md) create records.
- [Identity and Profile](../identity-profile/README.md) stores FCM tokens.
- [Application Shell and Dashboard](../application-shell/README.md) mounts bell/foreground handlers.
- [Firebase Platform](../firebase-platform/README.md) owns Functions and rules.

## Invariants and Failure Behavior

- Bell queries the last seven days, reads at most 30 records, and displays up to 10 active unresolved/undismissed items.
- Center hides expired records and supports system/general records under broad filters, but has no dedicated system/general category filter.
- Dismissal is per user and does not delete the record.
- Deterministic maintenance identity is `(sourceType, sourceId, stateKey)`; `stateKey` changes only for a meaningful due-state/date/mileage cycle change.
- Deleting a maintenance asset or vehicle resolves its active schedule and expiration reminders from a fresh notification snapshot; unrelated notification history remains intact.
- Bell and center presentation deduplicate legacy documents with the same semantic source while merging read, dismiss, and resolution history.
- Reminders are absent until a relevant client page runs its generator.
- UID-only push targeting queries `users.uid`, while current profile creation does not consistently persist a `uid` field.
- Untargeted governance notifications broadcast through legacy member emails.

## Validation

- Run `npm.cmd run lint`, `npm.cmd run typecheck`, and relevant functions lint/build after implementation changes.
- Run `npm.cmd run test:e2e:local` for deterministic read, unread, dismissed, system, shopping, and maintenance notification fixtures in desktop/mobile views.
- Manually test own-UID read/dismiss updates, dismiss-all scope, seven-day filtering, deep links, foreground/background delivery, denied permission, invalid-token cleanup, and target/broadcast recipients.
- Verify expired records with and without TTL and test cross-household access/targeting.

## When This Document Must Be Updated

Update this README when notification fields/paths/categories, filters, read/dismiss/resolution rules, reminder generators, FCM token handling, recipient selection, service-worker behavior, deep links, retention, or TTL setup changes.
