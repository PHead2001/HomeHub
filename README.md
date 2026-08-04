# HomeHub

HomeHub is a private household management app for desktop, tablet, and mobile use. It brings shared chores, shopping lists, pantry inventory, pet care, maintenance records, notifications, and Home Assistant entity-state viewing into one Firebase-backed Next.js app.

The app uses Firebase for authentication, Firestore data, Storage files, Cloud Functions, push notifications, and App Hosting. Genkit/OpenAI powers grocery categorization, recipe ideas, and maintenance-log summaries; a Genkit server flow coordinates household and public barcode lookup without invoking a model.

## Main Modules

### Dashboard
- Household overview with quick access to core modules.
- Responsive layout intended for phones, tablets, and desktop screens.

### Household Manager
- Household overview, member management, role presets, per-user permission overrides, temporary invite codes, and basic audit/system activity.
- New invite-code joiners enter a pending `newuser` approval state until an owner or admin assigns a household role.

### Chores
- One-time and recurring chores.
- Direct Temporary Tasks that create one assigned chore without a reusable template.
- Room-based organization with selectable icons.
- Subtasks, completion history, calendar view, and reminder notifications.

### Shopping and Pantry
- Multiple shopping lists by type.
- Grocery categorization with optional AI assistance and a manual/`Other` fallback.
- Barcode lookup using the household library first, then public product data.
- Pantry, fridge, and freezer inventory with expiry dates.
- Recipe ideas based on current pantry contents.

### Pets
- Pet profiles with photos and care details.
- Feeding, medication, and general care logs.

### Maintenance
- Maintenance Center with home asset and vehicle registries.
- General, asset-linked, and vehicle-linked maintenance logs.
- Confirmed asset/vehicle deletion that preserves linked logs as general history.
- AI summaries for longer maintenance notes.

### Automation
- Home Assistant connection using a household-scoped URL and long-lived access token.
- Read-only entity state viewing from the HomeHub UI; device-control service calls are not implemented.

## Tech Stack

- Next.js 15 App Router
- React 18 and TypeScript
- Tailwind CSS and shadcn-style UI components
- Firebase Auth, Firestore, Storage, Cloud Functions, Cloud Messaging, and App Hosting
- Genkit with the OpenAI compatibility provider

## Project Structure

```text
src/
  ai/                 Genkit flows and AI configuration
  app/                Next.js App Router pages and API routes
  components/         Shared UI and feature components
  contexts/           Auth and household state
  hooks/              React hooks
  lib/                Firebase config, shared types, utilities

functions/            Firebase Cloud Functions source
firestore.rules       Firestore security rules
storage.rules         Firebase Storage security rules
firebase.json         Firebase project configuration
```

## Module Documentation

The [module documentation registry](docs/modules/README.md) maps HomeHub's implemented capabilities to their routes, source files, data paths, security boundaries, integrations, and maintenance guidance. Use it as the first navigation point for feature work; executable code and configuration remain the source of truth.

## Local Setup

Install dependencies:

```bash
npm ci
```

Create a local environment file from the example:

```bash
cp .env.example .env.local
```

On PowerShell:

```powershell
Copy-Item .env.example .env.local
```

Fill in:

```env
NEXT_PUBLIC_FIREBASE_API_KEY=
NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=
NEXT_PUBLIC_FIREBASE_PROJECT_ID=
NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET=
NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID=
NEXT_PUBLIC_FIREBASE_APP_ID=
NEXT_PUBLIC_FIREBASE_VAPID_KEY=
OPENAI_API_KEY=
OPENAI_DEFAULT_MODEL=gpt-5-mini
OPENAI_CATEGORIZATION_MODEL=gpt-5-mini
OPENAI_RECIPE_MODEL=gpt-5-mini
OPENAI_MAINTENANCE_MODEL=gpt-5-mini
```

