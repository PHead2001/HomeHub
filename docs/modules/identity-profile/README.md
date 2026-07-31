# Identity and Profile

## Purpose and Scope

This module owns Firebase Authentication session handling, Google sign-in, email-keyed user profiles, personal settings, avatars, and logout. Household creation, membership, roles, and invites belong to Household Governance.

## User-Facing Capabilities

- Sign in with Google from the header login dialog.
- Cancel sign-in and return to an idle login state.
- View and edit personal profile fields at `/profile`.
- Upload an avatar and select personal theme colors.
- Configure chore reminder time/enabled state.
- Manage browser push-notification subscription.
- Log out.

## Entry Points

- `src/contexts/auth-context.tsx`
- `src/hooks/use-auth.ts`
- `src/components/login-dialog.tsx`
- `src/app/profile/page.tsx`
- `src/components/profile-client.tsx`
- `src/components/image-upload.tsx`
- `src/components/theme-injector.tsx`
- `src/components/force-password-change-dialog.tsx`
- `src/app/api/e2e/auth-token/route.ts`
- `src/app/e2e-login/page.tsx`
- `src/components/e2e-login-client.tsx`
- Shared `User` type in `src/lib/types.ts`

## Architecture and Data Flow

`AuthProvider` listens to Firebase Auth state, loads or creates the email-keyed Firestore profile, then resolves household membership. The login dialog uses a Google popup and requests additional profile fields through Google scopes. Profile edits merge into the current user's document and refresh context state.

Popup cancellation produces `Login canceled.` and clears loading in `finally`.

For local E2E only, `/api/e2e/auth-token` returns an emulator custom token for the fixed fake owner and `/e2e-login` exchanges it with `signInWithCustomToken`. Both paths are guarded by explicit emulator mode, a `demo-` project ID, and loopback Auth/Firestore hosts; normal and production authentication remain Google-only.

## Data Model and Persistence

- Profile: `users/{email}`.
- Avatar objects: `users/{email}/avatars/{uuid}.{extension}`.
- `User` includes Auth `uid`, email/name fields, avatar, role and permission compatibility fields, `householdId`, theme, chore settings, birthday, gender, force-password-change state, and `fcmTokens`.
- New profiles default to `role: member` and `householdId: null`.

Household compatibility fields are maintained by Household Governance, not ordinary profile editing.

## Authentication, Roles, and Security

Firestore rules allow a user to read/write their own email-keyed profile, allow same-household point reads, and prohibit listing the full `users` collection. Self-service updates are limited to an explicit profile-field allowlist.

Avatar Storage access requires the authenticated token email to match `{userEmail}`. Storage rules currently impose no avatar size or content-type limit.

## Integrations and Background Processing

- Firebase Authentication uses Google popup sign-in.
- Authenticated Playwright setup uses Firebase Auth Emulator custom-token sign-in and persists browser Auth IndexedDB under ignored `playwright/.auth/`.
- Firebase Cloud Messaging stores tokens in `users/{email}.fcmTokens`.
- Firebase web configuration comes from the `NEXT_PUBLIC_FIREBASE_*` variables documented in `.env.example`.
- No identity-owned Cloud Function or scheduled job exists.

## Cross-Module Dependencies

- [Household Governance](../household-governance/README.md) resolves and updates membership, roles, and legacy compatibility fields.
- [Notifications](../notifications/README.md) manages FCM subscription and consumes stored tokens.
- [Application Shell and Dashboard](../application-shell/README.md) mounts auth context and profile/theme consumers.
- [Firebase Platform](../firebase-platform/README.md) owns Firebase initialization and rules.

## Invariants and Failure Behavior

- Firestore user document IDs are email addresses; sign-in requires an Auth email.
- Profile listing is intentionally denied.
- Sign-in failures surface a specific toast and reset the spinner; tokens and credentials are not logged.
- The emulator E2E endpoint returns 404 unless every safety condition is active and never uses a production service-account key.
- Avatar replacement does not establish a general cleanup contract for older avatar objects.
- Household resolution is asynchronous and has a separate loading state from Auth.

## Validation

- Run `npm.cmd run lint` and `npm.cmd run typecheck` after identity/profile changes.
- Run `npm.cmd run test:e2e:local` to verify emulator custom-token sign-in and persisted authenticated state.
- Manually test successful Google sign-in, popup cancellation, provider failure, profile creation, profile editing, avatar upload, theme application, push subscription, and logout.
- Verify self-profile updates reject membership-field spoofing and unrelated users cannot list profiles.

## When This Document Must Be Updated

Update this README when auth providers/scopes, emulator-only auth gates, profile fields or paths, avatar handling, personal settings, FCM token storage, login/logout failure behavior, or profile security rules change.
