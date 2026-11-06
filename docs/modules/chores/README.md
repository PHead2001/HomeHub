# Chores

## Purpose and Scope

This module owns rooms, chore templates (the chore library), one-time and recurring assignments, generated chore instances, reassignment, subtasks, completion/history, the household leaderboard (points, streaks, fair share), the household calendar at `/calendar`, and chore notification creation. It does not own household membership, push transport, or the maintenance and pet data the calendar reads.

## User-Facing Capabilities

- Manage chores at `/chores`. The page header is left-aligned with its actions in the header row, like the other modules: **Add Chore** (primary), **Calendar** (link to `/calendar`) and **Chore Manager** (Chore library, Repeating chores, Rooms, and for owners/admins a **Show leaderboard** switch).
- **Add Chore** is the one-dialog way to add a chore: name, who (defaults to you), one time (due date, default today) or repeats (daily/weekdays, weekly or every 2 weeks on chosen days, monthly by day or nth weekday), an optional room and notes. One-time chores are direct chore documents (`sourceType: 'temporary'`); repeating chores create a library template with a recurrence, and server upkeep generates the instances. With no rooms yet the room field says so and offers **Create a room** (when the member may edit rooms).
- The chore library still holds reusable chores: create, edit, delete (with confirmation) and tick several to assign them together. The assign dialog is titled after the chore ("Assign Reset the kitchen" or "Assign 3 chores"), defaults the assignee to you, and shows one-time or repeating controls, never both. Weekday toggles show a filled selected state.
- **One tap completes** (H05): the round checkbox next to a chore marks it done. The box fills and a check draws itself, the row slides out of To Do, confetti bursts from the checkbox (bigger for chores with more steps), a `complete` sound/haptic plays (`playFeedback`, only if the member enabled it), and a toast offers **Undo** for 5 s. Undo restores exactly what was there (`isCompleted`, `completedAt`, `completedSubTasks`, and removes the server stamp). Completing a chore with open steps ticks the steps too; Undo un-ticks them. Ticking a completed chore's box reopens it. Confetti fires at most once per chore per visit.
- **House is clean**: when the last chore due today (or overdue) is completed, a short full-screen card says "House is clean" and the rooms that were cleaned sparkle one by one. It shows once per household per day (session storage), lasts at most 1.5 s, ignores the pointer (`pointer-events: none`) and disappears at the first key, click, touch or scroll.
- **Select mode**: **Select** switches the checkboxes to selection checkboxes ("Select …") for bulk completion; **Complete selected** confirms first when selected chores have open steps.
- **Missed repeating chores fold**: for each repeating series (same template, rooms and assignee) only the latest instance due today or earlier is listed; older missed ones show as "+N earlier missed" on that row (instances due on the same day are never folded into each other), and members who may delete chores can **Clear** them from that row.
- Rows show the chore name on up to two lines (no single-line truncation on phones), the due day ("Today", "Yesterday", "Tue, Aug 4"), an **Overdue** badge, step progress, and the assignee as a `MemberAvatar` (name beside it from the `sm` breakpoint). Overdue rows keep the normal surface with a destructive left border and badge (no red-on-red text). Reassign is a menu on the avatar (for members who may edit and assign); the delete icon shows for members who may delete. Tapping the name (with its small chevron) shows notes and steps.
- Empty states use `EmptyState`: a household with no chores invites you to **Add your first chore**; an empty To Do says "Nothing due today" (or "All done for today" when you finished something) and names the next chore.
- **Leaderboard** (H06, beside the chart on wide screens, below it on phones): this Monday-Sunday week's points per member (10 per chore, +2 per step, +5 when done on or before its due day), a daily streak flame (consecutive days with at least one completed chore, ending today or yesterday), and a fair-share ring (each member's slice of the chores due this week, in their member color). Child accounts collect stickers (one per chore this week) instead of points. On Sundays a podium rises with a crown for the week's MVP. Owners and admins can turn the leaderboard off for the household.
- **Calendar** at `/calendar` (H19, replaces the old calendar dialog, D11): Week and Month views of chores (colored by assignee with `memberColor`), maintenance due dates and logged pet medication. Today glows; overdue chores and maintenance stack in a red **Overdue** rail; a legend lists members. Month cells show up to three items (dots on phones) and selecting a day lists everything for it below the grid. Week view stacks days vertically on phones; swiping left/right changes week or month. Each item opens a details popover with a link to its module.
- **Reschedule** (calendar): members with `chores.edit` can drag an open chore to another day, or open it and use **Move to date** (keyboard-accessible date field). The chip springs into its new day and a toast offers **Undo** for 5 s. Maintenance and medication items are read-only.

