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

The root layout renders the color tokens for every theme preset and an inline theme script in `<head>`, the ambient background, then installs `AuthProvider`, `AppearanceProvider` (theme, motion preference and feedback settings, wrapping everything in motion's `MotionConfig`), the navigation progress bar, the glow pointer tracker, the cross-route morph listener, foreground push handling, Firebase error reporting, password-change handling, household-state overlays, the header, and global toasts around every route. `src/app/template.tsx` wraps page content in `PageTransition`; because templates remount on navigation and layouts do not, only page content animates. The dashboard includes static module links and the on-demand `HomeAiOverview`; it makes no overview request on page load and does not persist results.

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

### Navigation

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

**Empty states.** `EmptyState` (`src/components/empty-state.tsx`) is the one empty-state pattern (H24): an inline-SVG illustration, a title, a one-line invitation and an optional primary and secondary action. Props: `kind` (`chores`, `lists`, `pets`, `assets`, `notifications`, `generic`; default `generic`), `title`, `description`, `action` and `secondaryAction` (`{ label, icon?, onClick }` renders a real `<button>`, `{ label, icon?, href }` a real Next `<Link>`; the primary uses the filled button, the secondary the ghost button), `headingLevel` (2-4, default 2, so it fits the page outline), `compact` (smaller art and spacing for cards and popovers), plus any `div` attribute. The illustrations share one style (primary-tinted backdrop, muted line drawing in `currentColor`, one primary accent, a sparkle), use token classes only so every preset recolors them, and are `aria-hidden`; `EmptyStateIllustration` exports the art alone. The content fades in with a 6 px settle (220 ms, opacity/transform only, fixed illustration size, so nothing shifts) and renders in place under reduced motion. Modules adopt it in their own pages.

**Member avatars.** `MemberAvatar` (`src/components/member-avatar.tsx`) takes `uid`, `name`, `photoUrl?`, `size` (`sm` 24 px, `md` 36 px default, `lg` 56 px), `ring?` (a ring in the member color with a background-colored offset), `color?` (override, e.g. from `memberColorMap`), `decorative?` and `className`. It shows the photo once it has loaded; without a photo, or when the photo fails to load, it shows a generated diagonal gradient between the member's color token and a partner member token (`avatarGradientPartner`, three slots around the hue wheel) with one or two initials (`memberInitials`: first and last word, email local part, `?` when there is no letter) in `member-foreground`, which is AA on every member fill. The avatar is announced as the member's name (`role="img"`, `aria-label`); pass `decorative` when the name is printed next to it. `MemberAvatarStack` takes `members` (`{ uid, name, photoUrl? }[]`), `max` (circles including the `+k` chip, default 4), `size`, `ring`, `label?` and `className`; it colors members with `memberColorMap` so no two share a color, overlaps them with a background ring, and is one image to assistive tech named after the members ("Sam, Alex and 3 others"). Pure helpers live in `src/lib/member-avatar.ts`.

**Toasts.** The toast viewport sits at the top: top-center (at most 420 px wide) on phones and top-right from the `md` breakpoint, below the status bar/notch (`env(safe-area-inset-top)`) and inside the left/right safe areas. Dialogs, alert dialogs and sheets keep their primary buttons in a bottom footer and the phone tab bar is at the bottom, so a toast never covers them (previously toasts sat bottom-right on top of dialog buttons). Toasts slide in from the top and can be swiped right; the viewport ignores pointer events so its empty padding never blocks the header, and it stays above dialogs (`z-[100]`). Radix renders the viewport as a dismissable-layer branch, so pressing a toast does not close an open dialog. Toasts are compact on phones (16 px padding).

**Validation and errors.** One rule for every form: a problem with a field is shown inline under that field and never as a toast; toasts are only for outcomes (saved, deleted, could not reach the server). Use `FieldError` (`src/components/field-error.tsx`; props `id` of the field and the message as children, renders nothing when empty, `role="alert"`) with `fieldErrorProps(fieldId, error)` on the input (`aria-invalid` and `aria-describedby` to `${id}-error`), or `FormMessage` inside react-hook-form forms, which now has the same look (destructive text with an alert icon). `friendlyError(error)` (`src/lib/friendly-error.ts`) turns any thrown value into a plain-language message so raw Firebase or network text never reaches users: Firestore/Functions/Storage/Auth codes with or without a service prefix, HTTP statuses, `FirestorePermissionError`, fetch failures and timeouts map to `permission-denied`, `unavailable`, `deadline-exceeded`, `not-found`, `resource-exhausted`, `unauthenticated`, `offline` (network-shaped or unknown errors while `navigator.onLine` is false) or `unknown`; `friendlyErrorKind` returns the kind and `FRIENDLY_ERROR_TITLES` a short title. `toastError(error, title?, options?)` from `src/hooks/use-toast.ts` (also returned by `useToast()`) shows a destructive toast whose description always comes from `friendlyError`; the global `FirebaseErrorListener` uses it for permission errors. Existing call sites that build their own error toasts are migrated by their modules.

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
- Every module consumes the design foundation (tokens, `memberColor`, motion components, `useReducedMotion`, `playFeedback`) and the shared UI pieces (`EmptyState`, `MemberAvatar`, `FieldError`, `friendlyError`, `toastError`).
- [Household Governance](../household-governance/README.md) supplies membership and effective role state.
- [Notifications](../notifications/README.md) supplies the bell and foreground push side effects.
- Every product module supplies its own route and data behavior.

## Invariants and Failure Behavior

- Global providers must remain ordered so all consumers are inside `AuthProvider`.
- Dashboard links may expose navigation that the header hides; destination security is authoritative.
- Firebase permission errors are converted to global toasts through the error emitter/listener pair, using `toastError`, so the text is the plain-language `friendlyError` message.
- Toasts never cover dialog or sheet footers or the phone tab bar: the viewport stays at the top of the screen inside the safe areas.
- The household overlays replace child routes, but shell loading does not: children mount while household state is resolving, so loading must not be treated as proof that route effects did not run.
- At 360 px and wider supported mobile viewports, dashboard carousel overflow must remain component-local and the document must not scroll horizontally.
- The theme script must stay dependency-free and must not throw; if storage is blocked the default dark theme applies and in-session changes still work.
- No animation delays content, errors or focus: the first page is not animated, loading skeletons match page layout, overlays remain interactive during their enter animation, and the progress bar is decorative (`aria-hidden`).
- `html { scrollbar-gutter: stable }` keeps pages from shifting sideways when a scrollbar appears.
- Ambient and glow effects are decorative (`aria-hidden`, `pointer-events: none`) and must keep text contrast; new ambient effects get one intensity token per preset.
- Only one service worker may control the origin. Any new worker behavior goes into `/api/sw`; registering a different script at scope `/` would replace it and break push or offline support.
- The logo intro must stay at or under 900 ms, show the finished mark under reduced motion (system or `data-motion="reduce"`), and never replay within a tab session.
- The manifest, favicon and app icons must be regenerated from `logo-artwork.ts` with `npm run brand:icons`, never edited by hand.

## Validation

- Run `npm.cmd run lint` and `npm.cmd run typecheck` after shell changes.
- Run `npm.cmd run test:e2e:local` for seeded desktop/mobile shell and route coverage.
- Manually test desktop/mobile navigation for logged-out, no-household, approved, and pending users.
- Check each role's header visibility and verify dashboard destinations remain secured.
- Run `npm.cmd run test:unit` for preset contrast, the pre-paint theme script, member colors, feedback and motion tokens, and (`tests/unit/shared-ui.test.ts`) `friendlyError` mappings, avatar initials, gradients and stack slots, field-error ARIA props, token-only colors in the shared components and the top toast placement.
- Verify Dark/Light/System and every preset from Profile > Appearance (no flash on reload, circular reveal, instant with Reduce motion), keyboard focus rings on header links and controls, global toasts, notification bell, and password-change overlay placement.
- `tests/e2e/pwa-share.spec.ts` checks the manifest fields, icons, shortcuts and share target.
- In a production build (`npm run build` then `npm run start`), check in DevTools > Application that the manifest has no errors, the worker at `/api/sw` is active, and with the network offline `/shopping` loads from cache while an unvisited route shows the offline page. Run Lighthouse's installability checks after changes to the manifest or worker.

## When This Document Must Be Updated

Update this README when root providers, global overlays, navigation, dashboard entry points, permission-based visibility, color tokens or theme presets, the theme script, the motion system or its reduced-motion contract, route loading skeletons, the feedback API, error handling, emulator-only test entry, route-shell ownership, the brand mark or its assets, the manifest, or the service worker's caching contract changes.
