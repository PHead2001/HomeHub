# Chores

## Purpose and Scope

This module owns rooms, chore templates, one-time and recurring assignments, generated chore instances, reassignment, subtasks, completion/history, calendar display, and chore notification creation. It does not own household membership or push transport.

## User-Facing Capabilities

- Manage chores at `/chores`.
- Create rooms and reusable task templates.
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
- Member departure cleanup in `src/contexts/auth-context.tsx` and `src/components/household-management-client.tsx`

## Architecture and Data Flow

`ChoreChartClient` loads rooms, templates, chore instances, and legacy household users. Recurring templates are normalized and expanded client-side when data loads. Generation starts at today and creates 30 valid occurrences with deterministic IDs derived from template, room, date, and assignee.

Completion updates chore instances. Editing or canceling a recurrence removes incomplete generated instances and regenerates from the template; completed history remains.

## Data Model and Persistence

- Templates: `households/{householdId}/chore-templates/{templateId}`.
- Instances: `households/{householdId}/chores/{choreId}`.
- Rooms: `households/{householdId}/rooms/{roomId}`.
- Notifications: `households/{householdId}/notifications/{notificationId}`.

Important types are `Recurrence`, `RecurrenceFrequency`, `MonthlyRecurrenceMode`, `MonthlyNthWeekday`, `ChoreTemplate`, `Chore`, and `Room`.

Biweekly schedules use `startDate` as an anchor. Monthly day-of-month is limited to 1-28. Nth-weekday supports first through fourth; last-weekday recurrence is not implemented.

## Authentication, Roles, and Security

The page requires an authenticated user and uses that user's household ID. Assignee discovery still reads `households.memberEmails` and `users/{email}` rather than relying exclusively on UID membership documents.

Navigation uses `chores.view`. Firestore's broad approved-member rule does not enforce granular `chores.complete/create/edit/delete/assign` permissions, so role restrictions are primarily UI-level. Pending `newuser` members are denied by rules.

## Integrations and Background Processing

- Assignment notifications are best-effort household notification writes.
- Overdue and configured daily reminders are checked every 60 seconds only while the chore client is mounted.
- Deterministic per-user/day notification IDs suppress same-day duplicates.
- New records can trigger the shared FCM Cloud Function.
- There is no scheduled recurrence or reminder function.

## Cross-Module Dependencies

- [Household Governance](../household-governance/README.md) supplies members and unassigns chores when members leave.
- [Notifications](../notifications/README.md) owns read/dismiss history and push delivery.
- [Firebase Platform](../firebase-platform/README.md) owns persistence and rules.
- [Application Shell and Dashboard](../application-shell/README.md) exposes route navigation.

## Invariants and Failure Behavior

- Defensive normalization supplies defaults for old recurrence records missing interval, weekdays, anchors, monthly mode, or day.
- Completed chores older than 90 days are deleted during chore-page loading.
- Room deletion updates templates but not existing chore instances; unresolved room IDs can disappear from grouped views.
- Client-only generation means recurring instances and reminders are not advanced while nobody opens the chore page.
- Best-effort notification failures do not roll back chore writes.
- Assignment forms show one-time date controls or recurring controls, never both; switching modes retains the unsaved recurrence state for that dialog session.
- Active and completed chore instances use the same confirmation contract before permanent deletion.

## Validation

- Run `npm.cmd run lint` and `npm.cmd run typecheck` after implementation changes.
- Manually test one-time tasks and every recurrence mode across refresh, including old records.
- Test bulk completion with unfinished subtasks, one-time/each recurrence-mode control set, active/completed deletion cancel and confirm, reassignment, recurrence edit/cancel, room deletion, 90-day history cleanup, and guest/child direct-route behavior.

## When This Document Must Be Updated

Update this README when chore/template/room fields or paths, recurrence normalization/generation, assignment/completion, history retention, reminder timing, member cleanup, permission enforcement, or notification behavior changes.
