# Application Shell and Dashboard

## Purpose and Scope

This module owns the root layout, global providers and overlays, primary navigation, dashboard, shared visual shell, and global error/toast placement. It does not own feature data or feature-specific authorization rules.

## User-Facing Capabilities

- View dashboard module cards at `/`.
- Generate a transient AI Overview whose exact metrics come from authorized household data.
- Navigate through permission-filtered desktop header links and avatar actions.
- On phones, navigate with a fixed bottom tab bar (Home, Chores, Shopping, Pets) and a More sheet (Maintenance, Automation, Household, Barcode Library, Profile).
- Open profile, household management, barcode library, notifications, and logout controls.
- Receive create/join-household and pending-approval overlays.
- Apply personal theme settings across the application.

## Entry Points

- `src/app/layout.tsx`
- `src/app/page.tsx`
- `src/app/globals.css`
- `src/components/header.tsx`
- `src/components/mobile-tab-bar.tsx`
- `src/components/dashboard-card.tsx`
- `src/components/household-manager.tsx`
- `src/components/theme-injector.tsx`
- `src/components/FirebaseErrorListener.tsx`
- `src/components/password-change-handler.tsx`
- `src/app/e2e-login/page.tsx`
- `src/components/e2e-login-client.tsx`
- `src/components/ui/*`

## Architecture and Data Flow

The root layout installs `AuthProvider`, foreground push handling, Firebase error reporting, theme injection, password-change handling, household-state overlays, the header, and global toasts around every route. The dashboard includes static module links and the on-demand `HomeAiOverview`; it makes no overview request on page load and does not persist results.

Dashboard card carousels contain their own horizontal movement. Their navigation controls remain inset from the carousel edge at every viewport so neither the carousel nor the document gains horizontal overflow.

Below the `md` breakpoint, `MobileTabBar` renders a fixed bottom navigation bar inside `HouseholdManager`, after `<main>`; at `md` and wider it is hidden. Primary tabs are Home, Chores, Shopping, and Pets; a More tab opens a bottom sheet with Maintenance, Automation, Household, Barcode Library, and Profile. The active tab or sheet item is marked with `aria-current="page"`, and More is highlighted when the current route is one of its items. The bar is not rendered for users without a household, without a loaded member record, or with role `newuser`.

The root `viewport` export sets `viewportFit: 'cover'`. The tab bar pads its bottom by `env(safe-area-inset-bottom)` and the More sheet adds the same inset to its bottom padding, so content clears the home indicator. On phones `<main>` reserves `calc(4rem + env(safe-area-inset-bottom))` of bottom padding (the 4rem bar height plus the inset) so page content is not hidden behind the bar; `md:pb-0` removes it on larger screens. This padding applies whenever `<main>` renders on a phone, including when the bar itself is hidden.

Header and phone tab bar navigation derive visibility from effective permissions. Dashboard cards are not permission-filtered. Overview metrics and generated sections are filtered by verified server-side effective permissions.

## Data Model and Persistence

The shell owns no Firestore documents. It consumes `User`, `Household`, `HouseholdMember`, and permission data supplied by auth/household context. Overview facts are transient and the optional model narrative remains component state.

Theme values are persisted by the identity/profile module and injected as CSS variables by `ThemeInjector`.

## Authentication, Roles, and Security

- Logged-out users see normal route content plus login controls.
- Signed-in users without a household receive the create/join overlay.
- Members with role `newuser` receive a waiting-for-approval overlay on routes other than `/profile`.
- Desktop navigation uses `hasPermission`. The phone tab bar and More sheet omit (rather than disable) items whose view permission the member lacks: `chores.view`, `shopping.view`, `pets.view`, `maintenance.view`, `automation.view`, and `household.view`; Home, Barcode Library, and Profile are always listed. Direct routes and dashboard links still depend on feature code and Firebase rules.

The overlays visually cover child routes but do not unmount them, so child effects can still execute. Security must be enforced by rules and module code, not by the overlay alone.

## Integrations and Background Processing

The shell mounts foreground Firebase Cloud Messaging handling and links to the notification bell. The overview calls the authenticated AI server module only after `Generate Overview` or `Regenerate Overview`; provider failure leaves exact facts visible. Fonts use `next/font`. No shell-owned Cloud Function or scheduled job exists.

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
