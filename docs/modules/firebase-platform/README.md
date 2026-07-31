# Firebase Platform, Persistence, and Security

## Purpose and Scope

This module owns Firebase client bootstrap, deployment configuration, shared persistence topology, Firestore/Storage rules, and Cloud Functions runtime. Feature modules own their documents and workflows within these platform boundaries.

## User-Facing Capabilities

This is a platform module with no standalone page. It provides authentication, household data persistence, file storage, push transport, and App Hosting support to all product modules.

## Entry Points

- `src/lib/firebase.ts`
- `firestore.rules`
- `storage.rules`
- `firestore.indexes.json`
- `firebase.json`
- `apphosting.yaml`
- `functions/src/index.ts`
- `functions/package.json`
- `.env.example`
- `.env.e2e.example`
- `playwright.config.ts`
- `scripts/e2e/*`
- `tests/e2e/*`
- `.github/workflows/e2e-smoke.yml`

## Architecture and Data Flow

The Firebase web SDK initializes a singleton app, Auth, and Firestore. Messaging initialization is browser- and support-guarded. Feature code initializes Storage at upload sites.

When `NEXT_PUBLIC_USE_FIREBASE_EMULATORS=true`, the client connects Auth and Firestore to configured emulator hosts and requires a `demo-` project ID. Playwright starts Next.js with this explicit configuration, signs in through an emulator-only custom-token endpoint, and reuses Auth state including IndexedDB. Production/default initialization does not connect to emulators.

The `Authenticated E2E Smoke` GitHub Actions workflow runs project validation and smoke-only authenticated route coverage on Linux for pull requests targeting `main` and manual dispatch. It sources fake emulator values from `.env.e2e.example`, uses the owned-emulator runner's `--smoke-only` mode, and uploads debugging artifacts only on failure. Windows visual baselines are not compared in CI.

App Hosting serves the Next.js app. Firestore document creation under household notifications triggers the Node 20 Functions codebase for FCM delivery.

No explicit Firestore offline persistence, Auth persistence override, App Check, or custom local-cache policy is configured. Storage emulator wiring is intentionally absent because current visual fixtures do not upload files.

## Data Model and Persistence

Primary topology:

- `users/{email}`
- `households/{householdId}`
- `households/{householdId}/members/{uid}`
- `households/{householdId}/notifications/{notificationId}`
- `households/{householdId}/auditLogs/{auditId}`
- `households/{householdId}/chores/{choreId}`
- `households/{householdId}/chore-templates/{templateId}`
- `households/{householdId}/rooms/{roomId}`
- `households/{householdId}/shopping-lists/{listId}` with `items` and `config/categories`
- `households/{householdId}/pantry-inventory/{itemId}`
- `households/{householdId}/barcode-library/{barcode}`
- `households/{householdId}/pets/{petId}` with nested log collections
- `households/{householdId}/home-assets/{assetId}`
- `households/{householdId}/vehicles/{vehicleId}`
- `households/{householdId}/maintenance/{logId}`
- `households/{householdId}/maintenance-attachments/{attachmentId}`
- `households/{householdId}/home-automation/credentials`
- `inviteCodes/{code}`

Storage paths cover household maintenance files, barcode images, pet images, and per-email avatars. `firestore.indexes.json` currently declares no composite indexes or field overrides.

## Authentication, Roles, and Security

Rules use Firebase Auth UID/email, UID membership documents, and legacy `households.memberEmails`. Pending `newuser` members are blocked from ordinary household subcollections.

Specialized rules protect membership, notifications, maintenance attachment metadata, audit logs, invites, and user profiles. A generic household catch-all grants approved members read/write access to remaining feature collections and does not enforce granular role permission overrides.

Maintenance Storage restricts size/type; barcode/pet/avatar paths are scoped but have no server-side size/MIME restrictions. No App Check enforcement is configured.

## Integrations and Background Processing

- Firebase Auth, Firestore, Storage, Cloud Messaging, Functions, and App Hosting.
- `sendPushOnNewNotification` is the only Cloud Function.
- There are no scheduled functions or recursive household-delete function.
- Environment names: `NEXT_PUBLIC_FIREBASE_API_KEY`, `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN`, `NEXT_PUBLIC_FIREBASE_PROJECT_ID`, `NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET`, `NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID`, `NEXT_PUBLIC_FIREBASE_APP_ID`, and `NEXT_PUBLIC_FIREBASE_VAPID_KEY`.
- E2E-only names: `NEXT_PUBLIC_USE_FIREBASE_EMULATORS`, `NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR_HOST`, `NEXT_PUBLIC_FIRESTORE_EMULATOR_HOST`, `FIREBASE_AUTH_EMULATOR_HOST`, and `FIRESTORE_EMULATOR_HOST`.

## Cross-Module Dependencies

Every application module depends on this platform. [Notifications](../notifications/README.md) is the only current Functions trigger consumer; [Identity and Profile](../identity-profile/README.md) owns Auth/profile behavior; [Household Governance](../household-governance/README.md) owns membership semantics.

## Invariants and Failure Behavior

- User profile document IDs are email addresses; household membership document IDs are Auth UIDs.
- Legacy email membership is supported when no UID member document exists.
- Generic feature rules authorize approved membership, not each permission override.
- Notification deletion is denied; logical expiration needs manual TTL configuration.
- Functions remove invalid FCM tokens after failed sends.
- UID-only push targeting depends on a `users.uid` query, but profile creation does not consistently store that field.
- Notification target fields are trusted by the push function and are not proven household members by creation rules.
- The E2E seed and Playwright config refuse non-loopback emulator hosts; the seed additionally requires the exact `demo-homehub-e2e` project.
- The emulator-only custom token route has no service-account secret and returns 404 unless emulator safety gates pass.
- CI artifacts exclude `playwright/.auth/`; only failure reports, traces, screenshots, videos, and emulator logs are uploaded.

## Validation

- Run `npm.cmd run lint`, `npm.cmd run typecheck`, and `npm.cmd run build` for platform/config changes.
- Run `npm.cmd run test:e2e:local` for the seeded Auth/Firestore smoke and visual suite; install Chromium once with `npx.cmd playwright install chromium`.
- Run `npm.cmd run test:e2e:ci` to reproduce the GitHub Actions smoke-only phase locally without visual comparison.
- In `functions/`, run `npm.cmd run lint` and `npm.cmd run build` for function changes.
- Use Firebase Emulator rules tests when added; no automated Firestore/Storage rules suite currently exists.
- Manually verify cross-household denial, pending-user denial, legacy fallback, own-profile restrictions, attachment restrictions, FCM delivery, and invalid-token cleanup.

## When This Document Must Be Updated

Update this README when Firebase initialization, environment names, deployment or CI configuration, emulator/E2E wiring, seed topology, collection/Storage topology, security rules, indexes, Functions, Auth/membership fallback, App Check/offline settings, or TTL requirements change.
