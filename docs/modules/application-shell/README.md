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
- See the HomeHub brand mark in the header, browser tab, and installed app icon; the header mark plays a one-time intro on the first load of a browser session.
- Install HomeHub to a phone or desktop home screen (standalone window, splash from the manifest colors and icon), with long-press shortcuts for "Add to shopping", "Log feeding" and "My chores".
- Share links or text into the installed app (handled by [Shopping Lists](../shopping/README.md)).
- Open the dashboard and shopping lists offline; other routes show a friendly offline page.

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
- `src/components/brand/logo.tsx`, `src/components/brand/logo.module.css`, `src/components/brand/logo-artwork.ts`
- `src/app/manifest.ts`, `src/app/icon.svg`, `src/app/favicon.ico`, `src/app/apple-icon.png`, `public/icons/*`
- `scripts/brand/render-icons.mjs` (`npm run brand:icons`)
- `src/app/offline/page.tsx`
- `src/app/api/sw/route.ts` (offline half; push half is owned by [Notifications](../notifications/README.md))
- `src/lib/service-worker.ts`
- `src/app/e2e-login/page.tsx`
- `src/components/e2e-login-client.tsx`
- `src/components/ui/*`

## Architecture and Data Flow

The root layout installs `AuthProvider`, foreground push handling, Firebase error reporting, theme injection, password-change handling, household-state overlays, the header, and global toasts around every route. The dashboard includes static module links and the on-demand `HomeAiOverview`; it makes no overview request on page load and does not persist results.

Dashboard card carousels contain their own horizontal movement. Their navigation controls remain inset from the carousel edge at every viewport so neither the carousel nor the document gains horizontal overflow.

Below the `md` breakpoint, `MobileTabBar` renders a fixed bottom navigation bar inside `HouseholdManager`, after `<main>`; at `md` and wider it is hidden. Primary tabs are Home, Chores, Shopping, and Pets; a More tab opens a bottom sheet with Maintenance, Automation, Household, Barcode Library, and Profile. The active tab or sheet item is marked with `aria-current="page"`, and More is highlighted when the current route is one of its items. The bar is not rendered for users without a household, without a loaded member record, or with role `newuser`.

The root `viewport` export sets `viewportFit: 'cover'`. The tab bar pads its bottom by `env(safe-area-inset-bottom)` and the More sheet adds the same inset to its bottom padding, so content clears the home indicator. On phones `<main>` reserves `calc(4rem + env(safe-area-inset-bottom))` of bottom padding (the 4rem bar height plus the inset) so page content is not hidden behind the bar; `md:pb-0` removes it on larger screens. This padding applies whenever `<main>` renders on a phone, including when the bar itself is hidden.

### Brand mark

`Logo` renders the HomeHub mark as inline SVG: a house whose roof is two connection edges meeting at a hub node, with smaller nodes at the eaves, plus two windows. It uses `currentColor`, defaulting to `hsl(var(--primary))`, and fixed `width`/`height` from its `size` prop so it never shifts layout. `variant="wordmark"` adds the HomeHub name; the mark is decorative (`aria-hidden`) unless a `title` is passed. The header renders `<Logo size={24} animated />` next to its own HomeHub text.

With `animated`, CSS keyframes in `logo.module.css` play once: the roof draws on with `stroke-dashoffset` (0-560 ms), the nodes pop in (380-680 ms), and the windows light up (620-900 ms), 900 ms in total. The base styles are the finished mark, so skipping the animation always shows the end state. An inline script rendered right after the SVG records `homehub:logo-intro-played` in `sessionStorage` and, on later loads in the same tab session, marks the SVG `data-intro-played` before it paints, so the intro never replays. The animation is also disabled by `@media (prefers-reduced-motion: reduce)` and by `html[data-motion="reduce"]` (the in-app motion setting contract). Nothing waits on the animation.

All static brand assets come from the same artwork constants in `logo-artwork.ts`. `scripts/brand/render-icons.mjs` rasterizes them with `sharp` into `src/app/icon.svg` and `src/app/favicon.ico` (16/32/48 px, rounded navy tile), `src/app/apple-icon.png` (180 px, full bleed), `public/icons/icon-192.png` and `icon-512.png` (purpose `any`), `public/icons/maskable-512.png` (full bleed, mark inside the 80% safe zone) and `public/icons/shortcut-96.png`. Raster icons use the static hex values `BRAND_BACKGROUND_HEX` (`#020817`, the dark `--background`) and `BRAND_ACCENT_HEX` (`#4bb9ae`, the current `--primary`); regenerate and commit them if either token changes. Next's file conventions emit the favicon, SVG icon and apple-touch-icon links.

### Installable app (PWA)

