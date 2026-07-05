# HomeHub

HomeHub is a private household management app for desktop, tablet, and mobile use. It brings shared chores, shopping lists, pantry inventory, pet care, maintenance records, notifications, and Home Assistant control into one Firebase-backed Next.js app.

The app uses Firebase for authentication, Firestore data, Storage files, Cloud Functions, push notifications, and App Hosting. Genkit/Gemini powers grocery categorization, recipe ideas, barcode lookup assistance, and maintenance-log summaries.

## Main Modules

### Dashboard
- Household overview with quick access to core modules.
- Responsive layout intended for phones, tablets, and desktop screens.

### Household Manager
- Household overview, member management, role presets, per-user permission overrides, temporary invite codes, and basic audit/system activity.
- New invite-code joiners enter a pending `newuser` approval state until an owner or admin assigns a household role.

### Chores
- One-time and recurring chores.
- Room-based organization with selectable icons.
- Subtasks, completion history, calendar view, and reminder notifications.

### Shopping and Pantry
- Multiple shopping lists by type.
- Grocery categorization with AI assistance.
- Barcode lookup using the household library first, then public product data.
- Pantry, fridge, and freezer inventory with expiry dates.
- Recipe ideas based on current pantry contents.

### Pets
- Pet profiles with photos and care details.
- Feeding, medication, and general care logs.

### Maintenance
- Maintenance Center with home asset and vehicle registries.
- General, asset-linked, and vehicle-linked maintenance logs.
- AI summaries for longer maintenance notes.

### Automation
- Home Assistant connection using a household-scoped URL and long-lived access token.
- Entity state viewing from the HomeHub UI.

## Tech Stack

- Next.js 15 App Router
- React 18 and TypeScript
- Tailwind CSS and shadcn-style UI components
- Firebase Auth, Firestore, Storage, Cloud Functions, Cloud Messaging, and App Hosting
- Genkit with Google AI

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
GEMINI_API_KEY=
```

Run the app locally:

```bash
npm run dev
```

The dev server uses port `9002`.

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
