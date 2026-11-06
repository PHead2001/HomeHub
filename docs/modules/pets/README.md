# Pets and Care Logs

## Purpose and Scope

This module owns pet profiles, pet photos, pet detail pages, and feeding, medication, and general care histories. It does not currently generate pet reminders or notifications.

## User-Facing Capabilities

- List and add pets at `/pets`.
- View, edit, or delete a pet at `/pets/[petId]`.
- Store pet type, photo, food schedule, and display metadata.
- Add feeding, medication, and general care log entries; confirm permanent deletion for each log type.
- View each log type in its own pet-detail tab.

## Entry Points

- `src/app/pets/page.tsx`
- `src/app/pets/[petId]/page.tsx`
- `src/components/pets-client.tsx`
- `src/components/add-pet-dialog.tsx`
- `src/components/edit-pet-dialog.tsx`
- `src/components/delete-pet-alert.tsx`
- `src/components/feeding-log.tsx`
- `src/components/medication-log.tsx`
- `src/components/care-log.tsx`
- Shared pet/log types in `src/lib/types.ts`

## Architecture and Data Flow

The pet list reads the household pet collection. The detail route reads one pet document, manages profile edits/deletion, and mounts separate clients for each nested log collection. Photo uploads occur before the pet document is written with the resulting download URL.

## Data Model and Persistence

- Pet: `households/{householdId}/pets/{petId}`.
- Feeding logs: `households/{householdId}/pets/{petId}/feeding-logs/{logId}`.
- Medication logs: `households/{householdId}/pets/{petId}/medication-logs/{logId}`.
- Care logs: `households/{householdId}/pets/{petId}/care-logs/{logId}`.
- Photos: `households/{householdId}/pets/{uuid}.{extension}`.

`Pet`, `FeedingLog`, `MedicationLog`, and `CareLog` are defined in `src/lib/types.ts`. Pet IDs are slugified from names. Feeding dates are written as Firestore timestamps and reads accept timestamp or ISO values; medication and care dates are ISO strings.

## Authentication, Roles, and Security

Pages require an authenticated current user and scope all paths with that user's `householdId`. Firestore and Storage rules treat `households/{householdId}/members/{uid}` as the only membership authority: the caller needs an approved member record (role `owner`, `admin`, `member`, `child`, or `guest` with `status` `active`), and `households.memberEmails` or user-profile fields never grant access. Pending `newuser` members are blocked.

Firestore rules enforce each pet permission (role preset plus per-member overrides; owners hold every permission): `pets.view` to read pets and logs, `pets.editProfiles` to create, update, or delete pet documents, `pets.addLogs` to create or update feeding, medication, and care logs, and `pets.deleteLogs` to delete logs. Feature clients do not hide controls by these permissions, so a disallowed write is rejected by the rules rather than prevented in the UI.

Pet Storage rules require `pets.view` to read and `pets.editProfiles` to upload, replace, or delete photos. Uploads must be 10 MB or smaller with content type `image/png`, `image/jpeg`, `image/webp`, `image/gif`, `image/heic`, `image/heif`, or `image/avif`.

## Integrations and Background Processing

Firebase Storage holds pet photos. No pet-specific Cloud Function, Genkit flow, external API, scheduled job, or automatic notification writer exists.

## Cross-Module Dependencies

The homepage AI Overview may include pet count and a seven-day care-log count for callers with `pets.view`. It does not infer health, neglect, or missed care and does not send raw pet histories to the model.

- [Identity and Profile](../identity-profile/README.md) and [Household Governance](../household-governance/README.md) supply user, household, and role context.
- [Firebase Platform](../firebase-platform/README.md) owns Firestore/Storage initialization and security rules.
- [Application Shell and Dashboard](../application-shell/README.md) exposes pet navigation.
- [Notifications](../notifications/README.md) defines a `pets` category but receives no records from this module today.

## Invariants and Failure Behavior

- Log entries can be created and deleted but not edited.
- Feeding, medication, and care history deletions share a target-specific confirmation dialog with cancel and confirm paths.
- Log IDs are based on the current entry count plus one; deleting a non-final entry can allow a later write to reuse an existing ID.
- Deleting a pet document does not recursively delete nested logs or Storage photos.
- Replacing or removing a photo does not delete the previous Storage object.
- A missing pet invokes the route's not-found behavior; fetch failures are logged and render no pet content after loading.
- Duplicate/slug-colliding pet names can target the same document ID.

## Validation

- Run `npm.cmd run lint` and `npm.cmd run typecheck` after implementation changes.
- Manually test pet CRUD, duplicate names, image upload/replacement/removal, and a missing pet route.
- Test create/delete behavior for all three log types, including deletion cancel/confirm and deletion followed by creation.
- Verify another household cannot read pet documents, logs, or images.

## When This Document Must Be Updated

Update this README when pet/log fields or paths, photo lifecycle, log ID strategy, role enforcement, reminder generation, routes, or delete cleanup behavior changes.
