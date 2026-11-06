# Application Shell and Dashboard

## Purpose and Scope

This module owns the root layout, global providers and overlays, primary navigation, dashboard, the shared visual shell and design foundation (color tokens and theme presets, surfaces, focus ring, motion system, route loading skeletons, ambient background, sound/haptic feedback API), and global error/toast placement. It does not own feature data or feature-specific authorization rules.

## User-Facing Capabilities

- View dashboard module cards at `/`.
- Generate a transient AI Overview whose exact metrics come from authorized household data.
- Navigate through permission-filtered desktop header links and avatar actions. The current page's header link is shown in the foreground color with an accent underline that slides between links.
- On phones, navigate with a fixed bottom tab bar (Home, Chores, Shopping, Pets) and a More sheet (Maintenance, Automation, Household, Barcode Library, Profile).
- Open profile, household management, barcode library, notifications, and logout controls.
- Receive create/join-household and pending-approval overlays.
- See the chosen theme (Dark, Light or System mode with curated presets) from the first paint, without a flash of the default theme.
- Route changes crossfade page content (the header and tab bar stay put); every route shows a layout-matched skeleton while it loads, and navigations slower than 150 ms show a thin top progress bar.
- With Reduce motion (system setting or the in-app switch), every transition renders its end state instantly.

## Entry Points

- `src/app/layout.tsx`
- `src/app/page.tsx`
- `src/app/globals.css`
- `src/components/header.tsx`
- `src/components/mobile-tab-bar.tsx`
- `src/components/dashboard-card.tsx`
- `src/components/household-manager.tsx`
- `src/app/template.tsx` and every `src/app/**/loading.tsx`
- `src/components/route-skeletons.tsx`
- `src/components/appearance-provider.tsx`
- `src/components/motion/*` (`PageTransition`, `NavigationProgress`, `AmbientBackground`, `GlowCard`/`GlowPointerTracker`, `Stagger`/`StaggerItem`, `NumberTicker`)
- `src/hooks/use-reduced-motion.ts`, `src/hooks/use-morph-navigation.ts`
- `src/lib/theme/tokens.ts`, `src/lib/theme/appearance.ts`, `src/lib/theme/contrast.ts`
- `src/lib/motion.ts`, `src/lib/member-colors.ts`, `src/lib/feedback.ts`, `src/lib/navigation.ts`
- `tailwind.config.ts`
- `src/components/FirebaseErrorListener.tsx`
- `src/components/password-change-handler.tsx`
- `src/app/e2e-login/page.tsx`
- `src/components/e2e-login-client.tsx`
- `src/components/ui/*`

## Architecture and Data Flow

