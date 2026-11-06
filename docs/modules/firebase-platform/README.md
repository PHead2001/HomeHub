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
- `.github/workflows/e2e-smoke.yml` (also runs `npm run test:unit`, the design-foundation unit tests)

## Architecture and Data Flow

The Firebase web SDK initializes singleton Auth, Firestore, and Storage services. Messaging initialization is browser- and support-guarded.

When `NEXT_PUBLIC_USE_FIREBASE_EMULATORS=true`, the client connects Auth, Firestore, and Storage to configured emulator hosts and requires a `demo-` project ID. Playwright starts Next.js with this explicit configuration, signs in through an emulator-only custom-token endpoint, and reuses Auth state including IndexedDB. Production/default initialization does not connect to emulators. Playwright drives the Next.js dev server at `http://127.0.0.1:9002`; Next.js 16 blocks dev-server resources requested from any origin other than localhost, so `next.config.ts` sets `allowedDevOrigins: ['127.0.0.1']`. Without it the client bundle never loads and the emulator sign-in page never completes. The setting affects only `next dev`; production builds ignore it.

The `Authenticated E2E Smoke` GitHub Actions workflow runs project validation, authenticated route smoke, and focused regression coverage on Linux for pull requests targeting `main` and manual dispatch. It sources fake emulator values from `.env.e2e.example`, uses the owned-emulator runner's `--smoke-only` mode (the whole Playwright run gets 35 minutes under `CI=true` and 15 locally; the workflow job limit is 45 minutes, leaving room for install, build and emulator start-up; `E2E_SUITE_TIMEOUT_MS` overrides it), and uploads debugging artifacts only on failure. Windows visual baselines are not compared in CI.

App Hosting serves the Next.js app. `apphosting.yaml` maps runtime-only `OPENAI_API_KEY` to Secret Manager secret `openaiApiKey` and supplies non-secret OpenAI model defaults, including the Luna overview model. AI model calls do not run during build. Firestore document creation under household notifications triggers the Node 24 Functions codebase for FCM delivery.

In the browser, `src/lib/firebase.ts` creates Firestore with `initializeFirestore(app, { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) })`: an IndexedDB cache shared by all open tabs. Documents already loaded can be read offline, and writes made offline wait in a persistent queue that survives reloads and syncs on reconnect. Server code (route handlers, server actions) keeps the default memory cache. If initialization throws (an existing instance during development hot reload), the module falls back to `getFirestore(app)`; the SDK itself falls back to a memory cache where IndexedDB is unavailable. Setting `NEXT_PUBLIC_FIRESTORE_MEMORY_CACHE=true` opts a build out of persistence.

`src/lib/firestore-offline.ts` wraps reads and writes for offline-aware screens: `getDocsOfflineAware`/`getDocOfflineAware` read straight from the cache when `navigator.onLine` is false (instead of waiting for Firestore to give up on the network), and `awaitWriteUnlessOffline` returns `'queued'` immediately offline because Firestore write promises resolve only after server acknowledgement.

Emulator runs (`NEXT_PUBLIC_USE_FIREBASE_EMULATORS=true`) use the memory cache instead: the E2E suite pins the browser clock, and the persistent cache logs server timestamps from "the future" as errors on every snapshot. No Auth persistence override is configured. Because emulator runs never use the persistent cache, the E2E suite covers the offline contract (optimistic tick, nothing sent while offline, sync on reconnect) but not cache restoration across reloads; that was checked by hand against a production build. Signing out flushes queued writes (up to 3 s) while still signed in, clears the persistent Firestore cache (`terminate` + `clearIndexedDbPersistence`), then signs out of Auth ([Identity and Profile](../identity-profile/README.md)), and always reloads once Firestore has been terminated, even if deleting the cache fails because another HomeHub tab still holds it, so cached household data does not stay on a shared device and no screen keeps a stopped Firestore instance.

App Check starts in `src/lib/firebase.ts` in the browser only (never in emulator mode) when `NEXT_PUBLIC_RECAPTCHA_ENTERPRISE_SITE_KEY` is set: a reCAPTCHA Enterprise score-based key (`HomeHub web App Check`) limited to `studio--homehub-j91jb.us-central1.hosted.app`, `homehub-j91jb.web.app` and `homehub-j91jb.firebaseapp.com`, registered as the App Check provider for web app `1:562837692805:web:a21c3805ca4921564d24ec` (token TTL 1 hour, auto-refresh). The public site key is set in `apphosting.yaml` for build and runtime. App Check validates the web app ID strictly: it must be the full `1:<project number>:web:<hash>` form. `apphosting.yaml` declares it, and `normalizeFirebaseAppId` (`src/lib/firebase-app-id.ts`) restores a missing `1:` prefix, because the value previously configured on App Hosting lacked it and every token exchange failed with "Invalid App ID". `localhost` is not an allowed domain; local development against the real project sets `NEXT_PUBLIC_APP_CHECK_DEBUG_TOKEN` to a debug token registered in the console.

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
- `aiUsage/{scope}_{id}_{day}` (server-only daily AI quota counters; rules deny all client access)

