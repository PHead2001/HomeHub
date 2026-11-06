# Pets and Care Logs

## Purpose and Scope

This module owns pet profiles, pet photos and species art, the living pet cards, pet detail pages, and feeding, medication, and general care histories. It does not currently generate pet reminders or notifications; medication countdowns are shown in the UI only.

## User-Facing Capabilities

- `/pets` lists pets as living cards (H09). The page header holds the title and, for members who may edit profiles, the **Add Pet** action in the same row (as Shopping and Maintenance). With no pets, the shared `EmptyState` (`kind="pets"`) invites the member to add the first pet (the invitation and button only appear with `pets.editProfiles`).
- Each card shows:
  - the photo with a face-safe cover crop (`object-position: 50% 35%`, no face detection), or an illustrated species avatar when there is no photo, the photo is the legacy `placehold.co` placeholder, or the photo fails to load (D17);
  - a feeding ring that fills per feeding today ("1 of 2 today", green with "All fed today" when the plan is met) and "Fed 2 h ago by Sam" from the latest feeding;
  - a countdown chip for the next medication dose ("Due in 3 days"; amber when due today or within three days, red when overdue);
  - one-tap feeding (**Feed · 1.5 cups**) at the planned portion. Success plays `playFeedback('complete')`, or `'celebrate'` when the feeding completes the day, shows a short paw-print burst (skipped under reduced motion) and a toast with **Undo** for members who may delete logs.
  The pet name is the card link (stretched over the card); the actions menu and feed button are separate targets above it. The home-screen shortcut **Log feeding** opens `/pets`, where every pet has its feed button.
