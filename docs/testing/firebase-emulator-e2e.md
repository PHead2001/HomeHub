# Authenticated Firebase Emulator E2E and Visual Testing

## Purpose

This harness exercises the implemented HomeHub routes as an authenticated household owner while keeping Auth and Firestore traffic on local emulators. It does not automate Google, use a real account, or load production Firebase data.

## Fixed Test Identity

- Auth UID: `e2e-owner-uid`
- Email: `alex.e2e@example.test`
- Display name: `Alex E2E`
- Household ID: `the-foxy-residence-e2e`
- Household name: `The Foxy Residence E2E`
- Project ID: `demo-homehub-e2e`

The seed also creates fake admin, member, and pending-member records plus representative chores, shopping/pantry items, pets/logs, assets, a vehicle, maintenance logs, attachment metadata, audit activity, and notifications. Dates and document IDs are fixed so screenshots remain repeatable.

## Safety Model

The seed, Playwright configuration, and E2E token endpoint independently require:

- `NEXT_PUBLIC_USE_FIREBASE_EMULATORS=true`;
- `NEXT_PUBLIC_FIREBASE_PROJECT_ID=demo-homehub-e2e` or another `demo-` project where the check permits it;
- loopback `FIREBASE_AUTH_EMULATOR_HOST`;
- loopback `FIRESTORE_EMULATOR_HOST`.

The seed requires the exact `demo-homehub-e2e` project. Firebase client bootstrap connects to emulators only when the explicit public flag is true. `/e2e-login` and `/api/e2e/auth-token` are unavailable when emulator mode is off. The token uses an ephemeral local signing key and is intended only for the Auth Emulator.

Storage is not emulated because the current visual fixtures need only attachment metadata and a repository-local sample document. No credentials, production project aliases, Google accounts, Home Assistant tokens, or real Storage objects are used.

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
```

Terminal 1:

```powershell
npx.cmd firebase emulators:start --project demo-homehub-e2e --only auth,firestore
```

Terminal 2:

```powershell
npm.cmd run test:e2e:seed
npm.cmd run test:e2e
npm.cmd run test:visual
```

Playwright starts and stops the Next.js development server on port `9002`. Do not start another server on that port while tests run.

## Scripts

- `npm.cmd run test:e2e:seed`: seed Auth and Firestore; emulators must already be running.
- `npm.cmd run test:e2e`: run authenticated route smoke tests.
- `npm.cmd run test:e2e:ui`: open Playwright UI; seed and emulators must already be ready.
- `npm.cmd run test:visual`: compare desktop/mobile screenshots.
- `npm.cmd run test:visual:update`: replace baselines against running emulators.
- `npm.cmd run test:e2e:all`: seed and run all Playwright projects against running emulators.
- `npm.cmd run test:e2e:local`: manage emulators and run the complete suite.

## Covered Routes

The desktop and mobile Chromium projects cover `/`, `/household`, `/chores`, `/shopping`, `/pets`, `/maintenance`, `/automation`, `/notifications`, `/profile`, and `/library`. Each test verifies a route heading and seeded content, rejects login/onboarding UI, and captures a full-page visual baseline.

Firebase Auth persistence is saved once per run at `playwright/.auth/e2e-owner.json`, including IndexedDB. Auth state, reports, traces, videos, and failure screenshots are ignored by Git.

## Failure Behavior

- A safety-check failure stops before seeding or browser startup.
- A missing emulator produces a failed seed or browser login rather than a production fallback.
- The E2E login route reports token/sign-in failures and remains disabled outside explicit emulator mode.
- The local wrapper propagates seed, Firebase CLI, and Playwright exit codes.

The harness is local-only for now. No GitHub Actions workflow existed when it was added, so CI installation/caching of Java, Firebase emulators, Playwright Chromium, and visual artifacts remains a follow-up.