## Entry Points

- `src/app/chores/page.tsx`, `src/app/chores/loading.tsx`
- `src/app/calendar/page.tsx`, `src/app/calendar/loading.tsx`
- `src/components/chore-chart-client.tsx` (page, data loading, writes)
- `src/components/chores/`: `chore-dialogs.tsx` (Add Chore, library, assign, rooms, repeating chores), `chore-list.tsx` (rows), `completion-check.tsx`, `confetti.tsx`, `house-clean-moment.tsx`, `chore-leaderboard.tsx`, `recurrence-fields.tsx`, `assignee-select.tsx`, `room-icons.tsx`, `use-chore-settings.ts`, `calendar/household-calendar.tsx`
- `src/lib/chores/` (pure logic): `dates.ts` (day keys, due day, completion instant), `stats.ts` (points, streaks, stickers, fair share, podium), `list.ts` (capabilities, missed-instance folding, "house is clean"), `calendar.ts` (events, grids, rail, reschedule fields), `completion.ts` (complete/undo field updates)
- Chore/recurrence types in `src/lib/types.ts`; notification helpers in `src/lib/notifications.ts`
- Member departure cleanup in `src/lib/server/household-membership.ts` (leaving) and `src/components/household-management-client.tsx` (removal)

## Architecture and Data Flow

`ChoreChartClient` loads rooms, templates, chore instances, and assignees from approved membership records (enriched with readable `users/{email}` profiles; the membership role is kept for sticker mode). It does not expand recurring templates itself: before reading chores, each load calls the `syncHouseholdUpkeep` server action, which runs the same idempotent upkeep as the hourly `householdUpkeep` Cloud Function. That step creates any missing instances for the next 30 occurrences of each recurring template, starting at today in the household time zone, with deterministic IDs derived from template, room, date, and assignee. If the action fails, the page logs a warning and shows whatever instances already exist.

Completion writes go through `completionUpdate()` (`src/lib/chores/completion.ts`): `isCompleted: true`, `completedAt` (client ISO time, kept for older readers and retention) and `completedAtServer: serverTimestamp()`. The page updates optimistically and rolls back with `toastError` on failure. Undo and reopen write back the previous fields and delete `completedAtServer`.

Points, streaks, stickers, fair share and the podium are computed in the browser by `computeChoreStats()` from the chore documents already loaded (completion history is kept 90 days). Nothing is stored, so there is no score a client could write. Completion times come from `completedAtServer` when present (cannot be backdated, see Security) and fall back to `completedAt` for chores completed before the stamp existed. Points go to the chore's assignee; chores of former members are ignored.

Editing or canceling a recurrence deletes the template's incomplete instances in the browser; the reload that follows runs server upkeep, which regenerates instances for an edited recurrence. Completed history remains.

Add Chore (one time) validates name, assignee and due date inline, then atomically writes one auto-ID chore instance and, when the assignee is someone else, one deterministic assignee notification. It does not write `chore-templates`. Add Chore (repeating) writes one template with a unique ID (`stableSlugify(name)`, suffixed `-2`, `-3`… on collision) and its recurrence. New library chores and rooms get unique IDs the same way, so a duplicate name no longer overwrites an existing document.

The calendar (`HouseholdCalendar`) runs upkeep, then reads chores (`chores.view`), `home-assets` and `vehicles` (`maintenance.view`, turned into due dates with the shared `buildMaintenanceReminders` used by Maintenance and the reminder function), and `pets/{petId}/medication-logs` (`pets.view`), each only when the member may read it. A source that fails shows an inline alert; the others still render. Moving a chore writes `originalDueDate` (the day) and `dueDate` (local noon ISO) to the chore document only.

## Data Model and Persistence

- Templates: `households/{householdId}/chore-templates/{templateId}`.
- Instances: `households/{householdId}/chores/{choreId}`.
- Rooms: `households/{householdId}/rooms/{roomId}`.
- Chore preferences: `households/{householdId}/chore-settings/preferences`, shape `{ leaderboardEnabled: boolean, updatedAt?: string }`. A missing document means the defaults (leaderboard on).
- Notifications: `households/{householdId}/notifications/{notificationId}`.
- Read-only for the calendar: `home-assets`, `vehicles`, `pets` and `pets/{petId}/medication-logs`.

