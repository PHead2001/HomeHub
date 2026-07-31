# Pets and Care Logs

## Purpose and Scope

This module owns pet profiles, pet photos, pet detail pages, and feeding, medication, and general care histories. It does not currently generate pet reminders or notifications.

## User-Facing Capabilities

- List and add pets at `/pets`.
- View, edit, or delete a pet at `/pets/[petId]`.
- Store pet type, photo, food schedule, and display metadata.
- Add and delete feeding, medication, and general care log entries.
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

Pages require an authenticated current user and scope all paths with that user's `householdId`. Firestore and Storage rules allow approved household members and legacy `memberEmails` members while excluding pending `newuser` members.

The role preset includes `pets.view`, `pets.addLogs`, `pets.editProfiles`, and `pets.deleteLogs`, but the broad Firestore rule and feature clients do not enforce each mutation permission. Direct-route writes may therefore exceed the role preset's intended restrictions.

Pet Storage rules are household-scoped but do not enforce server-side file size or content type.

## Integrations and Background Processing

Firebase Storage holds pet photos. No pet-specific Cloud Function, Genkit flow, external API, scheduled job, or automatic notification writer exists.

## Cross-Module Dependencies

- [Identity and Profile](../identity-profile/README.md) and [Household Governance](../household-governance/README.md) supply user, household, and role context.
- [Firebase Platform](../firebase-platform/README.md) owns Firestore/Storage initialization and security rules.
- [Application Shell and Dashboard](../application-shell/README.md) exposes pet navigation.
- [Notifications](../notifications/README.md) defines a `pets` category but receives no records from this module today.

## Invariants and Failure Behavior

- Log entries can be created and deleted but not edited.
- Log IDs are based on the current entry count plus one; deleting a non-final entry can allow a later write to reuse an existing ID.
- Deleting a pet document does not recursively delete nested logs or Storage photos.
- Replacing or removing a photo does not delete the previous Storage object.
- A missing pet invokes the route's not-found behavior; fetch failures are logged and render no pet content after loading.
- Duplicate/slug-colliding pet names can target the same document ID.

## Validation

- Run `npm.cmd run lint` and `npm.cmd run typecheck` after implementation changes.
- Manually test pet CRUD, duplicate names, image upload/replacement/removal, and a missing pet route.
- Test create/delete behavior for all three log types, including deletion followed by creation.
- Verify another household cannot read pet documents, logs, or images.

## When This Document Must Be Updated

Update this README when pet/log fields or paths, photo lifecycle, log ID strategy, role enforcement, reminder generation, routes, or delete cleanup behavior changes.
