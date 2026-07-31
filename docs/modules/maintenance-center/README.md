# Maintenance Center

## Purpose and Scope

This module owns home assets, vehicles, maintenance logs, embedded service schedules, maintenance attachments, due-state calculation, and maintenance notification creation. It does not own general notification presentation, shared AI configuration, or background push delivery.

## User-Facing Capabilities

- Use Overview, Home Assets, Vehicles, Reminders, and Logs tabs at `/maintenance`.
- Create, view, and edit assets; manage multiple schedules and linked logs.
- Create, view, edit, and delete vehicles; separate sold/retired vehicles; manage multiple service schedules.
- Create general, asset, or vehicle logs; view, edit, delete, attach files, and request an AI summary.
- Complete an asset/vehicle schedule by creating a routine log and advancing due values.
- Upload, open/download, categorize, and delete attachments.
- Review date/mileage reminders and open related assets or vehicles.

## Entry Points

- `src/app/maintenance/page.tsx`
- `src/components/maintenance-log-client.tsx`
- `src/ai/flows/summarize-maintenance-log.ts`
- Maintenance types in `src/lib/types.ts`
- Maintenance-specific matches in `firestore.rules` and `storage.rules`

## Architecture and Data Flow

`MaintenanceLogClient` loads assets, vehicles, logs, attachment metadata, and notifications together. Assets and vehicles embed schedule arrays. Reminder cards are projected client-side from dates, mileage, and schedules; stable-status notification documents are created when the center is opened.

Completing a schedule creates a routine log and writes the updated embedded schedule. Vehicle completion can also update current mileage.

## Data Model and Persistence

- Assets: `households/{householdId}/home-assets/{assetId}`.
- Vehicles: `households/{householdId}/vehicles/{vehicleId}`.
- Logs: `households/{householdId}/maintenance/{logId}`.
- Attachment metadata: `households/{householdId}/maintenance-attachments/{attachmentId}`.
- Reminder notifications: `households/{householdId}/notifications/{notificationId}`.
- Attachment objects: `households/{householdId}/maintenance/{targetType}/{targetId}/{attachmentId}-{sanitizedFileName}`.

Shared types include `HomeAsset`, `HomeAssetSchedule`, `Vehicle`, `VehicleServiceSchedule`, `MaintenanceLog`, and `MaintenanceAttachment`. Legacy logs fall back from missing `title` to `item`, infer target type from IDs, and default missing log type to `other`.

## Authentication, Roles, and Security

Clients derive household paths from the authenticated user. Pending `newuser` members are denied and legacy members remain supported.

Attachment metadata creation validates matching `householdId`, target/category values, path prefix, and `uploadedByUid == request.auth.uid`. Storage allows approved members, limits files to under 15 MiB, and accepts images, PDF, plain text, Word, and OpenXML documents.

The header uses `maintenance.view`, but the route and broad Firestore catch-all do not enforce granular create/edit/delete permission overrides for assets, vehicles, and logs.

## Integrations and Background Processing

- AI summaries use `summarizeMaintenanceLog` and the shared Gemini model; generated summaries remain client state.
- Date due-soon threshold: 14 days.
- Mileage due-soon threshold: 500 miles.
- Notification generation is client-triggered when Maintenance Center opens; no scheduled generator exists.
- New notification documents can trigger FCM through the shared Cloud Function.
- Physical notification expiration requires Firestore TTL on `expiresAt`.

## Cross-Module Dependencies

- [Notifications](../notifications/README.md) displays, dismisses, resolves, and pushes maintenance notices.
- [AI and Genkit](../ai-genkit/README.md) owns Gemini configuration.
- [Identity and Profile](../identity-profile/README.md) and [Household Governance](../household-governance/README.md) supply user and household context.
- [Firebase Platform](../firebase-platform/README.md) owns persistence initialization and rules.

## Invariants and Failure Behavior

- Invalid/missing dates are ignored; mileage reminders require current and next-due mileage.
- Notification IDs combine source, source ID, and status to reduce duplicates.
- Vehicle/log deletion is blocked while direct attachments exist; home assets currently have no delete action.
- Storage is deleted before metadata; a missing object is tolerated.
- Loading uses one `Promise.all`; one denied/failed collection query moves the entire center to its error state.
- Schedule completion uses independent parallel writes rather than a transaction, so partial completion is possible.
- Slug-derived asset, vehicle, and ordinary log IDs can collide.
- Deleting a vehicle leaves linked logs. Schedule notification source IDs depend on array indexes.

## Validation

- Run `npm.cmd run lint` and `npm.cmd run typecheck` after implementation changes; run a production build for broad UI/data-flow changes.
- Run functions and rules validation when notification delivery or security changes.
- Manually test legacy logs, duplicate names/titles, multiple schedules, date/mileage completion, reminders, partial failures, attachment allow/deny/delete behavior, inactive vehicles, and cross-household denial.

## When This Document Must Be Updated

Update this README when asset/vehicle/log/schedule/attachment fields or paths, reminder thresholds or generation, completion advancement, delete cleanup, AI summaries, notification integration, permission enforcement, or maintenance security rules change.
