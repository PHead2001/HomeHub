# Identity and Profile

## Purpose and Scope

This module owns Firebase Authentication session handling, Google sign-in, email-keyed user profiles, personal settings, avatars, and logout. Household creation, membership, roles, and invites belong to Household Governance.

## User-Facing Capabilities

- Sign in with Google from the header login dialog ("Sign in to HomeHub"). Signed-out visitors to every signed-in-only page (`/chores`, `/calendar`, `/shopping`, `/library`, `/pets`, `/pets/[id]`, `/maintenance`, `/household`, `/profile`, `/automation`) see a `SignInPrompt` (`src/components/profile/sign-in-prompt.tsx`) with a real Sign in button that opens the same dialog, never a dead-end "Please log in" line (covered by `tests/e2e/dashboard-shell.spec.ts`).
- Cancel sign-in and return to an idle login state.
- View and edit personal profile fields at `/profile`.
- See your current avatar at the top of Personal Information: your photo, or the generated gradient avatar in your member color (`MemberAvatar`), with your name, role and household. Add, change or remove the photo (preview before saving, Undo / Keep photo). Unsupported types and files over 5 MB are explained inline (`FieldError`); the display name (2-60 characters) is validated inline.
- Choose appearance in Profile > Appearance: theme mode (Dark, Light, System), a dark preset (Midnight, Hearth, Forest) and a light preset (Light, Sunrise), Reduce motion, Sound effects (with a sample button) and Haptics (shown only where `navigator.vibrate` exists). Changes apply immediately; there is no save button.
- Configure chore reminder time/enabled state.
- Manage browser push-notification subscription.
- Log out.

## Entry Points

- `src/contexts/auth-context.tsx`
- `src/hooks/use-auth.ts`
- `src/components/login-dialog.tsx`
- `src/app/profile/page.tsx`
- `src/components/profile-client.tsx`
- `src/components/profile/sign-in-prompt.tsx`, `src/components/profile/profile-validation.ts` (avatar type/size check)
- `src/components/appearance-settings.tsx` (Profile > Appearance card)
- `src/components/appearance-provider.tsx` and `src/lib/theme/appearance.ts` (preference store, profile sync)
- `src/components/force-password-change-dialog.tsx`
- `src/app/api/e2e/auth-token/route.ts`
- `src/app/e2e-login/page.tsx`
- `src/components/e2e-login-client.tsx`
- Shared `User` type in `src/lib/types.ts`

## Architecture and Data Flow

`AuthProvider` listens to Firebase Auth state, loads or creates the email-keyed Firestore profile, then resolves household membership. It imports only the app and Auth (`@/lib/firebase-app`) statically; Firestore and `@/lib/firebase` (which starts App Check first) load with a dynamic `import()` inside each profile, membership, household or logout call, so signed-out visitors never download them. `loading` stays true until the profile read finishes, exactly as before. Google sign-in passes the warmed popup resolver from `src/lib/auth-popup.ts` to `signInWithPopup` (Auth itself is created without one); the landing and login-dialog Sign-in buttons warm it on pointer enter and focus. The force-password-change dialog (react-hook-form and zod) loads as its own chunk only for members who must change their password. The login dialog uses a Google popup and requests additional profile fields through Google scopes. Profile edits merge into the current user's document and refresh context state.

Popup cancellation produces `Login canceled.` and clears loading in `finally`.

`updateUser(data, newPassword?, { silent: true })` skips the global loading state and the success toast; it is used for background preference sync (a failed write still shows the error toast).

Appearance: `AppearanceSettings` calls `useAppearance().setPreferences(...)`. The provider writes all preferences to `localStorage["homehub.appearance"]` (read by the pre-paint theme script) and, for a signed-in member, writes the synced part to the profile with a silent `updateUser({ theme })` when the mode, a preset or Reduce motion changes. On each sign-in the profile's synced values (when present) replace this device's copy once; Sound and Haptics never leave the device. Theme changes reveal in a circle from the chosen option (instant under reduced motion). The Reduce motion switch shows as on and disabled when the device already requests reduced motion.

For local E2E only, `/api/e2e/auth-token` returns an emulator custom token for an allowlisted fake test identity and `/e2e-login` exchanges it with `signInWithCustomToken`. The default remains `e2e-owner-uid`; limited, legacy, and Household B identities support isolation tests. Both paths are guarded by explicit emulator mode, the exact demo project, loopback Auth/Firestore hosts, and non-production runtime; normal and production authentication remain Google-only.