The root layout renders the color tokens for every theme preset and an inline theme script in `<head>`, the ambient background, then installs `AuthProvider`, `AppearanceProvider` (theme, motion preference and feedback settings, wrapping everything in motion's `MotionConfig`), the navigation progress bar, the glow pointer tracker, the cross-route morph listener, foreground push handling, Firebase error reporting, password-change handling, household-state overlays, the header, and global toasts around every route. `src/app/template.tsx` wraps page content in `PageTransition`; because templates remount on navigation and layouts do not, only page content animates. The dashboard includes static module links and the on-demand `HomeAiOverview`; it makes no overview request on page load and does not persist results.

Dashboard card carousels contain their own horizontal movement. Their navigation controls remain inset from the carousel edge at every viewport so neither the carousel nor the document gains horizontal overflow.

Below the `md` breakpoint, `MobileTabBar` renders a fixed bottom navigation bar inside `HouseholdManager`, after `<main>`; at `md` and wider it is hidden. Primary tabs are Home, Chores, Shopping, and Pets; a More tab opens a bottom sheet with Maintenance, Automation, Household, Barcode Library, and Profile. The active tab or sheet item is marked with `aria-current="page"`, and More is highlighted when the current route is one of its items. The bar is not rendered for users without a household, without a loaded member record, or with role `newuser`.

The root `viewport` export sets `viewportFit: 'cover'`. The tab bar pads its bottom by `env(safe-area-inset-bottom)` and the More sheet adds the same inset to its bottom padding, so content clears the home indicator. On phones `<main>` reserves `calc(4rem + env(safe-area-inset-bottom))` of bottom padding (the 4rem bar height plus the inset) so page content is not hidden behind the bar; `md:pb-0` removes it on larger screens. This padding applies whenever `<main>` renders on a phone, including when the bar itself is hidden.

The desktop header (`<nav aria-label="Main">`) marks the current link with `aria-current="page"`, the foreground color and an accent underline (a motion `layoutId="header-nav-underline"` element) that slides to the new link on navigation. Header and phone tab bar share `isActiveRoute` from `src/lib/navigation.ts`.

Header and phone tab bar navigation derive visibility from effective permissions.

### Design foundation

**Color tokens.** Every color is an HSL channel token defined once per theme preset in `src/lib/theme/tokens.ts` (`PRESETS`) and emitted by `themeCss()` into `<head>` as `:root[data-theme="<preset>"]` rules (Midnight doubles as the `:root` fallback). Tailwind maps them to classes: surfaces `background`/`card`/`popover` (aliases `surface-base`/`surface-raised`/`surface-overlay`), `foreground`, `muted(-foreground)`, `secondary`, `primary` (brand accent for fills, links, selection), `accent` (a subtle hover/selected surface, not the brand color), status `destructive`/`success`/`warning`/`info` (each usable as text on any surface and as a fill with its `-foreground`), `border` (component boundaries, at least 3:1), `border-subtle` (decorative dividers), `input`, `ring`, `scrim` (dialog backdrops), `chart-1..5`, and `member-1..8` with `member-foreground`. Code outside the token files uses these classes or `hsl(var(--token))`, never raw color literals (the Google logo in the login dialog keeps Google's mandated colors). Non-color tokens live in `src/app/globals.css`: one radius scale (`--radius`, Tailwind `rounded-sm` to `rounded-2xl`), elevation shadows (`shadow-raised` for cards, `shadow-overlay` for dialogs, popovers, menus, sheets and toasts, each with a soft shadow and a 1 px inner highlight), the focus ring, and motion durations/easings.

**Presets and contrast.** Dark presets: Midnight (default), Hearth, Forest. Light presets: Light, Sunrise. Each preset sets its own foreground on filled colors (bright accents carry dark text in dark presets; deep accents carry white text in light presets), so filled buttons are AA (D01). In dark presets each elevation level is lighter than the one below. `tests/unit/theme-contrast.test.ts` (`npm run test:unit`) asserts at least 4.5:1 for every text pair (including accent, status and member colors as text on base/raised/overlay/muted surfaces and on their 10-15% tints) and at least 3:1 for borders, inputs, the focus ring and filled controls.

**Theme application.** `<html>` is server-rendered with `data-theme="midnight"` and class `dark` (`suppressHydrationWarning`). The inline script from `themeBootstrapScript()` runs before first paint and before hydration: it reads `localStorage["homehub.appearance"]`, resolves System mode with `prefers-color-scheme`, sets `data-theme`, the `dark`/`light` class (for Tailwind `dark:` variants) and the `theme-color` meta, and sets `data-motion="reduce"` when reduced motion applies. It never throws; invalid stored values fall back to defaults. After hydration `AppearanceProvider` keeps `<html>` in sync (OS theme changes in System mode, other tabs via the `storage` event, profile sync). Switching themes uses the View Transitions API: the new theme is revealed in an expanding circle (`clip-path`, 520 ms) from the control that changed it; where the API is missing or motion is reduced the switch is instant.

**Focus.** One ring for every interactive element: a base `:focus-visible` rule draws a 2 px `--ring` outline with a 2 px offset (`--focus-ring-width`, `--focus-ring-offset`). Components do not add their own focus rings; menu items keep their highlight and inset the ring (`-outline-offset-2`).

**Surfaces and effects.** The header, phone tab bar and sheets use `surface-glass` (frosted overlay surface, mostly opaque so text keeps its contrast). `AmbientBackground` paints two slow aurora blobs (`--ambient-1`/`--ambient-2`) and a faint grain behind the shell at the preset's single intensity token `--ambient-intensity` (5-7%); loops are 32 s and 41 s, paused while the tab is hidden (`<html data-visibility="hidden">`) and static under reduced motion. Any element with the `glow-card` class (or `<GlowCard>`) gets a pointer-following spotlight and brightening border from the single delegated `GlowPointerTracker`; it runs only for `(hover: hover) and (pointer: fine)` and changes only pseudo-element layers, never the element's position. Dashboard cards and Maintenance asset/vehicle cards use it; `hover:bg-accent` is now a subtle surface lift instead of a solid teal fill (D10).

**Per-member colors.** `memberColor(uid)` (`src/lib/member-colors.ts`) returns a deterministic slot 1-8 (FNV-1a hash of the id) with `color`, `foreground`, `soft` tint and static Tailwind classes (`text-member-N`, `bg-member-N`, `ring-member-N`, `chip`, `softChip`). `memberColorMap(uids)` assigns collision-free colors for up to eight members regardless of input order. Member colors are AA as text on every surface and as chip fills in every preset.

**Motion system.** `motion` (pinned `14.3.1`, React 18 compatible) is the only animation library; import from `motion/react`. Budgets and helpers live in `src/lib/motion.ts` (`DURATION`, `EASE`, `SPRING_UI`, `SPRING_SNAPPY`, `STAGGER`, `staggerDelay`, `PAGE_ENTER`). Contract for all motion: when reduced motion is on (system `prefers-reduced-motion` or the in-app switch), `<html>` carries `data-motion="reduce"`; `useReducedMotion()` from `src/hooks/use-reduced-motion.ts` returns the combined value; `MotionConfig` disables transform/layout animation and zeroes default transitions; and global CSS collapses every CSS animation and transition under both `@media (prefers-reduced-motion: reduce)` and `:root[data-motion="reduce"]`. New CSS animations must honor both selectors.

- Route transitions: `PageTransition` fades page content in with an 8 px settle (220 ms). The first page of a session is not animated, so content never waits for hydration.
- Loading: every route has a `loading.tsx` built from `src/components/route-skeletons.tsx` that mirrors the page's container, header and first content block; skeletons expose a polite `role="status"` label. `NavigationProgress` shows a 2 px top bar only when an internal link navigation has not committed after 150 ms (it gives up after 10 s).
- Overlays: dialogs, alert dialogs, sheets, popovers, dropdown/menubar menus, selects and tooltips enter on a spring curve (`.ease-spring-enter`, `--ease-spring` is motion's `spring(0.25, 0.2)` as a CSS `linear()` easing, 220 ms; kept in sync by a unit test). Sheets open in 220 ms (previously 500 ms).
- `transition-ui` is the one scoped transition utility (color, background, border, opacity, shadow, transform at 150 ms); `transition-all` is no longer used.
- `Stagger`/`StaggerItem` give lists at most 30 ms per item and 400 ms total; `NumberTicker` ticks numbers in 400-700 ms, gives screen readers the final value immediately and reserves the final width so nothing shifts.
- Shared-element morphs: name elements with `sharedId(kind, id, part)`. Within one route, use motion `layoutId={sharedId(...)}`. Across routes, put `style={morphStyle(sharedId(...))}` on the element on both pages and navigate with `useMorphNavigation().navigate(href)`, which wraps `router.push` in a View Transition (old snapshot held at most 800 ms; plain push where unsupported or reduced). `MorphRouteListener` in the root layout completes pending morphs when the route commits.

**Feedback.** `playFeedback('complete' | 'add' | 'celebrate')` from `src/lib/feedback.ts` plays a short Web Audio tone (at most 400 ms, no audio files) and/or a `navigator.vibrate` pattern, only when the member enabled Sound or Haptics in Profile > Appearance; it is a silent no-op otherwise and never throws. Dashboard cards are not permission-filtered. Overview metrics and generated sections are filtered by verified server-side effective permissions.

## Data Model and Persistence

The shell owns no Firestore documents. It consumes `User`, `Household`, `HouseholdMember`, and permission data supplied by auth/household context. Overview facts are transient and the optional model narrative remains component state.

Appearance preferences are stored in `localStorage["homehub.appearance"]` (mode, dark and light preset, reduce motion, sound, haptics) for pre-paint use, and the synced part is persisted by the identity/profile module in the existing `users/{email}.theme` field (see [Identity and Profile](../identity-profile/README.md)). Sound and haptics stay device-local.

## Authentication, Roles, and Security

- Logged-out users see normal route content plus login controls.
- Signed-in users without a household receive the create/join overlay.
- Members with role `newuser` receive a waiting-for-approval overlay on routes other than `/profile`.
- Desktop navigation uses `hasPermission`. The phone tab bar and More sheet omit (rather than disable) items whose view permission the member lacks: `chores.view`, `shopping.view`, `pets.view`, `maintenance.view`, `automation.view`, and `household.view`; Home, Barcode Library, and Profile are always listed. Direct routes and dashboard links still depend on feature code and Firebase rules.

While either overlay is shown, `HouseholdManager` renders only the overlay: the header and child routes are not mounted, so their effects do not run. Children do render while household state is still loading and for logged-out users. Security must be enforced by rules and module code, not by the overlay alone.

## Integrations and Background Processing

The shell mounts foreground Firebase Cloud Messaging handling and links to the notification bell. The overview calls the authenticated AI server module only after `Generate Overview` or `Regenerate Overview`; provider failure leaves exact facts visible. Fonts (Inter for body text, Space Grotesk for headings, exposed as `--font-inter` and `--font-space-grotesk`) are bundled at build time from the `@fontsource-variable/inter` and `@fontsource-variable/space-grotesk` packages (Latin subset, variable weights) through `next/font/local` in `src/app/layout.tsx`; builds never download fonts, so a Google Fonts outage cannot fail a build or a deploy. No shell-owned Cloud Function or scheduled job exists.

Authenticated emulator tests enter through `/e2e-login`; that route is rendered only for an explicit demo-project emulator configuration and delegates custom-token sign-in to the identity module.

## Cross-Module Dependencies

- [Identity and Profile](../identity-profile/README.md) supplies session/profile state, hosts Profile > Appearance, and persists the synced appearance preferences.
- Every module consumes the design foundation (tokens, `memberColor`, motion components, `useReducedMotion`, `playFeedback`).
- [Household Governance](../household-governance/README.md) supplies membership and effective role state.
- [Notifications](../notifications/README.md) supplies the bell and foreground push side effects.
- Every product module supplies its own route and data behavior.

## Invariants and Failure Behavior

- Global providers must remain ordered so all consumers are inside `AuthProvider`.
- Dashboard links may expose navigation that the header hides; destination security is authoritative.
- Firebase errors are converted to global toasts through the error emitter/listener pair.
- The household overlays replace child routes, but shell loading does not: children mount while household state is resolving, so loading must not be treated as proof that route effects did not run.
- At 360 px and wider supported mobile viewports, dashboard carousel overflow must remain component-local and the document must not scroll horizontally.
- The theme script must stay dependency-free and must not throw; if storage is blocked the default dark theme applies and in-session changes still work.
- No animation delays content, errors or focus: the first page is not animated, loading skeletons match page layout, overlays remain interactive during their enter animation, and the progress bar is decorative (`aria-hidden`).
- `html { scrollbar-gutter: stable }` keeps pages from shifting sideways when a scrollbar appears.
- Ambient and glow effects are decorative (`aria-hidden`, `pointer-events: none`) and must keep text contrast; new ambient effects get one intensity token per preset.

## Validation

- Run `npm.cmd run lint` and `npm.cmd run typecheck` after shell changes.
- Run `npm.cmd run test:e2e:local` for seeded desktop/mobile shell and route coverage.
- Manually test desktop/mobile navigation for logged-out, no-household, approved, and pending users.
- Check each role's header visibility and verify dashboard destinations remain secured.
- `tests/e2e/appearance.spec.ts` (desktop Chromium) picks a dark preset from Profile > Appearance and checks that the view transition's update callback still sees the old theme (the circular reveal needs the old snapshot), that the choice syncs to `users/{email}.theme` (version 2) and that it is kept on reload.
- Run `npm.cmd run test:unit` for preset contrast, the pre-paint theme script, member colors, feedback and motion tokens.
- Verify Dark/Light/System and every preset from Profile > Appearance (no flash on reload, circular reveal, instant with Reduce motion), keyboard focus rings on header links and controls, global toasts, notification bell, and password-change overlay placement.

## When This Document Must Be Updated

Update this README when root providers, global overlays, navigation, dashboard entry points, permission-based visibility, color tokens or theme presets, the theme script, the motion system or its reduced-motion contract, route loading skeletons, the feedback API, error handling, emulator-only test entry, or route-shell ownership changes.