Important types are `Recurrence`, `RecurrenceFrequency`, `MonthlyRecurrenceMode`, `MonthlyNthWeekday`, `ChoreTemplate`, `Chore`, and `Room`; `ChoreRecord` (`src/lib/chores/dates.ts`) is `Chore` plus the optional `completedAtServer` timestamp.

`Chore.templateId` is optional for backward-compatible direct instances. `Chore.sourceType` may explicitly distinguish `template` and `temporary`; existing documents without `sourceType` continue through the established template/instance behavior. `completedAtServer` is optional and additive: existing completed chores without it keep working (their `completedAt` is used), and no migration is needed.

Biweekly schedules use `startDate` as an anchor. Monthly day-of-month is limited to 1-28. Nth-weekday supports first through fourth; last-weekday recurrence is not implemented. Pets have no medication schedule, so the calendar shows medication doses that were logged, not doses that are due.

## Authentication, Roles, and Security

The page requires an authenticated user and uses that user's household ID. Assignee discovery uses approved, active `households/{householdId}/members/{uid}` records; an unreadable profile falls back to the member record's display name.

Navigation uses `chores.view`. Firestore rules enforce granular permissions: `chores.view` to read chores, templates, rooms and chore preferences; `chores.create` to create chores and templates; `chores.complete` for updates limited to `isCompleted`, `completedAt`, `completedSubTasks` and `completedAtServer`; `chores.edit` for other chore and template updates and room create/update; and `chores.delete` for deletes. `chores.assign` is not checked by rules separately (recurring assignment is a template update). On-demand upkeep requires `chores.view`. Pending `newuser` members are denied by rules.

Completion stamp rule (every chore write), phase 1: when a chore becomes completed with a `completedAtServer`, the stamp must equal `request.time`; a chore that stays completed must keep its stamp unchanged; a chore created already completed may only carry a server stamp. So a stamp can never be backdated or forged. For rollout compatibility a completion *without* a stamp is still accepted, because open tabs and cached copies of the previous client don't send one, and stats fall back to `completedAt` for those chores. Phase 2, once the stamping client has been live long enough, removes the no-stamp allowance (the two `!('completedAtServer' in ...)` branches in `firestore.rules`), and the rules then deny unstamped completions. Chore preferences may be written only by owners and admins (role, not overrides), only at `preferences`, only with `leaderboardEnabled` (bool) and `updatedAt` (string); nobody may delete them.

The UI never shows an action the member cannot perform, mirroring the rules through `choreCapabilities(permissions)`: the completion checkbox is disabled without `chores.complete`; Add Chore and the library's create need `chores.create`; reassign, room add/edit and library edit need `chores.edit`; delete (rows, library, rooms, clearing missed instances) needs `chores.delete`; editing or stopping a repeating chore needs both `chores.edit` and `chores.delete` (it removes the old open instances); removing a room from a library chore without `chores.delete` is refused inline; picking someone other than yourself as assignee needs `chores.assign`; calendar rescheduling needs `chores.edit`; the leaderboard switch is shown to owners and admins.

## Integrations and Background Processing

- Assignment notifications go only to someone other than the person assigning (no "New chore assigned" for chores you give yourself). Template assignment notifications are best-effort household notification writes. One-time Add Chore batches its direct chore and deterministic assignment notification together so a successful creation cannot omit its initial notification.
- Overdue alerts (after 7:00 local time) and each person's daily reminder (at their chosen time, in their own `users.timeZone`, falling back to the household's) are created on the server. The hourly `householdUpkeep` Cloud Function (`functions/src/index.ts` → `functions/src/reminders.ts`) runs the same idempotent step for every household; the Chores page and the calendar also run it on demand through `syncHouseholdUpkeep` (`src/app/chores/actions.ts`, authorized by `chores.view`) so a new recurring assignment appears immediately.
- Deterministic per-user/day notification IDs suppress same-day duplicates.
- New records can trigger the shared FCM Cloud Function.
- Recurring instances for the next 30 occurrences are generated on the server from `functions/src/shared/recurrence.ts`, using the household `timeZone` (default `America/Chicago`). Chore IDs are `stableSlugify(templateId-roomId-day-email)`, identical to the previous browser-generated IDs. Nothing is generated for someone who is not an approved member. A rescheduled instance keeps its ID, so upkeep never recreates it on its old day.
- Feedback: `playFeedback('complete')` on completion, `'celebrate'` for "House is clean", `'add'` after adding or moving a chore.

