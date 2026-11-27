# Home Automation

## Purpose and Scope

This module owns the Home Assistant connection (address and token) and the device list at `/automation`. It only reads states; it never switches anything.

## User-Facing Capabilities

- Owners and admins (`automation.manage`) connect a public https Home Assistant address and long-lived token at `/automation`; the connection is tested before it is stored. The page subtitle says HomeHub only reads states and never switches anything.
- **Clear setup errors (AU-5).** Any path in the pasted address is dropped (a dashboard URL such as `…/lovelace/0` works); a 404 answers "That address isn't a Home Assistant server. Use the base address, like https://abc.ui.nabu.casa."
- **Live list (AU-1).** While the page is visible it asks again every 30 s (and at once when it becomes visible), and shows "Updated 12 s ago" (`src/lib/automation/refresh.ts`). A failed refresh keeps the last list with its age and an error. Refresh stays.
- **Useful list (AU-2, AU-3).** System domains (updates, sun, zones, automations, scripts, buttons, numbers, inputs and similar) and diagnostic sensors (signal strength, voltage, uptime…) are hidden until **Show all** (the button counts what is hidden); a low battery (20 % or less) always shows. Devices are grouped by device class (Lights, Doors and windows, Leaks, Smoke and safety, Motion, Climate, Fans, Scenes, Batteries…), as tiles in one column on phones, two at `md`, three at `xl`. States are plain words from the device class ("Open", "Wet", "Motion"), timestamp sensors are formatted in the household's zone, and each tile says how long the state has held ("for 3 min", from `last_changed`). The entity id and last change sit under **Details**. When Home Assistant reports more than 1,000 entities the page says how many it shows.
- Managers disconnect, which deletes the stored credentials. People without `automation.manage` see an `EmptyState` while nothing is connected. Signed-out visitors see the shared Sign in prompt.

## Entry Points

- `src/app/automation/page.tsx`, `src/components/automation-client.tsx`
- `src/components/automation/connect-form.tsx`, `entity-tile.tsx`, `entity-state.ts` (re-exports)
- `src/app/automation/actions.ts` (server actions)
- `src/lib/automation/*` (pure: `entities.ts` grouping, labels and noise; `snapshot-cache.ts`; `refresh.ts`)
- `src/lib/server/home-assistant.ts` (address safety, state fetch), `home-assistant-store.ts` (persistence), `home-assistant-snapshot.ts` (cache)

## Architecture and Data Flow

Every action (`getHomeAssistantStatus`, `getHomeAssistantEntities`, `saveHomeAssistantConnection`, `disconnectHomeAssistant`) verifies the caller's Firebase ID token with the Admin SDK and authorizes against the caller's membership record before reading its input: `automation.view` to read, `automation.manage` to connect and disconnect. A wall tablet's own token has no email and is refused by all of them.

**One read per household (AU-10).** Every state read goes through `householdSnapshot` (`home-assistant-snapshot.ts`): the credentials are read, then a per-instance `SnapshotCache` keyed by household and the credentials' `updatedAt` serves the last answer for 15 s and shares one in-flight request between concurrent callers; failures are cached for the window too. Polling pages and every member's screen therefore cost Home Assistant at most one `GET /api/states` per household every 15 s on a server instance (Cloud Run instances do not share the cache). A disconnect or a new connection forgets the cached answer.

## Data Model and Persistence

- `households/{h}/home-automation/credentials`: `url` (the origin only), `accessToken`, `updatedAt`, `updatedByUid`.
- Entity states are cached in server memory for 15 s and never persisted.

## Authentication, Roles, and Security

Firestore rules deny every client read and write of `home-automation/*` (`allow read, write: if false`), owners and admins included, so the token never reaches a browser except through the actions above. Covered by `tests/rules/firestore.rules.test.ts` ("Home Assistant credentials"). Saving re-checks inside a transaction that the household still exists, is not being deleted, and that the caller still has `automation.manage`. Addresses must be https, without credentials, and must resolve only to public addresses (loopback, private, link-local and metadata, CGNAT, unique-local, multicast and embedded-IPv4 forms are refused); `.local`, `.lan`, `.internal` and `.home.arpa` names are refused; the URL is re-validated on every request and the socket's own lookup re-validates at connect time (`pinnedFetch`), so DNS rebinding is refused; redirects are never followed; bodies are capped at 5 MB; requests time out after 8 s. Permissions are decided on the server; the page only mirrors them. Registered wall tablets cannot reach any of this (see Cross-Module Dependencies).

## Integrations and Background Processing

- Home Assistant REST: `GET /api/states`.
- There is no scheduled job, Cloud Function or websocket for Home Assistant.

## Cross-Module Dependencies

- [Application Shell and Dashboard](../application-shell/README.md) exposes navigation.
- [Household Governance](../household-governance/README.md): roles and permissions.
- [Registered Wall Tablets](../devices/README.md): automation stays off tablets (`automation.connection` is `not_on_tablets`; the section cannot be switched on). A personal account on the wall tablet gets everything above.
- The AI overview does not use automation facts.

## Invariants and Failure Behavior

- The token never leaves the server: not in any response.
- At most one Home Assistant read per household per 15 s per server instance.
- Missing credentials return "not connected"; non-2xx answers say what went wrong (redirect, rejected token, not Home Assistant, other status); network failures say the server could not reach Home Assistant.
- A failed refresh keeps the last list.

## Validation

- `tests/unit/automation-list.test.ts` (noise, grouping, labels, the snapshot cache: one load per window, failures cached; refresh labels). `tests/unit/household-governance.test.ts` covers the state labels.
- `tests/server/home-assistant.test.ts`: address safety, path stripping, 404 wording, snapshot trimming and truncation.
- `tests/server/home-assistant-store.test.ts` (emulator): transactional checks when saving credentials.
- `tests/server/device-identity.test.ts` checks every export of `src/app/automation/actions.ts` refuses a device token.
- `tests/e2e/household-ux.spec.ts` (connect form), `tests/e2e/tablet-pages.spec.ts` (48 px hit areas at 1263 × 818).
- Manually test against a real Home Assistant: connect with a dashboard URL, refresh age, Show all, disconnect.

## When This Document Must Be Updated

Update this README when credential storage, server authentication, Home Assistant endpoints, caching, permission enforcement, connection errors, or automation integrations change.

Session restore (release 2.1, SL-11): while the signed-in session is still being restored the page shows its own loading skeleton, never the sign-in prompt; a genuinely signed-out visitor still gets the prompt. The shared gate is described in [Application Shell](../application-shell/README.md).