Storage paths cover household maintenance files, barcode images, pet images, and per-email avatars. `firestore.indexes.json` declares no composite indexes; its `fieldOverrides` hold the TTL policies on `notifications.expiresAt` and `aiUsage.expiresAt` (each with the field's default single-field indexes), deployed by the release workflow.

Direct temporary chores use the existing `chores` path with optional `templateId` and `sourceType: temporary`; no parallel collection or fake template is created. Maintenance logs preserved after registry deletion remove their live target ID and retain optional `formerTargetType`/`formerTargetName` history fields.

## Authentication, Roles, and Security

Rules use Firebase Auth UID/email and UID membership documents only; `households.memberEmails` and profile household fields grant nothing. Pending `newuser` members are blocked from ordinary household subcollections. Storage rules read the same membership records through cross-service `firestore.get()`, apply the same role presets and overrides, and enforce image-only uploads (5–10 MB) for pets, barcode images and avatars and a 15 MB document/image allowlist for maintenance attachments; every other path is denied. Cross-service reads require the Storage service agent to hold `roles/firebaserules.firestoreServiceAgent` (granted on `homehub-j91jb` 2026-11-06).

Home Assistant credentials under `home-automation/*` can be read and written only by members with `automation.manage`; every other role is denied. The app itself reads and writes them through authorized server actions.

Firestore rules explicitly map known household collections to the closest role/permission operation: chores/templates/rooms, shopping lists/items/config, pantry, barcode library, pets/logs, assets, vehicles, maintenance logs/attachments, notifications, audit logs, and automation configuration. Member-document permission overrides are honored, pending users are denied, and unknown household paths deny by default. Where one update can represent multiple product actions, rules use the narrowest existing permission without field-level semantic inference.

Protected AI, overview, and barcode server actions use Firebase Admin to verify the caller's ID token, household membership, pending status, role preset, and permission overrides before any Admin aggregation, public fallback, or OpenAI request. Authority comes only from the caller's approved `members/{uid}` record (`src/ai/household-authority.ts`); legacy email listings, owner email/UID fields and profile role/overrides grant nothing. App Hosting supplies Admin credentials through its runtime identity; no service-account key is committed.

App Check is registered but not enforced for Firestore, Storage or Auth. Enforcement is turned on only after the App Check metrics show production requests arriving with valid tokens, so legitimate clients are not cut off. Server-side code uses the Admin SDK, which App Check does not gate.

## Integrations and Background Processing

- Firebase Auth, Firestore, Storage, Cloud Messaging, Functions, and App Hosting.
- Cloud Functions: `sendPushOnNewNotification` (Firestore trigger) and `householdUpkeep` (every 60 minutes: recurring chores, 90-day completed-chore retention, maintenance and chore reminders). Shared, dependency-free rules live in `functions/src/shared/` and are imported by the web app through the `@functions/*` path alias.
- Household deletion is an Admin SDK server action (`src/app/household/actions.ts`), not a function.
- Environment names: `NEXT_PUBLIC_FIREBASE_API_KEY`, `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN`, `NEXT_PUBLIC_FIREBASE_PROJECT_ID`, `NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET`, `NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID`, `NEXT_PUBLIC_FIREBASE_APP_ID`, and `NEXT_PUBLIC_FIREBASE_VAPID_KEY`.
- E2E-only names: `NEXT_PUBLIC_USE_FIREBASE_EMULATORS`, `NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR_HOST`, `NEXT_PUBLIC_FIRESTORE_EMULATOR_HOST`, `NEXT_PUBLIC_FIREBASE_STORAGE_EMULATOR_HOST`, `FIREBASE_AUTH_EMULATOR_HOST`, `FIRESTORE_EMULATOR_HOST`, and `FIREBASE_STORAGE_EMULATOR_HOST`.
- AI runtime names: `OPENAI_API_KEY`, `OPENAI_DEFAULT_MODEL` (`gpt-5.6-luna`), `OPENAI_CATEGORIZATION_MODEL` (`gpt-5.6-luna`), `OPENAI_RECIPE_MODEL` (`gpt-5.6-terra`), `OPENAI_MAINTENANCE_MODEL` (`gpt-5.6-luna`), and `OPENAI_OVERVIEW_MODEL` (`gpt-5.6-luna`).
- `HOMEHUB_AI_TEST_MODE=deterministic` is accepted only by the exact demo emulator environment and is never enabled automatically in production.

## Cross-Module Dependencies

Every application module depends on this platform. [Notifications](../notifications/README.md) is the only current Functions trigger consumer; [Identity and Profile](../identity-profile/README.md) owns Auth/profile behavior; [Household Governance](../household-governance/README.md) owns membership semantics.

## Invariants and Failure Behavior

- User profile document IDs are email addresses; household membership document IDs are Auth UIDs.
- There is no legacy email fallback: an identity without an approved membership record has no household access in rules or server actions.
- Unknown household subcollections have no permissive fallback.
- Clients cannot delete notifications; expired ones are removed by the Firestore TTL policy on `notifications.expiresAt`, versioned in `firestore.indexes.json`.
- Functions remove invalid FCM tokens after failed sends.
- Push recipients are resolved from membership records (approved members only; targeted notifications reach only their target), and each recipient's profile is read directly by email for FCM tokens. No `users.uid` query is used.
- Creation rules require notification targets to be household members (UID membership record, or a profile pointing at the household), allow only `/`-relative deep links, and reject unknown fields.
- The E2E seed and Playwright config refuse non-loopback emulator hosts; the seed additionally requires the exact `demo-homehub-e2e` project.
- The emulator-only custom token route has no service-account secret and returns 404 unless emulator safety gates pass.
- CI artifacts exclude `playwright/.auth/`; only failure reports, traces, screenshots, videos, and emulator logs are uploaded.
- Normal CI/emulator commands do not need `OPENAI_API_KEY` and cannot call OpenAI through the deterministic test provider.
- The browser Firestore instance uses the persistent multi-tab cache; offline reads return cached data and offline writes are queued, never dropped. Security rules still apply when queued writes reach the server; a rejected write surfaces only through the caller's error handler.

- Dependency security overrides (root `package.json` `overrides`): `protobufjs ^7.6.6` and `@grpc/grpc-js ^1.14.7`. `@firebase/firestore` (Node build) and `google-gax` (through Genkit's Google Cloud logging) pin `grpc-js 1.9.x` / `protobufjs 7.2.x`, which carry critical protobufjs code-injection and grpc-js advisories. Both overrides stay within the same major version. Keep them until those upstream pins move past the fixed versions (`npm ls protobufjs @grpc/grpc-js --omit=dev` shows a single patched version of each), and run the rules, server and E2E suites after any change to them.

## Validation

- Run `npm.cmd run lint`, `npm.cmd run typecheck`, and `npm.cmd run build` for platform/config changes.
- Run `npm.cmd run test:e2e:local` for the seeded Auth/Firestore/Storage regression, smoke, and visual suite; install Chromium once with `npx.cmd playwright install chromium`.
- Run `npm.cmd run test:e2e:ci` to reproduce the GitHub Actions authenticated smoke/regression phase locally without visual comparison.
- Run `npm.cmd run test:ai` for key-free flow contracts and `npm.cmd run test:e2e:ai:local` for authenticated desktop/mobile AI workflows.
- In `functions/`, run `npm.cmd run lint` and `npm.cmd run build` for function changes.
- Run `npm.cmd run test:rules` for the Java-backed Firestore and Storage emulator matrix (roles, overrides, pending, legacy-only identities, ownership, invites, profiles, notifications, audit log, Home Assistant credentials, Storage paths and limits). CI runs it on every PR.
- After any production rules deploy, read the live rulesets back (`node scripts/deploy/verify-live-rules.mjs --project homehub-j91jb`); a deploy command or console save is not proof.
- Manually verify FCM delivery and invalid-token cleanup.

## Release Path for Rules and Indexes

App Hosting deploys only the Next.js app. `firestore.rules`, `storage.rules` and `firestore.indexes.json` are released by `.github/workflows/deploy-firebase-config.yml` on merge to `main`: it reruns the rules matrix, deploys with Workload Identity Federation (repository variables `GCP_WORKLOAD_IDENTITY_PROVIDER` and `GCP_DEPLOY_SERVICE_ACCOUNT`, `production` environment), then fails unless the live rulesets match the merged files.

## When This Document Must Be Updated

Update this README when Firebase initialization, environment names, deployment or CI configuration, emulator/E2E wiring, seed topology, collection/Storage topology, security rules, indexes, Functions, Auth/membership fallback, App Check/offline settings, or TTL requirements change.