`OPENAI_API_KEY` is server-only. The per-flow variables are optional overrides and default to `gpt-5-mini`. Normal emulator and CI tests use an explicit deterministic provider and do not need a key or make paid API calls.

Run the app locally:

```bash
npm run dev
```

The dev server uses port `9002`.

For Firebase App Hosting, create or update the production secret interactively; never put its value in this repository:

```powershell
firebase apphosting:secrets:set openaiApiKey
```

`apphosting.yaml` exposes that secret only at runtime. A deployment is not ready for model traffic until the secret exists, backend access is granted, and the optional live smoke test has passed with the replacement key.

## Authenticated Emulator Testing

HomeHub includes a Firebase Emulator + Playwright harness for authenticated smoke and visual testing without Google sign-in or production data. It uses the fixed demo project `demo-homehub-e2e`, seeds `alex.e2e@example.test`, and hard-refuses non-loopback emulator hosts or non-demo project IDs.

Install the Chromium test browser once, then run the complete local suite:

```powershell
npx.cmd playwright install chromium
npm.cmd run test:e2e:local
```

The runner starts Auth, Firestore, and Storage emulators, seeds deterministic household data, starts Next.js on port `9002`, authenticates through the emulator-only custom-token route, and runs desktop/mobile smoke, regression, and visual tests. See [Authenticated Firebase Emulator E2E and Visual Testing](docs/testing/firebase-emulator-e2e.md) for split-terminal commands, snapshot updates, generated artifacts, and safety details.

Pull requests targeting `main` also run the `Authenticated E2E Smoke` GitHub Actions workflow. It validates lint, types, module docs, and the production build before running authenticated desktop/mobile route smoke coverage plus focused regression checks with `npm run test:e2e:ci`. Strict visual comparisons remain local-only because the committed baselines were generated on Windows and are not enforced against Linux rendering yet.

AI-specific checks:

```powershell
npm.cmd run test:ai
npm.cmd run test:e2e:ai:local
```

The optional paid provider smoke is manual-only and requires `OPENAI_API_KEY` already loaded securely in the process environment:

```powershell
npm.cmd run test:ai:openai:live
```

## Validation

Run lint:

```bash
npm run lint
```

Run a production build:

```bash
npm run build
```

TypeScript-only checking is also available:

```bash
npm run typecheck
```

Validate the module documentation registry, links, and required headings:

```bash
npm run docs:check
```

## Firebase

Deploy the app with Firebase App Hosting from this repo. The Firebase config also points at:

- `firestore.rules` for Firestore access control.
- `storage.rules` for Storage access control.
- `functions/` for Cloud Functions.

The push notification function lives in `functions/src/index.ts`. To work on functions locally:

```bash
cd functions
npm ci
npm run lint
npm run build
```

To deploy functions:

```bash
cd functions
npm run deploy
```

The service worker is served from `/api/sw` so Firebase public config can be injected at runtime.

## Data Isolation Notes

- Most household data is stored under `households/{householdId}` and is scoped by household membership in Firestore and Storage rules.
- Household membership is being formalized under `households/{householdId}/members/{uid}` while preserving legacy `users/{email}.householdId`, `users/{email}.role`, `households.memberEmails`, and `households.ownerEmail` fields for compatibility.
- Temporary invite codes are stored under `inviteCodes/{code}` and expire after 30 minutes. Joiners are added as pending `newuser` members until approved.
- In-app notifications are stored under `households/{householdId}/notifications` with per-user `readBy` and `dismissedBy` maps keyed by Firebase Auth UID.
- Home Assistant credentials are stored under the household document tree and should be treated as household-private data.
- Local `.env*` files are ignored by Git. Keep production secrets out of committed files.

## Notification Retention

Notification documents include an `expiresAt` field set to 7 days after `createdAt`. The UI filters expired notifications client-side. To physically remove expired documents, enable Firestore TTL on the `expiresAt` field for the `notifications` collection group in Firebase/GCP.

## License

Private household management project. All rights reserved.
