# Authenticated Firebase Emulator E2E and Visual Testing

## Purpose

This harness exercises the implemented HomeHub routes as an authenticated household owner while keeping Auth, Firestore, and Storage traffic on local emulators. It does not automate Google, use a real account, or load production Firebase data.

## Fixed Test Identity

- Auth UID: `e2e-owner-uid`
- Email: `alex.e2e@example.test`
- Display name: `Alex E2E`
- Household ID: `the-foxy-residence-e2e`
- Household name: `The Foxy Residence E2E`
- Project ID: `demo-homehub-e2e`

The seed also creates fake admin, member, pending, limited, and legacy identities plus a separate Household B owner and private records. Household A contains representative chores, shopping/pantry items, pets/logs, assets, a vehicle, maintenance logs, attachment metadata, audit activity, notifications, and barcode fixtures. Dates and document IDs are fixed so screenshots remain repeatable.

## Safety Model

The seed, Playwright configuration, and E2E token endpoint independently require:

- `NEXT_PUBLIC_USE_FIREBASE_EMULATORS=true`;
- `NEXT_PUBLIC_FIREBASE_PROJECT_ID=demo-homehub-e2e` or another `demo-` project where the check permits it;
- loopback `FIREBASE_AUTH_EMULATOR_HOST`;
- loopback `FIRESTORE_EMULATOR_HOST`.

Model-backed tests additionally set `HOMEHUB_AI_TEST_MODE=deterministic` and `HOMEHUB_TEST_NOW=2026-08-01T12:00:00.000Z`. The AI runtime accepts deterministic mode only for the exact `demo-homehub-e2e` project, loopback Auth/Firestore hosts, and a non-production Node process. It does not read `OPENAI_API_KEY` or make paid provider requests. Barcode fallback uses local fixtures in this mode and cannot contact production Open Food Facts.

The seed requires the exact `demo-homehub-e2e` project. Firebase client bootstrap connects to emulators only when the explicit public flag is true. `/e2e-login` and `/api/e2e/auth-token` are unavailable when emulator mode is off. The token uses an ephemeral local signing key and is intended only for the Auth Emulator.

Storage is emulated alongside Auth and Firestore so attachment workflows cannot reach a production bucket. Current visual fixtures still use attachment metadata and a repository-local sample document rather than real uploaded files. No credentials, production project aliases, Google accounts, Home Assistant tokens, or real Storage objects are used.

## Install

Install dependencies and the Chromium browser:

```powershell
npm.cmd install
npx.cmd playwright install chromium
```

Java is required by the Firestore Emulator.

## One-Command Run

Run emulators, deterministic seed, Next.js, authenticated smoke tests, and visual comparisons:

```powershell
npm.cmd run test:e2e:local
```

The wrapper supplies the safe environment from `scripts/e2e/environment.mjs`. It runs visual comparisons against a fresh seed, reseeds before smoke tests so route side effects cannot change later screenshots, and shuts down its owned emulator process tree after success, failure, interruption, or timeout.

Generate or intentionally replace visual baselines:

```powershell
npm.cmd run test:visual:update:local
```

Review screenshot changes before committing them. Baselines are stored beside the visual spec in Playwright snapshot directories.

## Split-Terminal Run

Use `.env.e2e.example` as a name/value reference. In each PowerShell terminal, set:

```powershell
$env:NEXT_PUBLIC_USE_FIREBASE_EMULATORS='true'
$env:NEXT_PUBLIC_FIREBASE_PROJECT_ID='demo-homehub-e2e'
$env:NEXT_PUBLIC_FIREBASE_API_KEY='fake-api-key'
$env:NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN='demo-homehub-e2e.firebaseapp.com'
$env:NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET='demo-homehub-e2e.appspot.com'
$env:NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID='000000000000'
$env:NEXT_PUBLIC_FIREBASE_APP_ID='1:000000000000:web:e2e'
$env:NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR_HOST='127.0.0.1:9099'
$env:NEXT_PUBLIC_FIRESTORE_EMULATOR_HOST='127.0.0.1:8080'
$env:FIREBASE_AUTH_EMULATOR_HOST='127.0.0.1:9099'
$env:FIRESTORE_EMULATOR_HOST='127.0.0.1:8080'
$env:FIREBASE_CLI_DISABLE_UPDATE_CHECK='true'
$env:HOMEHUB_AI_TEST_MODE='deterministic'
$env:HOMEHUB_TEST_NOW='2026-08-01T12:00:00.000Z'
```

Terminal 1:

```powershell
npx.cmd firebase emulators:start --project demo-homehub-e2e --only auth,firestore,storage
```

