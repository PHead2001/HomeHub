# Notifications, Reminders, and Push Delivery

## Purpose and Scope

This module owns household notification records, bell/history presentation, per-user read/dismiss state, FCM subscription and delivery, foreground/background handling, and deep-link navigation. Feature modules own the events and due calculations that create records.

## User-Facing Capabilities

- View recent active notifications from the header bell, grouped into Today, This week and Earlier. The bell is named "Notifications" (with the unread count), rings briefly and pops its badge when a new unread notification arrives (the badge's number ticks to the new count with `NumberTicker`; "9+" above nine), and shows an "All caught up" illustration when empty.
- Open seven-day history at `/notifications`, grouped into Today, This week and Earlier. Cards show the title, message, age, a plain-language source ("Home maintenance", "Warranty", "Chore assignment", "New member"...) and who dismissed or completed it; internal source names and expiry stamps are never shown.
- An empty Unread filter shows the shared `EmptyState` (notifications illustration, "All caught up" with a friendly line that stays the same all day); other empty filters offer "Show all".
- On a hovering pointer, a card's dismiss button appears on hover or when the card has keyboard focus. On touch screens (touch, or a pen on a coarse-pointer device) the dismiss button is always shown and swiping a card left dismisses it; a mouse drag does nothing. Only the card's visual layer slides; the card and its link stay in place, so taps land where they were aimed. With reduced motion nothing slides: the dismiss hint fades in over the card and a completed swipe dismisses it in place.
- Every dismissal (swipe, button, Dismiss visible, Dismiss all) shows a toast with Undo for 5 seconds; Undo removes the member's own dismissal. Only one toast shows at a time, so dismissals made within 5 seconds of each other accumulate: the newest toast counts them all ("2 notifications dismissed") and its Undo restores them all. The window runs from the latest dismissal (`src/app/notifications/undo-batch.ts`, one batch per household and member shared by the bell and the center).
- Pushes show the app icon (`/icons/icon-192.png`), a monochrome house badge for the Android status bar (`/icons/badge-96.png`), and, when the notification is about a pet or a product with a photo stored in the household, that photo as the large image.
- Filter unread, all, dismissed, and feature categories. The Unread filter shows the unread count (a `NumberTicker`, same visibility rules as the list). Each group's cards enter staggered (`Stagger`, replayed when the filter changes, instant under reduced motion).
- On a hovering pointer, resting on a Notification Center card (or focusing its link from the keyboard) for 400 ms shows a peek card (`PeekCard`, H26) with the exact time, where the link opens (`notificationDestination`) and who completed it. The peek wraps the whole card, so the card and its link keep their own structure and hit targets; touch never shows it.
- Mark a notification read by opening it.
- Dismiss one or all active notifications without deleting history.
- Follow supported deep links to source pages.
- Enable/disable browser push notifications from Profile.
- See the unread count as a badge on the installed app's home-screen or taskbar icon where the browser supports the Badging API.

## Entry Points

- `src/app/notifications/page.tsx`
- `src/components/notification-center-client.tsx`
- `src/components/notification-bell.tsx`
- `src/app/notifications/swipe-dismiss.ts`, `src/app/notifications/use-dismiss-notifications.tsx`, `src/app/notifications/undo-batch.ts`, `src/app/notifications/notification-query.ts`
- `functions/src/shared/push-media.ts`
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

Feature code creates household notification documents with `buildNotificationDocument`. Bell and center queries parse legacy/current shapes, merge duplicate semantic identities for presentation, filter per-user target/read/dismiss state, and write only the current UID's map entries. Swipe handling lives in `src/app/notifications/swipe-dismiss.ts` (`useSwipeDismiss` plus pure helpers, shared by the bell and the center). Its pointer handlers sit on the card wrapper, which never moves; only the `data-swipe-visual` layer inside the link is translated. Cards keep vertical pan (`touch-pan-y`), capture the pointer only after 6 px of horizontal travel (so a tap still opens the link), swallow the click that ends a swipe (so a swipe that starts on the dismiss button, which sits where a left swipe naturally starts, does not also press it; a tap still does), and dismiss when released at least 70 px left (200 ms slide-out). Dismissals go through `useDismissNotifications` (`src/app/notifications/use-dismiss-notifications.tsx`): one batch sets `dismissedBy.<own uid>`, wrapped in `awaitWriteUnlessOffline`, then a 5-second toast offers Undo, which deletes the same key with `deleteField()`. Both writes change only the caller's own key, which the existing rules allow.

Category queries: for a member who cannot see every module, the bell, center and dashboard tile put the category filter in the Firestore query (`where('category', 'in', viewable)` with `system` and `general` always included; `src/app/notifications/notification-query.ts`), so the bell's 30-item cap counts only notifications they can see and a busy hidden category cannot push theirs out. Full-access members keep the unfiltered query. The filtered query uses the composite index (`category` ASC, `createdAt` DESC) in `firestore.indexes.json`; stored categories are always one of the seven known values.

Category visibility (`functions/src/shared/push-audience.ts`, shared by the push sender, bell, center and dashboard tile): notifications in a module category need that module's view permission (`chores` → `chores.view`, `pets` → `pets.view`, `shopping` → `shopping.view`, `maintenance` → `maintenance.view`, `automation` → `automation.view`); `system` and `general` need none. In the app this uses the member's effective permissions; on the server `memberCanView` mirrors the rules (owner always, explicit override wins, then the role default; a unit test checks it against `getEffectivePermissions` for every role). A member who lacks the permission sees none of that category in the bell, center or unread tile and gets no push for it, not even text.

The bell's active list is `activeBellNotifications` (not expired, visible to the member, allowed by category permission when the caller passes `canView`, unresolved, not dismissed by them, at most 10), applied after `deduplicateNotifications`; the dashboard's unread tile uses the same two steps, so duplicate legacy copies are counted once and a read or dismissal on either copy applies to both. Presentation helpers in `src/lib/dashboard/notification-display.ts` also group items by local day (`today` since local midnight, `week` for the six days before, `earlier`) and map `sourceType` values to plain labels (unknown values show nothing rather than the raw name). Bell ring and badge pop are CSS animations from `src/components/dashboard/dashboard.module.css`, keyed so they replay only when the unread count increases after the first load; both are removed under reduced motion. Load failures in the center show `friendlyError` text; dismiss failures use `toastError`.

A Firestore create trigger resolves recipients, sends FCM, and removes invalid registration tokens. Foreground messages become toasts. `/api/sw` serves HomeHub's single service worker: Firebase Messaging background display and deep-link clicks, plus the offline app shell owned by [Application Shell and Dashboard](../application-shell/README.md). Production builds register it on every page load through `PushNotificationManager`; `PushNotificationSettings` registers the same URL and scope (`src/lib/service-worker.ts`) on push opt-in and so receives the same registration for `getToken`. Background display: when a payload carries a `notification` block, the Messaging SDK shows it itself (with the server's icon, badge, image and tag); the worker's `onBackgroundMessage` then shows the same notification with the same `tag`, which replaces the SDK's copy instead of stacking a second one, and routes clicks to the worker's own handler. That display uses `icon` and `image` from `payload.notification` and `badge` and `tag` from `payload.data`, re-checked in the worker: icons and badges only from this origin's `/icons/`, images only as https Firebase Storage download URLs under `households/` in the configured bucket or image paths on this origin, falling back to `/icons/icon-192.png` and `/icons/badge-96.png`. `notificationclick` opens only `/`-relative in-app paths (the server's `safeDeepLink` rule); anything else opens `/`. If the Firebase scripts cannot be imported (CDN blocked or offline at install), the worker still installs without push and retries on its next update.

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
- The push function re-validates every document: it ignores documents whose `householdId` does not match their path, loads the household's membership records, and pushes only to approved active members. A `targetUserUid`/`targetUserEmail` that is not an approved member receives nothing; untargeted notifications go to approved members only (never pending joiners). Recipients are then limited to members who hold the category's view permission (see category visibility above). Links are reduced to `/`-relative in-app paths, and title/body are bounded (`functions/src/push-policy.ts`, tested in `tests/server/push-policy.test.ts`).
- Push artwork (`functions/src/shared/push-media.ts`): every push sets `webpush.notification.icon` `/icons/icon-192.png`, `badge` `/icons/badge-96.png` (the house glyph from the app icon on transparency) and `tag` (the notification ID); `webpush.data` repeats `tag` and `badge` for the worker. A rich `image` is added only when the notification names a household record with a photo, read with the Admin SDK only under `households/{householdId}` from the trigger path (and only when the document's `householdId` matches it):
  - category `pets`, `sourceType` `pet` or starting `pet-`/`pet_` (for feeding and medication reminders, for example `pet_feeding`): `sourceId` is the pet ID, optionally followed by `:` or `|` and a state key; uses the pet's `photoUrl`.
  - category `shopping`, `sourceType` `shopping_item`: `sourceId` is `listId:itemId`; uses the item's `imageUrl`, else its barcode's library `imageUrl`.
  - category `shopping`, `sourceType` `barcode_library` or `product`: `sourceId` is the barcode; uses the library item's `imageUrl`.
  - The URL is used only if it is an https `firebasestorage.googleapis.com` media download URL for this project's default bucket whose object path is `households/{householdId}/pets/...` (pets) or `households/{householdId}/barcode-library/...` (shopping), with no credentials, port or path tricks, or an image path on the app origin. Placeholders, Open Food Facts and any other host, other buckets, other households and other folders are dropped, as are malformed IDs; any read failure means no image.
  - Recipients who could not open the record in the app (no `pets.view` / `shopping.view`) already get no push for that category; the image check is kept as a second guard and would send such a recipient the push without the image, as a separate multicast. Title and body are unchanged, so a push never reveals more than the notification text plus a picture the recipient can already see.
  - Pet medication reminders (below) use this contract; no generator writes shopping-item notifications yet. Tested in `tests/unit/notifications-push-media.test.ts` and against the emulator in `tests/server/push-media.test.ts`.
- Reminders are never written by browser code: there is no per-minute timer on Chores and no synchronization when Maintenance opens. Opening Chores does call the server-side `syncHouseholdUpkeep` action, which runs the full upkeep step (recurring chores, retention, maintenance and chore reminders) on demand. Direct Temporary Task creation writes one deterministic targeted assignment notification in the same batch as its chore.
- Pending-member reminders are client-triggered after 24 hours.
- Medication reminders: hourly upkeep (`householdUpkeep`, and `syncHouseholdUpkeep` when Chores opens) reads every pet and all of its `medication-logs` and applies the countdown rule of `nextMedication` / `useMedicationCountdownLogs` (`functions/src/shared/medication-reminders.ts`): entries are grouped by trimmed, lower-cased medication name, the most recent entry with a readable `date` decides, and a later dose without a valid `nextDueDate` cancels the countdown. When the due day is today or past in the household time zone, it writes one household-wide (untargeted, like maintenance) `pets` notification, which only members with `pets.view` see or are pushed per countdown state: `sourceType` `pet_medication`, `sourceId` `<petId>:<medication key>`, `stateKey` `due|<day>` or `overdue|<day>`, deterministic ID from `deterministicNotificationId`, title "Maple's flea prevention is due today" / "... is overdue", deep link `/pets/<petId>?tab=medication`. Re-runs create nothing; still-open reminders get the usual refresh before expiry. An open reminder is resolved (`resolvedAt`, no `resolvedBy`) once its countdown (medication and due day) is no longer pending: a newer dose was logged, or the pet was deleted. The resolve transaction re-reads the pet and all its medication entries and resolves only if the countdown is still not pending, so a run working from stale entries never hides a reminder that an overlapping run reopened. If the countdown becomes pending again (the newer dose is deleted), the same reminder is reopened (see reopening below). The push carries the pet's photo when it is stored in the household's Storage folder (see push artwork above).
- Reopening: when upkeep finds a reminder actionable again whose deterministic document is resolved (medication: the dose that resolved it was deleted; maintenance: resolved in the app but the schedule is still due with the same state, for example the schedule write failed), it reopens that document: `resolvedAt` and `resolvedBy` become `null`, title, message and link are rewritten, and `createdAt`/`expiresAt` move as on a refresh, so it is listed again. Read and dismissed state are kept. It reopens only if the document was last written before the run started reading its sources (Firestore `updateTime` against the run's wall-clock start), so a resolution written while a run is in flight is never undone by that run's older reads. A reopen is an update, so it sends no push: members already got one for this same reminder. Chore reminders share this path but are never resolved.
- Maintenance and chore reminders are scheduled server-side. The hourly `householdUpkeep` Cloud Function (`functions/src/index.ts` → `functions/src/reminders.ts`) runs the same idempotent step for every household; the Chores page also runs it on demand through `syncHouseholdUpkeep` (`src/app/chores/actions.ts`, authorized by `chores.view`) on each load so a new recurring assignment appears immediately. Maintenance Center computes its due/overdue list locally from the same shared rules (`functions/src/shared/maintenance-reminders.ts`) for display only and writes no reminder notifications.
- Snoozed maintenance reminders are not notified: a schedule snoozed in the Maintenance Center carries `snoozedUntil` equal to its new due date, and `actionableReminders` skips the reminder while it is upcoming or due soon. It notifies again on the due day, or at once if a vehicle service becomes due by mileage (see [Maintenance Center](../maintenance-center/README.md)).
- Physical expiration: a Firestore TTL policy on collection group `notifications`, field `expiresAt`, deletes documents after they expire (Firestore usually acts within a day). It is versioned in `firestore.indexes.json` (`fieldOverrides`, `ttl: true`, with the field's default single-field indexes) and deployed by the release workflow. Nothing visible is lost: `expiresAt` is seven days after `createdAt`, and the bell and center only list the last seven days by `createdAt`. Still-overdue maintenance reminders are re-surfaced by hourly upkeep before they expire. Legacy `users/{email}/notifications` documents have no `expiresAt` and are not affected.

## Cross-Module Dependencies

The homepage overview counts only active notifications visible to the verified user, respecting UID/email targeting, expiration, dismissal, resolution, and read state. It sends at most five bounded maintenance/system titles to the optional narrative.

- [Chores](../chores/README.md), [Maintenance Center](../maintenance-center/README.md), and [Household Governance](../household-governance/README.md) create records.
- [Identity and Profile](../identity-profile/README.md) stores FCM tokens.
- [Application Shell and Dashboard](../application-shell/README.md) mounts bell/foreground handlers and owns the offline half of the shared service worker.
- [Firebase Platform](../firebase-platform/README.md) owns Functions and rules.

## Invariants and Failure Behavior

- Notification UI never displays `sourceType`, `stateKey` or `expiresAt` values directly.

- Bell queries the last seven days, reads at most 30 records (for a member who cannot see every module, the 30 are counted after the category filter, which is part of the query), and displays up to 10 active unresolved/undismissed items.
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

Unit coverage for grouping and source labels lives in `tests/unit/dashboard-ambience.test.ts`; `tests/e2e/dashboard-shell.spec.ts` checks the center shows no internal names or expiry stamps. `tests/unit/notifications-swipe.test.ts` covers the swipe rules and runs the real service worker script with a stand-in Messaging SDK (icon, badge, image, tag, link allowlist); `tests/e2e/notifications-swipe.spec.ts` covers swipe, hit-target stability, Undo, reduced motion and the desktop/keyboard dismiss button.

## When This Document Must Be Updated

Update this README when notification fields/paths/categories, filters, read/dismiss/resolution rules, reminder generators, FCM token handling, recipient selection, service-worker behavior, deep links, retention, or TTL setup changes.