## Data Model and Persistence

- Profile: `users/{email}`.
- Avatar objects: `users/{email}/avatars/{uuid}.{extension}`.
- `User` includes Auth `uid`, email/name fields, avatar, role and permission compatibility fields, `householdId`, theme, chore settings, birthday, gender, force-password-change state, and `fcmTokens`.
- `theme` (an existing allow-listed field) holds `{ version: 2, mode: 'dark' | 'light' | 'system', darkPreset: 'midnight' | 'hearth' | 'forest', lightPreset: 'light' | 'sunrise', reduceMotion: boolean }`. Older profiles may still hold the legacy free-color shape `{ background, accent, backgroundHex, accentHex }`; it is ignored (curated presets replace free colors) and overwritten the next time the member changes appearance. No new profile keys or rules changes were needed.
- `preferences` (an existing allow-listed field) may hold `weather: { enabled: boolean, city: string }`, the dashboard's opt-in live weather and its city (see [Application Shell](../application-shell/README.md), "Live weather"). The member writes it with a merge, so other keys are kept; missing means off. No rules change was needed.
- New profiles default to `role: member` and `householdId: null`.
- `timeZone` (IANA name, at most 64 characters) is taken from the browser: whenever the profile loads and the browser's zone differs from the stored one, `AuthProvider` overwrites it (best effort; a failed write is ignored). Server-side upkeep uses it to decide when this person's overdue alert (after 07:00) and daily chore reminder fire; if it is missing or invalid, the household timezone is used.

Household compatibility fields are maintained by Household Governance, not ordinary profile editing.

## Authentication, Roles, and Security

Firestore rules allow a user to read/write their own email-keyed profile, allow same-household point reads, and prohibit listing the full `users` collection. Self-service updates are limited to an explicit profile-field allowlist.

Avatar Storage access requires the authenticated token email to match `{userEmail}`, and uploads must be images of at most 5 MB (`isImage(5 * 1024 * 1024)` in `storage.rules`); the profile form checks the same limits before uploading.

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
- Profile save, profile update and household creation failures show `friendlyError` text (via `toastError` or the auth context); raw Firebase messages are never shown. Saving chore reminders shows one "Reminder saved" toast (the profile write is silent on success).
- The emulator E2E endpoint returns 404 unless every safety condition is active and never uses a production service-account key.
- Avatar replacement does not establish a general cleanup contract for older avatar objects.
- Household resolution is asynchronous and has a separate loading state from Auth.
- Logout (`logout` in `src/contexts/auth-context.tsx`) outside emulator mode first calls `clearLocalFirestoreCache()` ([Firebase Platform](../firebase-platform/README.md)) while the member is still signed in, because the rules would reject queued writes after sign-out. That waits up to 3 s for queued writes, such as offline shopping ticks, to reach the server, terminates Firestore, and deletes the device's IndexedDB cache. Only then does it sign out of Firebase Auth. Once Firestore has been terminated the page always reloads to `/` (no toast), even if deleting the cache failed because another HomeHub tab still has it open; that failure is logged and the cache is cleared on a later sign-out. Writes still queued after 3 s are discarded with the cache. If Firestore could not be terminated, the member is signed out in place and sees the usual "Logged Out" toast. Emulator runs use the memory cache, skip this cleanup and show the toast.

## Validation

- Run `npm.cmd run lint` and `npm.cmd run typecheck` after identity/profile changes.
- Run `npm.cmd run test:e2e:local` to verify emulator custom-token sign-in and persisted authenticated state.
- Manually test successful Google sign-in, popup cancellation, provider failure, profile creation, profile editing, avatar upload, Profile > Appearance (mode, presets, Reduce motion, Sound, Haptics; reload without flash; sync to a second browser after sign-in), push subscription, and logout (in a production build, confirm the page reloads to `/` and DevTools > Application shows no `firestore/` IndexedDB database afterwards).
- Verify self-profile updates reject membership-field spoofing and unrelated users cannot list profiles.

## When This Document Must Be Updated

Update this README when auth providers/scopes, emulator-only auth gates, profile fields or paths, avatar handling, personal settings, FCM token storage, login/logout failure behavior, or profile security rules change.