## Cross-Module Dependencies

The homepage AI Overview includes only incomplete chores assigned to the verified token email, with exact overdue/today/seven-day counts and at most five bounded urgent labels. It does not expose another member's assignment list to the model.

- [Household Governance](../household-governance/README.md) supplies members and unassigns chores when members leave.
- [Notifications](../notifications/README.md) owns read/dismiss history and push delivery.
- [Firebase Platform](../firebase-platform/README.md) owns persistence and rules.
- [Application Shell and Dashboard](../application-shell/README.md) exposes route navigation and the design foundation used here (`EmptyState`, `MemberAvatar`, `FieldError`, `toastError`/`friendlyError`, `memberColor`, `playFeedback`, motion and the reduced-motion contract). `/calendar` has no header or tab-bar entry yet; it is linked from the Chores page.
- [Maintenance Center](../maintenance-center/README.md) owns assets, vehicles and their schedules; the calendar reads them read-only and shares `buildMaintenanceReminders` for due dates.
- [Pets](../pets/README.md) owns pets and medication logs; the calendar reads them read-only.

## Invariants and Failure Behavior

- Defensive normalization supplies defaults for old recurrence records missing interval, weekdays, anchors, monthly mode, or day.
- Retention: completed chores older than 90 days (household-local) are deleted by the server step, so leaderboard totals cover at most 90 days.
- Room deletion (confirmed) updates templates but not existing chore instances; unresolved room IDs show under "Unknown Room".
- Generation and reminders no longer depend on anyone opening the app.
- Generation is create-only and retention re-checks: inside each upkeep transaction a generated instance is written only if it is still absent, and a completed chore is purged only if it is still completed with the same `completedAt`, so overlapping hourly and on-demand runs never reset or remove work done in between. Instances are also created only if their source template is unchanged since the run read it (same update time), so editing or cancelling a recurrence while a run is in flight is never undone.
- Best-effort notification failures do not roll back chore writes.
- Every client that completes a chore must use `completionUpdate()`. Unstamped completions are accepted only during phase 1 and will be denied after phase 2.
- Field problems in every chore dialog are shown inline with `FieldError` (with `aria-invalid`/`aria-describedby`), never as toasts; failures use `toastError`, so raw Firebase text never reaches users.
- Motion follows the shared contract: under reduced motion (system or in-app) the checkbox, row exit, podium and calendar moves show their end state instantly and confetti does not render; "House is clean" shows its finished card. Hover effects are not used for meaning, and no animation delays content, focus or errors.
- Assignment forms show one-time date controls or recurring controls, never both.
- Active and completed chore instances use the same confirmation contract before permanent deletion.
- Future/completed view switches use the shared control dimensions; their thumbs must remain inside the track at desktop and mobile widths.

## Validation

- Run `npx eslint .`, `npx tsc --noEmit -p .`, and `npm run test:unit` after implementation changes. Unit tests: `tests/unit/chores-stats.test.ts` (dates, points, streaks, stickers, fair share, podium), `tests/unit/chores-calendar.test.ts` (events, rail, grids, reschedule fields), `tests/unit/chores-list.test.ts` (missed-instance folding, capabilities per role, token-only colors, completion helper use, inline validation).
- Rules: `tests/rules/firestore.rules.test.ts` ("chore completion stamps and chore settings") covers the stamp rule and the preferences path.
- E2E: `tests/e2e/chores-ux.spec.ts` covers the header, one-tap completion with Undo, Add Chore inline validation and self-assignment without a notification, select mode, folded missed instances, the calendar's overdue rail and Move to date, and phone overflow.
- Manually test template-backed one-time tasks, Add Chore one time and repeating, and every recurrence mode across refresh, including old records.
- Test bulk completion with unfinished steps, active/completed deletion cancel and confirm, reassignment, recurrence edit/cancel, room deletion, 90-day history cleanup, reduced motion, and guest/child direct-route behavior (child: complete only; guest: read only).

## When This Document Must Be Updated

Update this README when chore/template/room/preference fields or paths, recurrence normalization/generation, assignment/completion, scoring, history retention, reminder timing, member cleanup, permission enforcement, calendar sources, or notification behavior changes.