- `/pets/[petId]` shows the photo or species art, the same feeding summary, medication chip and feed button, the schedule and usual portion, and tabs for Feeding, Medication and Care. `?tab=feeding|medication|care` selects a tab. Each tab lists history first; the full form opens behind **Log with details**, **Log a dose** or **Log care**. History entries show who logged them (member avatar and name) and properly pluralized amounts ("1 cup", "1.5 cups").
- The feeding form defaults to the planned portion and unit and the last food type, accepts any amount above 0 up to 50 (`step="any"`, so a parsed fraction such as "1/3 cup" → 0.33 is a valid default; the pet form and the parser use the same bounds via `isValidPortion`/`PORTION_MAX`), falls back to Dry when the last entry's food type is not a known value, and hides the date and time fields while "Use current time" is checked. The medication form has an optional **Next dose due** date that drives the countdown.
- Rules added with these dialogs never block editing an older pet: in the edit dialog a value the member did not change (the locked name, a long schedule, feedings per day, portion) is exempt from the length and range checks; a changed value must pass them. Legacy species values stay selectable.
- The edit dialog resets on every opening, so a discarded draft or replacement photo never carries into the next save. Removing a photo in either dialog is a draft change; it does not submit the form (the shared uploader's untyped Remove button is wrapped so its click cannot submit).
- Add and edit dialogs share one form: photo, name, type (Dog, Cat, Bird, Fish, Small mammal, Reptile, Other; a legacy stored value stays selectable), food schedule, and optional feedings per day and usual portion (amount and unit). Field problems are shown inline under the field with `FieldError` (`aria-invalid`, focus moves to the first problem): missing or too long name, a name already used in the household (case-insensitive), missing schedule, feedings per day outside 1-12, portion outside (0, 50]. Toasts are only for outcomes; failures use `toastError`, so messages come from `friendlyError`.
- Deleting a pet or a log asks for confirmation; the pet alert names the pet.
- Pet lists, pet documents and all three log histories are live (`onSnapshot`): changes by other members or devices appear without a refresh.

Species avatars (`src/components/pets/species-avatar.tsx`) are inline SVG for dog, cat, bird, fish, small mammal, reptile and other (a paw print), drawn in the EmptyState style with token classes only (`fill-primary/10` backdrop, `fill-muted` shapes outlined in `currentColor`, `fill-foreground` eyes, one `primary` accent), so every preset recolors them. Eyes blink (140 ms every 7 s, staggered between cards) with a CSS-only animation that is paused while the tab is hidden and removed under both `prefers-reduced-motion` and `html[data-motion="reduce"]`. The type picks the art; for "Other" the photo hint (`dataAiHint`, e.g. "rabbit") is used. Motion lives in `src/components/pets/pets.module.css`: the ring fill is a 500 ms data-change transition and the paw burst is 900 ms of opacity/transform in an absolutely positioned, `aria-hidden`, pointer-transparent layer, so nothing shifts or blocks input.

## Entry Points

- `src/app/pets/page.tsx`
- `src/app/pets/[petId]/page.tsx` (and both `loading.tsx` files)
- `src/components/pets-client.tsx`
- `src/components/add-pet-dialog.tsx`, `src/components/edit-pet-dialog.tsx`, `src/components/delete-pet-alert.tsx`
- `src/components/feeding-log.tsx`, `src/components/medication-log.tsx`, `src/components/care-log.tsx`, `src/components/pet-log-delete-alert.tsx`
- `src/components/pets/` – living card, pet photo, species avatar, feeding ring, medication chip, quick-feed button, shared pet form, page header, `pet-log-api.ts` (log reads/writes, `usePetLogs`), `pet-profile-api.ts` (create/update/delete, photo upload)
- `src/lib/pets/care.ts` – pure helpers: species mapping, placeholder detection, schedule parsing, feeding plan and status, relative times, medication countdown, form validation
- `src/lib/pets/types.ts` – pet-module views of the shared types in `src/lib/types.ts`, with the optional fields below

## Architecture and Data Flow

The pet list subscribes to the household pet collection; each card subscribes to its pet's newest 20 feeding logs for the feeding status. The next-medication countdown (card, detail summary and Medication tab) does not use a bounded history window: `useMedicationCountdownLogs` subscribes to every medication entry with a `nextDueDate` and to every entry from the oldest pending medication's latest dated dose onward (`pendingWindowStart`), so a monthly dose stays visible however many daily doses follow, and a later dose of the same medication still supersedes it. Both queries use single-field indexes.

Log dates exist in two stored shapes: Firestore timestamps (feedings written by this app) and ISO strings (medication and care entries, and legacy feedings). Firestore orders values of different types separately, so one `orderBy('date')` with a limit could hide every entry of one shape (for example, new timestamp feedings behind 20 legacy string feedings). Every history and countdown query therefore runs once per shape (`date >= <min timestamp>` and `date >= ''`, each ordered and limited the same way), and `newestFirst` merges them chronologically before applying the limit. No migration is needed; documents keep their stored shape. The countdown's "since" queries use the same pair (the string bound has a one-day margin for date-only strings). Timestamp dates on medication or care entries are converted to ISO strings on read. The detail route subscribes to one pet document and mounts a live client per log collection (newest 100 entries each). Photo uploads happen before the pet document is written with the resulting download URL.

The feeding plan comes from the structured `feedingsPerDay`, `portionAmount` and `portionUnit` fields when set, otherwise from parsing the free-text schedule ("1.5 cups twice daily" → 2 × 1.5 cups; "One can morning and evening" → 2 × 1 can; ".5 cups" → 0.5 cups, never a number read from inside another one; amounts are rounded to two decimals and ignored above 50). Explicitly non-daily or irregular schedules ("twice a week", "every other day", "every 3 days", "as needed", "free feed", "Mondays") get no daily target, so the ring never claims a daily goal the member did not enter; "every 8 hours" counts as 3 a day. A stored structured portion outside the accepted bounds is ignored for the plan, otherwise one cup with no daily target (the ring then fills on the first feeding). "Today" is the viewer's local calendar day.

## Data Model and Persistence

- Pet: `households/{householdId}/pets/{petId}`.
- Feeding logs: `households/{householdId}/pets/{petId}/feeding-logs/{logId}`.
- Medication logs: `households/{householdId}/pets/{petId}/medication-logs/{logId}`.
- Care logs: `households/{householdId}/pets/{petId}/care-logs/{logId}`.
- Photos: `households/{householdId}/pets/{uuid}.{extension}`.

Pet IDs are the slugified name plus a random suffix. New log entries use Firestore auto IDs; older entries keep their numeric IDs. Feeding dates are written as Firestore timestamps and reads accept timestamp or ISO values; medication and care dates are ISO strings.

Additive optional fields (all absent on older documents, which read as before):

- Pet: `feedingsPerDay` (integer 1-12), `portionAmount` (number), `portionUnit` (`Cups`, `Cans`, `Scoops`, `Other`). Clearing them in the edit dialog removes the fields. `type` may now also be `Bird`, `Fish`, `Small mammal` or `Reptile`.
- Feeding, medication and care logs: `loggedByUid` and `loggedByName` (the member's first name at the time of logging).
- Medication logs: `nextDueDate` (`yyyy-MM-dd`, local calendar date).

A pet without a photo is still written with the legacy placeholder URL `https://placehold.co/300x300.png` so older clients keep rendering it; current readers treat that URL and an empty value as "no photo".

## Authentication, Roles, and Security

Pages require an authenticated current user and scope all paths with that user's `householdId`. Firestore and Storage rules treat `households/{householdId}/members/{uid}` as the only membership authority: the caller needs an approved member record (role `owner`, `admin`, `member`, `child`, or `guest` with `status` `active`), and `households.memberEmails` or user-profile fields never grant access. Pending `newuser` members are blocked.

Firestore rules enforce each pet permission (role preset plus per-member overrides; owners hold every permission): `pets.view` to read pets and logs, `pets.editProfiles` to create, update, or delete pet documents, `pets.addLogs` to create or update feeding, medication, and care logs, and `pets.deleteLogs` to delete logs. The UI now mirrors these with the effective `permissions` from auth context: Add Pet, the empty-state action and the pet actions menu need `pets.editProfiles`; feed buttons and log forms need `pets.addLogs`; log delete buttons and the feeding Undo need `pets.deleteLogs`. Hiding controls is a convenience only; the rules remain the enforcement point. No rules changed.

Pet Storage rules require `pets.view` to read and `pets.editProfiles` to upload, replace, or delete photos. Uploads must be 10 MB or smaller with content type `image/png`, `image/jpeg`, `image/webp`, `image/gif`, `image/heic`, `image/heif`, or `image/avif`.

## Integrations and Background Processing

Firebase Storage holds pet photos. No pet-specific Cloud Function, Genkit flow, external API, scheduled job, or automatic notification writer exists. Sound and haptics go through the shared opt-in `playFeedback`.

## Cross-Module Dependencies

The homepage AI Overview may include pet count and a seven-day care-log count for callers with `pets.view`. It does not infer health, neglect, or missed care and does not send raw pet histories to the model.

- [Identity and Profile](../identity-profile/README.md) and [Household Governance](../household-governance/README.md) supply user, household, role and effective permission context.
- [Firebase Platform](../firebase-platform/README.md) owns Firestore/Storage initialization and security rules.
- [Application Shell and Dashboard](../application-shell/README.md) reads pets and feedings read-only for the dashboard (both date shapes, judged with `feedingPlan`/`feedingStatus`, so "fed" there means today's target is met, as on the pet card) and logs quick-add feedings through `addFeedingLog` with the pet's usual portion unless an amount is given (amounts parsed with `parsePortion`; gated by `pets.addLogs`). It links to `/pets/<id>?tab=feeding`. It also exposes pet navigation and the **Log feeding** home-screen shortcut (`/pets`), and provides the design foundation used here (`EmptyState`, `MemberAvatar`, `FieldError`, `toastError`/`friendlyError`, `playFeedback`, `useReducedMotion`, tokens, `glow-card`).
- [Notifications](../notifications/README.md) defines a `pets` category but receives no records from this module today.

## Invariants and Failure Behavior

- Log entries can be created and deleted but not edited.
- Feeding, medication, and care history deletions share a target-specific confirmation dialog with cancel and confirm paths.
- Deleting a pet document does not recursively delete nested logs or Storage photos.
- Replacing or removing a photo does not delete the previous Storage object.
- A missing pet shows an `EmptyState` with a link back to all pets; a load failure shows a friendly toast and a Try again action.
- A failed log subscription is never shown as an empty history. The card and the detail page share `PetCareSummary`: a feeding load error shows "Feeding status is unavailable right now" (no ring, no "No feedings logged yet"), and a medication load error shows "Next medication dose is unavailable right now" instead of hiding the chip. The feed button stays available, but with an unknown status it never claims "all fed for today". The Medication tab shows "Next dose is unavailable right now", and each history tab shows its own unavailable message. A unit test checks that every consumer of `usePetLogs` and `useMedicationCountdownLogs` reads `error`.
- Undo of a one-tap feeding deletes that entry only; it is offered only to members with `pets.deleteLogs`.
- Duplicate names are rejected in the add dialog against the loaded list (case-insensitive); IDs carry a random suffix, so two clients adding the same name at once still create two documents.
- Reduced motion (system or in-app) shows end states instantly: no blink, ring transition or paw burst.

## Validation

- Run `npm.cmd run lint` and `npm.cmd run typecheck` after implementation changes.
- `tests/unit/pets-care.test.ts`: species mapping, placeholder detection, schedule and portion parsing, feeding plan and status, relative times, medication countdown (including the pending window beyond 50 entries and Timestamp-shaped dates), the chronological merge of mixed date shapes, portion bounds shared by the parser and the forms, logger names, form validation, token-only colors in `src/components/pets` and the reduced-motion selectors.
- `tests/e2e/pets-living-cards.spec.ts` (desktop Chromium, seeded emulator): Add Pet in the header row, "Fed just now" and the ring label, one-tap feeding writing `loggedByUid` and completing the day, medication countdown chip, species art and the photo focal point, inline add-pet errors, photo removal not submitting the edit dialog and reopening discarding a draft, new feedings appearing behind 25 legacy ISO-string feedings, a fractional planned portion saving from the detailed form, history with "by Alex" and the planned default amount, `?tab=`, and a guest seeing no edit/log/delete controls. `tests/e2e/verification-findings.spec.ts` covers the log deletion dialogs.
- Manually test pet CRUD, duplicate names, image upload/replacement/removal, a missing pet route, all five theme presets (species art and chips recolor), and Reduce motion.
- Verify another household cannot read pet documents, logs, or images.

## When This Document Must Be Updated

Update this README when pet/log fields or paths, photo lifecycle, log ID strategy, role enforcement or permission-based visibility, the feeding plan or status rules, species art, reminder generation, routes, or delete cleanup behavior changes.
