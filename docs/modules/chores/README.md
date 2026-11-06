# Chores

## Purpose and Scope

This module owns rooms, chore templates, one-time and recurring assignments, generated chore instances, reassignment, subtasks, completion/history, calendar display, and chore notification creation. It does not own household membership or push transport.

## User-Facing Capabilities

- Manage chores at `/chores`.
- Create rooms and reusable task templates.
- Create a Temporary Task directly as a one-time chore without adding a reusable template.
- Assign one-time tasks or recurring schedules to household users.
- Use daily, weekdays-only, weekly, biweekly, monthly day-of-month, and monthly first-through-fourth weekday recurrence.
- View current, recurring, history, and calendar-oriented task views.
- Complete one or many chores, including subtask confirmation.
- Edit tasks, confirm permanent active/completed instance deletion, change assignments, and manage recurring definitions.

## Entry Points

- `src/app/chores/page.tsx`
- `src/components/chore-chart-client.tsx`
- Chore/recurrence types in `src/lib/types.ts`
- Notification helpers in `src/lib/notifications.ts`
- Member departure cleanup in `src/lib/server/household-membership.ts` (leaving) and `src/components/household-management-client.tsx` (removal)

## Architecture and Data Flow

`ChoreChartClient` loads rooms, templates, chore instances, and assignees. Assignees are the household's approved membership records (`households/{householdId}/members`: not `newuser`, status `active`), enriched with `users/{email}` profiles where readable; a profile that cannot be read falls back to the member record's name and avatar, so one unreadable profile never breaks the page. Recurring templates are normalized and expanded client-side when data loads, but only for members with `chores.create`; a failed generation write is logged and never blocks viewing. Generation starts at today and creates 30 valid occurrences with deterministic IDs derived from template, room, date, and assignee.

Completion updates chore instances. Editing or canceling a recurrence removes incomplete generated instances and regenerates from the template; completed history remains.

Temporary Task validates name, room, assignee, and due date, then atomically writes one auto-ID chore instance and one deterministic assignee notification. It does not write `chore-templates`.

## Data Model and Persistence

- Templates: `households/{householdId}/chore-templates/{templateId}`.
- Instances: `households/{householdId}/chores/{choreId}`.
- Rooms: `households/{householdId}/rooms/{roomId}`.
- Notifications: `households/{householdId}/notifications/{notificationId}`.

Important types are `Recurrence`, `RecurrenceFrequency`, `MonthlyRecurrenceMode`, `MonthlyNthWeekday`, `ChoreTemplate`, `Chore`, and `Room`.

`Chore.templateId` is optional for backward-compatible direct instances. `Chore.sourceType` may explicitly distinguish `template` and `temporary`; existing documents without `sourceType` continue through the established template/instance behavior.

Biweekly schedules use `startDate` as an anchor. Monthly day-of-month is limited to 1-28. Nth-weekday supports first through fourth; last-weekday recurrence is not implemented.

## Authentication, Roles, and Security

The page requires an authenticated user and uses that user's household ID. Assignee discovery uses UID membership records only; `households.memberEmails` is not consulted.

Navigation uses `chores.view`. Firestore's broad approved-member rule does not enforce granular `chores.complete/create/edit/delete/assign` permissions, so role restrictions are primarily UI-level. Pending `newuser` members are denied by rules.

## Integrations and Background Processing

- Template assignment notifications are best-effort household notification writes. Temporary Task creation batches its direct chore and deterministic assignment notification together so a successful creation cannot omit its initial notification.
- Overdue alerts (after 7:00 local time) and each person's daily reminder (at their chosen time, in their own `users.timeZone`, falling back to the household's) are created on the server. The hourly `householdUpkeep` Cloud Function (`functions/src/index.ts` → `functions/src/reminders.ts`) runs the same idempotent step for every household; the Chores page also runs it on demand through `syncHouseholdUpkeep` (`src/app/chores/actions.ts`, authorized by `chores.view`) so a new recurring assignment appears immediately.
- Deterministic per-user/day notification IDs suppress same-day duplicates.
- New records can trigger the shared FCM Cloud Function.
- Recurring instances for the next 30 occurrences are generated on the server from `functions/src/shared/recurrence.ts`, using the household `timeZone` (default `America/Chicago`). Chore IDs are `stableSlugify(templateId-roomId-day-email)`, identical to the previous browser-generated IDs. Nothing is generated for someone who is not an approved member.

## Cross-Module Dependencies

The homepage AI Overview includes only incomplete chores assigned to the verified token email, with exact overdue/today/seven-day counts and at most five bounded urgent labels. It does not expose another member's assignment list to the model.

- [Household Governance](../household-governance/README.md) supplies members and unassigns chores when members leave.
- [Notifications](../notifications/README.md) owns read/dismiss history and push delivery.
- [Firebase Platform](../firebase-platform/README.md) owns persistence and rules.
- [Application Shell and Dashboard](../application-shell/README.md) exposes route navigation.

## Invariants and Failure Behavior

- Defensive normalization supplies defaults for old recurrence records missing interval, weekdays, anchors, monthly mode, or day.
- Retention: completed chores older than 90 days (household-local) are deleted by the server step.
- Room deletion updates templates but not existing chore instances; unresolved room IDs can disappear from grouped views.
- Generation and reminders no longer depend on anyone opening the app.
- Best-effort notification failures do not roll back chore writes.
- Assignment forms show one-time date controls or recurring controls, never both; switching modes retains the unsaved recurrence state for that dialog session.
- Active and completed chore instances use the same confirmation contract before permanent deletion.
- Future/completed view switches use the shared control dimensions; their thumbs must remain inside the track at desktop and mobile widths.

## Validation

- Run `npm.cmd run lint` and `npm.cmd run typecheck` after implementation changes.
- Manually test template-backed one-time tasks, direct Temporary Tasks, and every recurrence mode across refresh, including old records.
- For Temporary Task, verify required-field failure, cancel, duplicate-submit prevention, direct chore persistence, no template creation, one assignee notification, completion, and confirmed deletion.
- Test bulk completion with unfinished subtasks, one-time/each recurrence-mode control set, active/completed deletion cancel and confirm, reassignment, recurrence edit/cancel, room deletion, 90-day history cleanup, and guest/child direct-route behavior.

## When This Document Must Be Updated

Update this README when chore/template/room fields or paths, recurrence normalization/generation, assignment/completion, history retention, reminder timing, member cleanup, permission enforcement, or notification behavior changes.
