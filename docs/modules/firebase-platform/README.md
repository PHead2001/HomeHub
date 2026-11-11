# Firebase Platform, Persistence, and Security

## Purpose and Scope

This module owns Firebase client bootstrap, deployment configuration, shared persistence topology, Firestore/Storage rules, and Cloud Functions runtime. Feature modules own their documents and workflows within these platform boundaries.

## User-Facing Capabilities

This is a platform module with no standalone page. It provides authentication, household data persistence, file storage, push transport, and App Hosting support to all product modules.

## Entry Points

- `src/lib/firebase-app.ts` (app and Auth only)
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
- `.github/workflows/e2e-smoke.yml` (also runs `npm run test:unit`, every `tests/unit/*.test.ts` file)

## Architecture and Data Flow

The Firebase web SDK initializes singleton Auth, Firestore, and Storage services. Messaging initialization is browser- and support-guarded.

When `NEXT_PUBLIC_USE_FIREBASE_EMULATORS=true`, the client connects Auth, Firestore, and Storage to configured emulator hosts and requires a `demo-` project ID. Playwright starts Next.js with this explicit configuration, signs in through an emulator-only custom-token endpoint, and reuses Auth state including IndexedDB. Production/default initialization does not connect to emulators. Playwright drives the Next.js dev server at `http://127.0.0.1:9002`; Next.js 16 blocks dev-server resources requested from any origin other than localhost, so `next.config.ts` sets `allowedDevOrigins: ['127.0.0.1']`. Without it the client bundle never loads and the emulator sign-in page never completes. The setting affects only `next dev`; production builds ignore it.

The `Authenticated E2E Smoke` GitHub Actions workflow runs project validation, authenticated route smoke, and focused regression coverage on Linux for pull requests targeting `main` and manual dispatch. It sources fake emulator values from `.env.e2e.example`, uses the owned-emulator runner's `--smoke-only` mode (the whole Playwright run gets 35 minutes under `CI=true` and 15 locally; the workflow job limit is 45 minutes, leaving room for install, build and emulator start-up; `E2E_SUITE_TIMEOUT_MS` overrides it), and uploads debugging artifacts only on failure. Windows visual baselines are not compared in CI.

App Hosting serves the Next.js app. `apphosting.yaml` maps runtime-only `OPENAI_API_KEY` to Secret Manager secret `openaiApiKey` and supplies non-secret OpenAI model defaults, including the Luna overview model. AI model calls do not run during build. Firestore document creation under household notifications triggers the Node 24 Functions codebase for FCM delivery.

