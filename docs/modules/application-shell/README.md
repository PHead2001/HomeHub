# Application Shell and Dashboard

## Purpose and Scope

This module owns the root layout, global providers and overlays, primary navigation, dashboard, shared visual shell, and global error/toast placement. It does not own feature data or feature-specific authorization rules.

## User-Facing Capabilities

- View Quick Actions and module cards at `/`.
- Navigate through permission-filtered desktop header links and avatar actions.
- Open profile, household management, barcode library, notifications, and logout controls.
- Receive create/join-household and pending-approval overlays.
- Apply personal theme settings across the application.

## Entry Points

- `src/app/layout.tsx`
- `src/app/page.tsx`
- `src/app/globals.css`
- `src/components/header.tsx`
- `src/components/dashboard-card.tsx`
- `src/components/household-manager.tsx`
- `src/components/theme-injector.tsx`
- `src/components/FirebaseErrorListener.tsx`
- `src/components/password-change-handler.tsx`
- `src/app/e2e-login/page.tsx`
- `src/components/e2e-login-client.tsx`
- `src/components/ui/*`

## Architecture and Data Flow

The root layout installs `AuthProvider`, foreground push handling, Firebase error reporting, theme injection, password-change handling, household-state overlays, the header, and global toasts around every route. The dashboard is a static set of links into implemented feature routes.

Dashboard card carousels contain their own horizontal movement. Their navigation controls move inside the viewport on small screens so the document itself does not gain horizontal overflow.

Header navigation derives visibility from effective permissions. Dashboard cards and Quick Actions are not permission-filtered.

## Data Model and Persistence

The shell owns no Firestore documents. It consumes `User`, `Household`, `HouseholdMember`, and permission data supplied by auth/household context.

Theme values are persisted by the identity/profile module and injected as CSS variables by `ThemeInjector`.

## Authentication, Roles, and Security

- Logged-out users see normal route content plus login controls.
- Signed-in users without a household receive the create/join overlay.
- Members with role `newuser` receive a waiting-for-approval overlay on routes other than `/profile`.
- Desktop navigation uses `hasPermission`; direct routes and dashboard links still depend on feature code and Firebase rules.

The overlays visually cover child routes but do not unmount them, so child effects can still execute. Security must be enforced by rules and module code, not by the overlay alone.

## Integrations and Background Processing

The shell mounts foreground Firebase Cloud Messaging handling and links to the notification bell. Fonts use `next/font`. No shell-owned Cloud Function, external API, or scheduled job exists.

Authenticated emulator tests enter through `/e2e-login`; that route is rendered only for an explicit demo-project emulator configuration and delegates custom-token sign-in to the identity module.

## Cross-Module Dependencies

- [Identity and Profile](../identity-profile/README.md) supplies session/profile state and theme.
- [Household Governance](../household-governance/README.md) supplies membership and effective role state.
- [Notifications](../notifications/README.md) supplies the bell and foreground push side effects.
- Every product module supplies its own route and data behavior.

## Invariants and Failure Behavior

- Global providers must remain ordered so all consumers are inside `AuthProvider`.
- Dashboard links may expose navigation that the header hides; destination security is authoritative.
- Firebase errors are converted to global toasts through the error emitter/listener pair.
- Shell loading and household overlays must not be treated as proof that route effects did not run.
- At 360 px and wider supported mobile viewports, dashboard carousel overflow must remain component-local and the document must not scroll horizontally.

## Validation

- Run `npm.cmd run lint` and `npm.cmd run typecheck` after shell changes.
- Run `npm.cmd run test:e2e:local` for seeded desktop/mobile shell and route coverage.
- Manually test desktop/mobile navigation for logged-out, no-household, approved, and pending users.
- Check each role's header visibility and verify dashboard destinations remain secured.
- Verify theme injection, global toasts, notification bell, and password-change overlay placement.

## When This Document Must Be Updated

Update this README when root providers, global overlays, navigation, dashboard entry points, permission-based visibility, theme injection, error handling, emulator-only test entry, or route-shell ownership changes.