Terminal 2:

```powershell
npm.cmd run test:e2e:seed
npm.cmd run test:e2e
npm.cmd run test:visual
```

Playwright starts and stops the Next.js development server on port `9002`. Do not start another server on that port while tests run.

## Scripts

- `npm.cmd run test:e2e:seed`: cleanly reseed deterministic Auth and Firestore data; Auth, Firestore, and Storage emulators must already be running.
- `npm.cmd run test:e2e`: run authenticated route smoke tests.
- `npm.cmd run test:e2e:ui`: open Playwright UI; seed and emulators must already be ready.
- `npm.cmd run test:visual`: compare desktop/mobile screenshots.
- `npm.cmd run test:visual:update`: replace baselines against running emulators.
- `npm.cmd run test:e2e:all`: seed and run all Playwright projects against running emulators.
- `npm.cmd run test:e2e:local`: manage emulators and run the complete suite.
- `npm.cmd run test:e2e:ci`: manage emulators and run authenticated desktop/mobile route smoke plus focused verification-finding regressions, matching GitHub Actions without visual comparison.
- `npm.cmd run test:e2e:feature:local`: manage emulators and run the Temporary Task, chore bounds, maintenance deletion, dashboard, and shopping-inventory regression spec without visual comparison.
- `npm.cmd run test:e2e:ai:local`: manage emulators and run authenticated desktop/mobile AI, overview, barcode, partial-permission, and cross-household workflows using deterministic responses.
- `npm.cmd run test:ai`: run key-free schema, centralized-system/untrusted-data boundary, prompt-injection, model/reasoning, conservative legacy authority, failure, and barcode quantity checks.
- `npm.cmd run test:rules`: start only the Firestore Emulator and verify module permissions and Household A/B isolation.
- `npm.cmd run test:ai:openai:live`: optional manual provider smoke with fixed non-sensitive inputs; requires a securely loaded replacement key and is not part of CI.

## Covered Routes

The desktop and mobile Chromium projects cover `/`, `/household`, `/chores`, `/shopping`, `/pets`, `/maintenance`, `/automation`, `/notifications`, `/profile`, and `/library`. Route tests verify seeded authenticated content and reject login/onboarding UI. Focused regressions cover notification idempotency/dismissal, Maintenance deep links and schedule modes, shopping enrichment failures, barcode cleanup and authorized public fixtures, destructive confirmations, recurrence relevance, direct Temporary Tasks, maintenance registry cleanup, mobile inventory bounds, dashboard overflow, on-demand overview fallback/partial permissions, Household A/B denial, and deterministic OpenAI success/failure workflows. The visual spec captures full-page baselines separately.

Firebase Auth persistence is saved once per run at `playwright/.auth/e2e-owner.json`, including IndexedDB. Auth state, reports, traces, videos, and failure screenshots are ignored by Git.

## Failure Behavior

- A safety-check failure stops before seeding or browser startup.
- A missing emulator produces a failed seed or browser login rather than a production fallback.
- The E2E login route reports token/sign-in failures and remains disabled outside explicit emulator mode.
- The local wrapper propagates seed, Firebase CLI, and Playwright exit codes.

## GitHub Actions Smoke CI

`.github/workflows/e2e-smoke.yml` runs on pull requests targeting `main` and on manual dispatch. The Linux job uses Node 20, Temurin Java 21, npm's cache through `actions/setup-node`, and `npx playwright install --with-deps chromium`. It loads only fake values from `.env.e2e.example`, runs lint, type-checking, module-documentation validation, and a production build, then invokes `npm run test:e2e:ci`.

The CI command starts owned Auth, Firestore, and Storage emulator processes, seeds the fixed fake household, and runs authenticated route smoke plus focused regression coverage in desktop and mobile Chromium. Failures retain Playwright traces, screenshots, and videos through `test-results/`; the HTML report and Firebase emulator logs are also uploaded for 10 days. `playwright/.auth/` is deliberately excluded from artifacts.

On Windows, `scripts/e2e/environment.mjs` uses `java` from `PATH` or discovers an installed JDK under common `Program Files` locations. Every owned runner still has hard timeouts and terminates its emulator process tree on completion or failure. Local Playwright suites stop after six minutes; CI allows ten minutes for the same single-worker suite on a fresh Linux runner, within the workflow job's separate 25-minute limit.

Strict visual snapshot comparison is intentionally local-only. The committed baselines are Windows Chromium images, while GitHub Actions runs Linux Chromium; CI does not run `test:visual`, update snapshots, or treat cross-platform pixel differences as application regressions. Linux visual baselines can be evaluated in a separate follow-up.