`src/app/manifest.ts` is served at `/manifest.webmanifest` (Next adds the link tag): `id`/`start_url`/`scope` `/`, `display: standalone`, `background_color` and `theme_color` `#020817` (matching the dark default and the `viewport.themeColor`, so the splash blends into the first frame), the icons above, three shortcuts (`/shopping?quickAdd=1`, `/pets`, `/chores`), and a GET `share_target` to `/share` with `title`, `text` and `url`. The root `metadata` adds `applicationName` and `appleWebApp` (capable, title, `black-translucent` status bar) for iOS home-screen launches.

### Service worker contract

HomeHub has exactly one service worker, `/api/sw` with scope `/` (`src/lib/service-worker.ts` holds the URL and scope). It combines Firebase Messaging push handling (see [Notifications](../notifications/README.md)) with the offline app shell. Production builds register it from `PushNotificationManager` after the window `load` event; development builds and the Playwright suite (which runs the dev server) do not auto-register, so cached pages never mask code changes or intercept test traffic, though enabling push still registers it.

- Install precaches the page shells for `/`, `/shopping` and `/offline`, every `/_next/static/` asset those pages reference, and the manifest and icons, then calls `skipWaiting`. Activate deletes `homehub-*` caches from other versions and claims open pages. The cache names carry `SHELL_VERSION` in `route.ts`; bump it when the caching logic or precache list changes.
- Navigations are network first. A successful same-origin response for a shell route refreshes its cached copy. If the network fails, the cached shell for that path is returned (query strings are ignored, so `/shopping?quickAdd=1` works offline), otherwise the cached `/offline` page, otherwise a small inline offline page.
- `/_next/static/` assets are cache first (they are content-hashed); the unhashed manifest and icons are served from cache and refreshed in the background. The static cache is trimmed to 300 entries.
- The worker ignores non-GET requests, other origins (Firebase, Google APIs, CDNs), `/api/*` and `/__/*`. React Server Component fetches go to the network; when they fail offline, Next falls back to a full navigation, which the worker serves.
- Cached shells are client-rendered and contain no household data. Offline data comes from Firestore's persistent cache ([Firebase Platform](../firebase-platform/README.md)).

`/offline` is a static page with links to Shopping and Home.

### Navigation visibility

Header and phone tab bar navigation derive visibility from effective permissions. Dashboard cards are not permission-filtered. Overview metrics and generated sections are filtered by verified server-side effective permissions.

## Data Model and Persistence

The shell owns no Firestore documents. It consumes `User`, `Household`, `HouseholdMember`, and permission data supplied by auth/household context. Overview facts are transient and the optional model narrative remains component state.

Theme values are persisted by the identity/profile module and injected as CSS variables by `ThemeInjector`.

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

- [Identity and Profile](../identity-profile/README.md) supplies session/profile state and theme.
- [Household Governance](../household-governance/README.md) supplies membership and effective role state.
- [Notifications](../notifications/README.md) supplies the bell and foreground push side effects.
- Every product module supplies its own route and data behavior.

## Invariants and Failure Behavior

- Global providers must remain ordered so all consumers are inside `AuthProvider`.
- Dashboard links may expose navigation that the header hides; destination security is authoritative.
- Firebase errors are converted to global toasts through the error emitter/listener pair.
- The household overlays replace child routes, but shell loading does not: children mount while household state is resolving, so loading must not be treated as proof that route effects did not run.
- At 360 px and wider supported mobile viewports, dashboard carousel overflow must remain component-local and the document must not scroll horizontally.
- Only one service worker may control the origin. Any new worker behavior goes into `/api/sw`; registering a different script at scope `/` would replace it and break push or offline support.
- The logo intro must stay at or under 900 ms, show the finished mark under reduced motion (system or `data-motion="reduce"`), and never replay within a tab session.
- The manifest, favicon and app icons must be regenerated from `logo-artwork.ts` with `npm run brand:icons`, never edited by hand.

## Validation

- Run `npm.cmd run lint` and `npm.cmd run typecheck` after shell changes.
- Run `npm.cmd run test:e2e:local` for seeded desktop/mobile shell and route coverage.
- Manually test desktop/mobile navigation for logged-out, no-household, approved, and pending users.
- Check each role's header visibility and verify dashboard destinations remain secured.
- Verify theme injection, global toasts, notification bell, and password-change overlay placement.
- `tests/e2e/pwa-share.spec.ts` checks the manifest fields, icons, shortcuts and share target.
- In a production build (`npm run build` then `npm run start`), check in DevTools > Application that the manifest has no errors, the worker at `/api/sw` is active, and with the network offline `/shopping` loads from cache while an unvisited route shows the offline page. Run Lighthouse's installability checks after changes to the manifest or worker.

## When This Document Must Be Updated

Update this README when root providers, global overlays, navigation, dashboard entry points, permission-based visibility, theme injection, error handling, emulator-only test entry, route-shell ownership, the brand mark or its assets, the manifest, or the service worker's caching contract changes.