**Split initialization (first-paint budget).** `src/lib/firebase-app.ts` initializes the Firebase app and Auth (plus the Auth emulator connection and the `demo-` project check) and nothing else. In the browser Auth is created with `initializeAuth` exactly as `getAuth` would: the same persistence order (IndexedDB, localStorage, sessionStorage) and Firebase's standard `browserPopupRedirectResolver`. The resolver is kept on purpose: Firebase starts Google's sign-in scripts early on mobile browsers and Safari, so the Google popup opens within the click and is not blocked. Sign-in calls `signInWithPopup(auth, provider)` with no resolver override. **Accepted trade-off (owner decision):** those early scripts load before first paint on mobile, which once held the signed-out landing at mobile Lighthouse Performance 83–87 against the H03 target of 90. Since the push listener stopped loading Firestore and App Check for signed-out visitors (#103), five production mobile runs scored 96, 97, 92, 96 and 96 with the popup resolver kept. Server code keeps `getAuth`. it is all the root layout and `AuthProvider` load, so signed-out pages never download Firestore, Storage, Messaging or App Check, unless the device carries the signed-in hint (next sentences). `src/lib/firebase.ts` re-exports `auth`, `firebaseConfig` and `firebaseEmulatorMode` from it and keeps every existing export (`db`, `storage`, `getFirebaseMessaging`, `clearLocalFirestoreCache`), so module code that imports `@/lib/firebase` is unchanged. Shell code that runs for every visitor loads `@/lib/firebase` and `firebase/firestore` only with a dynamic `import()` once a user is known (`AuthProvider`'s profile and membership reads and writes, the weather preference write), or speculatively at mount on a device with the signed-in hint (`localStorage["homehub.session"] === "1"`, written while someone is signed in and removed whenever Auth resolves with nobody signed in): `AuthProvider` then starts the data stack, App Check included, alongside the session restore, and `src/app/page.tsx` starts the dashboard chunk, so a repeat visit doesn't wait for them after Auth (H01). A stale hint (signed out elsewhere) costs that download once; it's never initialized for visitors without the hint, or as its own chunk (`NotificationBell`, `CommandPalette`, and `PushNotificationManager` after `load` and idle, whose Firebase half, `PushForegroundListener`, loads only for a signed-in member). An eslint `no-restricted-imports` rule in `eslint.config.mjs` stops `layout.tsx`, `template.tsx`, `auth-context.tsx`, `firebase-app.ts`, the header, the command center, the deferred push manager, the page transition and the dashboard's time-of-day and weather hook from importing `@/lib/firebase`, Firestore, Storage, Messaging, App Check, `@/lib/firestore-offline` or `motion/react` statically.

In the browser, `src/lib/firebase.ts` creates Firestore with `initializeFirestore(app, { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) })`: an IndexedDB cache shared by all open tabs. Documents already loaded can be read offline, and writes made offline wait in a persistent queue that survives reloads and syncs on reconnect. Server code (route handlers, server actions) keeps the default memory cache. If initialization throws (an existing instance during development hot reload), the module falls back to `getFirestore(app)`; the SDK itself falls back to a memory cache where IndexedDB is unavailable. Setting `NEXT_PUBLIC_FIRESTORE_MEMORY_CACHE=true` opts a build out of persistence.

`src/lib/firestore-offline.ts` wraps reads and writes for offline-aware screens: `getDocsOfflineAware`/`getDocOfflineAware` read straight from the cache when `navigator.onLine` is false (instead of waiting for Firestore to give up on the network), and `awaitWriteUnlessOffline` returns `'queued'` immediately offline because Firestore write promises resolve only after server acknowledgement.

Emulator runs (`NEXT_PUBLIC_USE_FIREBASE_EMULATORS=true`) use the memory cache instead: the E2E suite pins the browser clock, and the persistent cache logs server timestamps from "the future" as errors on every snapshot. No Auth persistence override is configured. Because emulator runs never use the persistent cache, the E2E suite covers the offline contract (optimistic tick, nothing sent while offline, sync on reconnect) but not cache restoration across reloads; that was checked by hand against a production build. Signing out flushes queued writes (up to 3 s) while still signed in, clears the persistent Firestore cache (`terminate` + `clearIndexedDbPersistence`), then signs out of Auth ([Identity and Profile](../identity-profile/README.md)), and always reloads once Firestore has been terminated, even if deleting the cache fails because another HomeHub tab still holds it, so cached household data does not stay on a shared device and no screen keeps a stopped Firestore instance.

App Check starts in `src/lib/firebase.ts`, before `getFirestore` and `getStorage` run in that module, so every Firestore and Storage request on every path still carries a token (the only way to reach Firestore or Storage is through that module). It starts in the browser only (never in emulator mode) when `NEXT_PUBLIC_RECAPTCHA_ENTERPRISE_SITE_KEY` is set: a reCAPTCHA Enterprise score-based key (`HomeHub web App Check`) limited to `studio--homehub-j91jb.us-central1.hosted.app`, `homehub-j91jb.web.app` and `homehub-j91jb.firebaseapp.com`, registered as the App Check provider for web app `1:562837692805:web:a21c3805ca4921564d24ec` (token TTL 1 hour, auto-refresh). The public site key is set in `apphosting.yaml` for build and runtime. App Check validates the web app ID strictly: it must be the full `1:<project number>:web:<hash>` form. `apphosting.yaml` declares it, and `normalizeFirebaseAppId` (`src/lib/firebase-app-id.ts`) restores a missing `1:` prefix, because the value previously configured on App Hosting lacked it and every token exchange failed with "Invalid App ID". `localhost` is not an allowed domain; local development against the real project sets `NEXT_PUBLIC_APP_CHECK_DEBUG_TOKEN` to a debug token registered in the console.

**App Check enforcement (console setting, not in `firebase.json`).** Since 2026-11-06, App Check is **enforced** for Cloud Firestore and Cloud Storage and **not enforced** for Firebase Authentication (`identitytoolkit`). Firestore was enforced after six hours of production traffic showed every request from the web app carrying a valid token, with none missing or invalid. Requests without a valid token, from scripts or other origins, are now refused before rules run (`DENY / MISSING_UNKNOWN_ORIGIN` in the App Check metrics). Storage was enforced after a synthetic-object test (an object under `appcheck-probe/`, deleted afterwards) showed that tokenized download URLs (`...?alt=media&token=...`, used by `<img>` and the Next.js image optimizer) keep working once enforcement is live, while tokenless API calls get `401 Firebase App Check token is invalid`. Enforcement takes several minutes to take effect after a change. Server code uses the Admin SDK, which App Check does not apply to. Rollback, if a legitimate client is ever blocked: set the service back to *Unenforced* in Firebase console > App Check > APIs, or PATCH `projects/562837692805/services/{firestore|firebasestorage}.googleapis.com` with `enforcementMode: UNENFORCED`. Any new client (another web origin, a native app, a local build against the real project) must have its App Check provider or a debug token registered **before** it ships.

## Data Model and Persistence

Primary topology:

- `users/{email}`
- `users/{email}/private/push` (owner-only push tokens)
- `households/{householdId}`
- `households/{householdId}/members/{uid}` (also the public member data housemates read: name, photo, role, status, join time; `householdName` for people who joined by invite)
- `households/{householdId}/members/{uid}/private/contact` (the member's email; server-written, readable by the person and holders of `household.manageMembers` with `household.view`; see [Household Governance](../household-governance/README.md), "Member contact")
- `households/{householdId}/notifications/{notificationId}`
- `households/{householdId}/auditLogs/{auditId}`
- `households/{householdId}/chores/{choreId}`
- `households/{householdId}/chore-templates/{templateId}`
- `households/{householdId}/rooms/{roomId}`
- `households/{householdId}/chore-settings/preferences` (household chore preferences: `leaderboardEnabled`)
- `households/{householdId}/stats/chores-{year}` (yearly totals of completed chores that retention removed: `year`, `completed`, `byAssignee`, `names`, `updatedAt`; written only by server upkeep)
- `households/{householdId}/shopping-lists/{listId}` with `items` and `config/categories`
- `households/{householdId}/pantry-inventory/{itemId}`
- `households/{householdId}/barcode-library/{barcode}`
- `households/{householdId}/pets/{petId}` with nested log collections
- `households/{householdId}/home-assets/{assetId}`
- `households/{householdId}/vehicles/{vehicleId}`
- `households/{householdId}/maintenance/{logId}`
- `households/{householdId}/maintenance-attachments/{attachmentId}`
- `households/{householdId}/home-automation/credentials` (server-only; rules deny all client access)
- `inviteCodes/{code}`
- `aiUsage/{scope}_{id}_{day}` (server-only daily AI quota counters; rules deny all client access)

Storage paths cover household maintenance files, barcode images, pet images, and per-person avatars (`users/{uid}/avatars/**` for new uploads, `users/{email}/avatars/**` for older ones; see [Identity and Profile](../identity-profile/README.md), "Profile photos"). `firestore.indexes.json` declares five composite indexes on `notifications` (collection scope): (`audience` array-contains, `createdAt` DESC) for the audience-filtered window of the bell, center and dashboard tile; (`audience` array-contains, `category` ASC, `createdAt` DESC) for the same window when a member who cannot see every module also filters by category; (`audience` array-contains, `sourceType` ASC) and (`audience` array-contains, `sourceType` ASC, `sourceId` ASC) for the maintenance resolvers that clear reminders after completion, snooze or deletion; and (`category` ASC, `createdAt` DESC), which no current query uses and is kept for clients cached from before the audience filter (see [Notifications](../notifications/README.md)); its `fieldOverrides` hold the TTL policies on `notifications.expiresAt` and `aiUsage.expiresAt` (each with the field's default single-field indexes), deployed by the release workflow.

Chores and chore templates carry `assignedToUid` next to the legacy `assignedToEmail` (dual-written; `scripts/ops/backfill-chore-assignee-uid.mjs` fills older records; see [Chores](../chores/README.md), "Assignee identity"). Direct temporary chores use the existing `chores` path with optional `templateId` and `sourceType: temporary`; no parallel collection or fake template is created. One-time library assignments are written with `sourceType: template`; generated recurring instances have none. Completed chores may carry `completedAtServer` (a server timestamp written with the completion). Maintenance logs preserved after registry deletion remove their live target ID and retain optional `formerTargetType`/`formerTargetName` history fields.

## Authentication, Roles, and Security

Rules use Firebase Auth UID/email and UID membership documents only; `households.memberEmails` and profile household fields grant nothing. Pending `newuser` members are blocked from ordinary household subcollections. Storage rules read the same membership records through cross-service `firestore.get()`, apply the same role presets and overrides, and enforce image-only uploads (5–10 MB) for pets, barcode images and avatars and a 15 MB document/image allowlist for maintenance attachments; every other path is denied. Cross-service reads require the Storage service agent to hold `roles/firebaserules.firestoreServiceAgent` (granted on `homehub-j91jb` 2026-11-06).

Household management is server-only in the rules: clients cannot create or delete households, change a household's `name`, `ownerUid`, `ownerEmail` or `memberEmails` (owners and admins may still set `timeZone`), write membership records (their own included), write `inviteCodes` or `auditLogs`, or write anyone's profile household fields except clearing their own stale pointer. Holders of `household.manageInvites` read their household's invite codes and holders of `household.manageMembers` read the audit log, each only while they also hold `household.view` (role defaults and overrides both count; the owner always holds both). The server actions write all of these with the Admin SDK; see [Household Governance](../household-governance/README.md), "Household writes are server-only in the rules".

Home Assistant credentials under `home-automation/*` are denied to every client, owners included; only the authorized server actions read and write them with the Admin SDK.

Profiles: `birthday` and `gender` can no longer be added or changed (existing values stay readable and removable until `scripts/ops/purge-profile-demographics.mjs` runs), and push tokens live in the owner-only `users/{email}/private/push`; the legacy `fcmTokens` profile field may only shrink. See [Identity and Profile](../identity-profile/README.md). Notification `deepLink` values must be `/`-relative with no second leading slash or backslash and no control characters.

Storage barcode images (`households/{householdId}/barcode-library/**`): read with `shopping.view`, create or replace with `shopping.edit` as an image (png, jpeg, webp, gif, heic, heif, avif) of at most 5 MB, delete with `shopping.delete` (owners and admins by default). Covered by `tests/rules/storage.rules.test.ts`.

Firestore rules explicitly map known household collections to the closest role/permission operation: chores/templates/rooms, shopping lists/items/config, pantry, barcode library, pets/logs, assets, vehicles, maintenance logs/attachments, notifications, audit logs, and automation configuration. Member-document permission overrides are honored, pending users are denied, and unknown household paths deny by default. Where one update can represent multiple product actions, rules use the narrowest existing permission without field-level semantic inference.

Content shapes (audit QA-8, BL-17): client writes to chores, chore templates, shopping lists, items and category config, pet feeding/medication/care logs, maintenance logs, home assets, vehicles and the barcode library are validated by small per-collection `valid*Fields()` functions in `firestore.rules`: a field allowlist, value types and size bounds. Each allowlist is a superset of every field any shipped client writes, including offline-queued writes from older releases. Only the keys a write sets are checked (`writtenKeys()`: every key on create; on update only keys it adds or changes), so a document that still holds a legacy field stays updatable on its other fields, a legacy field cannot be rewritten, and removing a field is allowed, except where a field is server-owned: on chores, clients may never set, change or remove `completedByUid`, `completedByEmail`, `completedByName` and `completionId` (only the Admin SDK writes them), `occurrenceKey` is immutable for clients, and a client completion is refused while the chore still carries someone's completion attribution (see [Chores](../chores/README.md)); and pantry checks the resulting document (below). Bounds are deliberately generous (several times the UI limits) so no form input that saved before is refused. Chores and templates also enforce `chores.assign` for assignment to someone else, pet logs enforce their author (feeding logs also their server `loggedAt`, the author's 10-minute delete window, and the paired `feeding-state/current` document; see Pets), maintenance records enforce `householdId`, and barcode products restrict `imageUrl`; see each module README. The barcode `imageUrl` rule names this project's buckets (`homehub-j91jb.appspot.com`, `homehub-j91jb.firebasestorage.app`) and the Storage emulator for `demo-` projects, so a deployment to another Firebase project must update `validBarcodeImageUrl()`. Pantry inventory is shape-checked too (stage S4a): legacy and v2 fields are both accepted, `addedByUid` is the writer on create and never changes, and on every update the resulting document is checked (`pantryUpdateAttributed`), so an update that changes a v2 field or removes any field must set `updatedByUid` to the writer and `updatedAt` to the request time; the one exception is an older page's legacy-only update (`pantryLegacyOnlyUpdate`: `name`, `quantity`, `unit`, `location` or `expiryDate`, nothing removed), which stage S4b removes. See [Pantry and Recipes](../pantry-recipes/README.md). Rooms and pet profiles are still permission-only. Admin SDK writers bypass all of this. Covered by the `content shapes` suites in `tests/rules/firestore.rules.test.ts`.

Shopping item attribution (release 2.1): items also accept `nameKey`, `categorySource`, `size` and `sizeUnit`, and `addedByUid` / `restoredByUid`. `addedByUid` must be the writer on create, or another existing household member when `restoredByUid` is the writer (Undo of a delete); both are immutable afterwards. Details in [Shopping](../shopping/README.md).

Chore completion stamp: the `chores.complete` field allowlist is `isCompleted`, `completedAt`, `completedSubTasks` and `completedAtServer`. On every chore create and update, a chore that becomes completed must carry `completedAtServer == request.time`; a missing or client-chosen stamp is denied. A chore that stays completed must keep its stamp unchanged, so completions can't be backdated. Chores completed before the stamp existed stay editable and can be reopened. `chore-settings/preferences` is readable with `chores.view` and writable only by owners and admins (role, not overrides), only at the `preferences` ID and only with `leaderboardEnabled` (bool) and `updatedAt` (string); delete is denied. Both are covered in `tests/rules/firestore.rules.test.ts`. `stats/{statId}` is readable with `chores.view` and never writable by clients (`allow write: if false`); only the Admin SDK upkeep step writes it. Also covered in `tests/rules/firestore.rules.test.ts`.

Chore completion attribution (rules stage R1): `completedByUid`, `completedByEmail`, `completedByName`, `completionId` and `occurrenceKey` are on the chore allowlist but written only by the Admin SDK (the completion server actions and upkeep): clients may not set them on create or set, change or remove them on update, and a client completion is denied while the chore carries attribution. Stage R2 (clients may not change `isCompleted`) is the next release's step; see [Chores](../chores/README.md).

Protected AI, overview, and barcode server actions use Firebase Admin to verify the caller's ID token, household membership, pending status, role preset, and permission overrides before any Admin aggregation, public fallback, or OpenAI request. Authority comes only from the caller's approved `members/{uid}` record (`src/ai/household-authority.ts`); legacy email listings, owner email/UID fields and profile role/overrides grant nothing. App Hosting supplies Admin credentials through its runtime identity; no service-account key is committed.

App Check is **enforced** for Firestore and Storage and not enforced for Auth (see "App Check enforcement" above for the evidence, propagation delay and rollback). Requests without a valid App Check token from the registered web app are refused before security rules run; tokenized Storage download URLs keep working. Server-side code uses the Admin SDK, which App Check does not gate. A new client must be registered with App Check before it ships.

## Integrations and Background Processing

- Firebase Auth, Firestore, Storage, Cloud Messaging, Functions, and App Hosting.
- Cloud Functions: `sendPushOnNewNotification` (Firestore trigger) and `householdUpkeep` (every 60 minutes, and on demand through `syncHouseholdUpkeep`: recurring chores, 90-day completed-chore retention, maintenance and chore reminders, and pet medication reminders, for which it reads every pet and all of its `medication-logs`, creates a `pet_medication` notification when a countdown is due or overdue, resolves it in a transaction that re-reads the pet's entries once a newer dose is logged or the pet is deleted, and reopens a resolved reminder whose countdown or schedule is actionable again). See [Notifications](../notifications/README.md). Shared, dependency-free rules live in `functions/src/shared/` and are imported by the web app through the `@functions/*` path alias.
- Functions SDKs (`functions/package.json`, Node 24): `firebase-admin` ^14 and `firebase-functions` ^7. Since the 12 -> 14 upgrade, `functions/src/index.ts` uses the modular Admin API only: `initializeApp` from `firebase-admin/app`, `getFirestore`/`FieldValue`/`Timestamp` from `firebase-admin/firestore` and `getMessaging` from `firebase-admin/messaging`; the namespaced `admin.*` API is not used and shouldn't be reintroduced. `firebase-functions-test` was removed (unused, and its `firebase-admin` peer range blocks 14). After any change to these SDKs, run `npm --prefix functions ci`, `npm --prefix functions run lint` and `npm --prefix functions run build` (as CI does), then the server and E2E suites; the deploy workflow redeploys functions from `main`, and the live check is that both functions, `sendPushOnNewNotification` and `householdUpkeep`, report the new build and keep running without errors (`syncHouseholdUpkeep` is a web-app server action in `src/app/chores/actions.ts`, deployed with App Hosting, not a function).
- Household deletion, joining, leaving, household management (rename, invites, roles, permissions, removal, ownership transfer) and copying your own name and photo onto your membership record (`syncMyMemberProfileAction`) are Admin SDK server actions (`src/app/household/actions.ts`), not functions. The rules deny the same writes from clients; see [Household Governance](../household-governance/README.md).
- Environment names: `NEXT_PUBLIC_FIREBASE_API_KEY`, `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN`, `NEXT_PUBLIC_FIREBASE_PROJECT_ID`, `NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET`, `NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID`, `NEXT_PUBLIC_FIREBASE_APP_ID`, and `NEXT_PUBLIC_FIREBASE_VAPID_KEY`.
- E2E-only names: `NEXT_PUBLIC_USE_FIREBASE_EMULATORS`, `NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR_HOST`, `NEXT_PUBLIC_FIRESTORE_EMULATOR_HOST`, `NEXT_PUBLIC_FIREBASE_STORAGE_EMULATOR_HOST`, `FIREBASE_AUTH_EMULATOR_HOST`, `FIRESTORE_EMULATOR_HOST`, and `FIREBASE_STORAGE_EMULATOR_HOST`.
- AI runtime names: `OPENAI_API_KEY`, `OPENAI_DEFAULT_MODEL` (`gpt-6-luna`), `OPENAI_CATEGORIZATION_MODEL` (`gpt-6-luna`), `OPENAI_RECIPE_MODEL` (`gpt-6.1-terra`), `OPENAI_MAINTENANCE_MODEL` (`gpt-6-luna`), and `OPENAI_OVERVIEW_MODEL` (`gpt-6-luna`).
- `HOMEHUB_AI_TEST_MODE=deterministic` is accepted only by the exact demo emulator environment and is never enabled automatically in production.

## Cross-Module Dependencies

Every application module depends on this platform. [Notifications](../notifications/README.md) is the only current Functions trigger consumer; [Identity and Profile](../identity-profile/README.md) owns Auth/profile behavior; [Household Governance](../household-governance/README.md) owns membership semantics.

## Invariants and Failure Behavior

- User profile document IDs are email addresses; household membership document IDs are Auth UIDs.
- There is no legacy email fallback: an identity without an approved membership record has no household access in rules or server actions.
- Unknown household subcollections have no permissive fallback.
- Clients cannot delete notifications; expired ones are removed by the Firestore TTL policy on `notifications.expiresAt`, versioned in `firestore.indexes.json`.
- Functions remove invalid FCM tokens after failed sends.
- Push recipients are resolved from membership records (approved members only; targeted notifications reach only their target; module categories reach only members with that module's view permission), and each recipient's profile is read directly by email for FCM tokens. No `users.uid` query is used.
- Creation rules require notification targets to be household members (UID membership record, or a profile pointing at the household), allow only `/`-relative deep links, and reject unknown fields. An `audience` list is optional on create and, when present, must match the targeting (`[targetUserUid]`, or `['*']` when untargeted); clients cannot change it later. Read rules do not check it yet.
- The E2E seed and Playwright config refuse non-loopback emulator hosts; the seed additionally requires the exact `demo-homehub-e2e` project.
- The emulator-only custom token route has no service-account secret and returns 404 unless emulator safety gates pass.
- CI artifacts exclude `playwright/.auth/`; only failure reports, traces, screenshots, videos, and emulator logs are uploaded.
- Normal CI/emulator commands do not need `OPENAI_API_KEY` and cannot call OpenAI through the deterministic test provider.
- The browser Firestore instance uses the persistent multi-tab cache; offline reads return cached data and offline writes are queued, never dropped. Security rules still apply when queued writes reach the server; a rejected write surfaces only through the caller's error handler.

- Dependency security overrides (root `package.json` `overrides`): `protobufjs ^7.6.6` and `@grpc/grpc-js ^1.14.7`. `@firebase/firestore` (Node build) and `google-gax` (through `firebase-admin`'s Firestore client) pin `grpc-js 1.9.x` / `protobufjs 7.2.x`, which carry critical protobufjs code-injection and grpc-js advisories. Both overrides stay within the same major version. Keep them until those upstream pins move past the fixed versions (`npm ls protobufjs @grpc/grpc-js --omit=dev` shows a single patched version of each), and run the rules, server and E2E suites after any change to them.

## Validation

- Run `npm.cmd run lint`, `npm.cmd run typecheck`, and `npm.cmd run build` for platform/config changes.
- Run `npm.cmd run test:e2e:local` for the seeded Auth/Firestore/Storage regression, smoke, and visual suite; install Chromium once with `npx.cmd playwright install chromium`.
- Run `npm --prefix functions ci`, `npm --prefix functions run lint` and `npm --prefix functions run build` after any Functions or Functions-SDK change.
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
