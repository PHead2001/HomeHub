# Home Automation

## Purpose and Scope

This module owns the Home Assistant connection (address and token), the device list at `/automation`, and the household's automation settings (favourites, who sees people and cameras). It only reads states; it never switches anything.

## User-Facing Capabilities

- **Connect (AU-7).** Owners and admins (`automation.manage`) connect a public https Home Assistant address and long-lived token at `/automation`. The form (`src/components/automation/connect-form.tsx`) has a four-step guide (named list "How to connect"), a "Why does it need https?" expander, and moves focus to the error after a failed test. The connection is tested before it is stored. The page subtitle says once that HomeHub only reads states and never switches anything; the card no longer repeats it.
- **Clear setup errors (AU-5).** Any path in the pasted address is dropped (a dashboard URL such as `…/lovelace/0` works); a 404 answers "That address isn't a Home Assistant server. Use the base address, like https://abc.ui.nabu.casa."
- **Live list (AU-1).** While the page is visible it asks again every 30 s (and at once when it becomes visible), and shows "Updated 12 s ago" (`src/lib/automation/refresh.ts`). A failed refresh keeps the last list with its age and an error. Refresh stays.
- **Useful list (AU-2, AU-3).** System domains (updates, sun, zones, automations, scripts, buttons, numbers, inputs and similar) and diagnostic sensors (signal strength, voltage, uptime…) are hidden until **Show all** (the button counts what is hidden); a low battery (20 % or less) always shows. Devices are grouped by device class (Lights, Doors and windows, Leaks, Smoke and safety, Motion, Climate, Fans, Scenes, Batteries…), as tiles in one column on phones, two at `md`, three at `xl`. States are plain words from the device class ("Open", "Wet", "Motion"), timestamp sensors are formatted in the household's zone, and each tile says how long the state has held ("for 3 min", from `last_changed`). The entity id, last change, and the managers' pin button sit under **Details**. When Home Assistant reports more than 1,000 entities the page says how many it shows.
- **Favourites (AU-8).** Managers pin devices to a Favourites section at the top (household-wide).
- **Update token (AU-9).** Managers replace the token from the device list; the new token is tested against the stored address before it replaces the old one.
- **Privacy (AU-11).** People (`person.*`), trackers (`device_tracker.*`), cameras and locks are shown to owners and admins only. Managers can let members see them ("Let members see people, locations, cameras and locks", off by default); children and guests never see them, whatever the setting. A note says when some were withheld.
- **Navigation (AU-6).** Automation takes a header slot only when Home Assistant is connected (the household's `homeAssistant.connected`, written on connect and backfilled for older connections the first time anyone opens `/automation`) or for people with `automation.manage`; otherwise it is in the account menu. The phone More sheet and the palette list it for everyone with `automation.view`.
- Managers disconnect, which deletes the stored credentials (settings are kept). People without `automation.manage` see an `EmptyState` while nothing is connected. Signed-out visitors see the shared Sign in prompt.

## Entry Points

- `src/app/automation/page.tsx`, `src/components/automation-client.tsx`
- `src/components/automation/connect-form.tsx`, `entity-tile.tsx`, `automation-settings.tsx`, `entity-state.ts` (re-exports)
- `src/app/automation/actions.ts` (server actions)
- `src/lib/automation/*` (pure: `entities.ts` grouping, labels, noise and privacy; `config.ts`; `snapshot-cache.ts`; `refresh.ts`; `token-crypto.ts`)
- `src/lib/server/home-assistant.ts` (address safety, state fetch), `home-assistant-store.ts` (persistence), `home-assistant-snapshot.ts` (cache)

## Architecture and Data Flow

Every action (`getHomeAssistantStatus`, `getHomeAssistantEntities`, `saveHomeAssistantConnection`, `replaceHomeAssistantToken`, `disconnectHomeAssistant`, `setAutomationFavorite`, `setMembersSeeSensitive`) verifies the caller's Firebase ID token with the Admin SDK and authorizes against the caller's membership record before reading its input: `automation.view` to read, `automation.manage` to connect, replace, disconnect and change settings. A wall tablet's own token has no email and is refused by all of them.

**One read per household (AU-10).** Every state read goes through `householdSnapshot` (`home-assistant-snapshot.ts`): the credentials are read, then a per-instance `SnapshotCache` keyed by household and the credentials' `updatedAt` serves the last answer for 15 s and shares one in-flight request between concurrent callers; failures are cached for the window too. Polling pages and every member's screen therefore cost Home Assistant at most one `GET /api/states` per household every 15 s on a server instance (Cloud Run instances do not share the cache). A disconnect or a new token forgets the cached answer.

**Privacy is applied on the server (AU-11).** The cache holds the full list; each caller then receives `visibleEntities(…)` for their role and the household's `showSensitiveToMembers`, and `configForViewer` strips the privacy choice for non-managers and sensitive favourites for those who may not see them.

## Data Model and Persistence

- `households/{h}/home-automation/credentials`: `url` (the origin only), `accessTokenEnc` (AES-256-GCM, `v1:<iv>:<tag>:<ciphertext>`, bound to the household id) when the server has `HOMEHUB_HA_TOKEN_KEY`, otherwise `accessToken` (plain, as before), `updatedAt`, `updatedByUid`. Legacy plain tokens are still read; an encrypted token without the key is reported as unreadable ("An owner or admin can replace the token").
- `households/{h}/home-automation/config`: `favorites` (≤ 40 entity ids), `showSensitiveToMembers` (default false), `updatedAt`, `updatedByUid`. Read tolerantly (`readAutomationConfig`). Changed one setting at a time: each action sends one change (`ConfigChange`: pin or unpin a favourite, the privacy choice), and `changeConfig` applies it to the config it reads inside the same transaction and validates the result (`applyConfigChange`), so a page opened earlier never overwrites another manager's change (pinning a favourite cannot turn member access back on).
- `households/{h}.homeAssistant = { connected: true }`: written by the server on connect and replace, deleted on disconnect, and kept in step with the credentials by `syncConnectedFlag` from `getHomeAssistantStatus`, which reads the credentials and the flag in one transaction (a disconnect racing a status request can never leave the flag set). Never the token or the address (every member, guests included, can read the household document).
- Activity log (`auditLogs`, server-written): `automation.connected`, `automation.token_replaced` (details: host, whether encrypted), `automation.disconnected`, `automation.settings_changed` (when the privacy choice changes).
- Entity states are cached in server memory for 15 s and never persisted.

## Authentication, Roles, and Security

Firestore rules deny every client read and write of `home-automation/*` (`allow read, write: if false`), owners and admins included, so the token and the settings never reach a browser except through the actions above. Covered by `tests/rules/firestore.rules.test.ts` ("Home Assistant credentials"). The household document's `homeAssistant` field is written only by the server (the household update rule lets clients change only `timeZone` and `updatedAt`). Saving re-checks inside a transaction that the household still exists, is not being deleted, and that the caller still has `automation.manage`; replacing also requires the same address to still be connected. Addresses must be https, without credentials, and must resolve only to public addresses (loopback, private, link-local and metadata, CGNAT, unique-local, multicast and embedded-IPv4 forms are refused); `.local`, `.lan`, `.internal` and `.home.arpa` names are refused; the URL is re-validated on every request and the socket's own lookup re-validates at connect time (`pinnedFetch`), so DNS rebinding is refused; redirects are never followed; bodies are capped at 5 MB; requests time out after 8 s. Permissions are decided on the server; the page only mirrors them. Registered wall tablets cannot reach any of this (see Cross-Module Dependencies).

## Integrations and Background Processing

- Home Assistant REST: `GET /api/states`.
- There is no scheduled job, Cloud Function or websocket for Home Assistant.
- `HOMEHUB_HA_TOKEN_KEY` (optional, server runtime, 32 random bytes as base64, from Secret Manager): when set, new and replaced tokens are stored encrypted. Not yet declared in `apphosting.yaml` (see the comment there); existing plain tokens stay readable and are encrypted on the next connect or token update.

## Cross-Module Dependencies

- [Application Shell and Dashboard](../application-shell/README.md): the header slot (`automationInHeader`).
- [Household Governance](../household-governance/README.md): roles and permissions; Activity labels for the automation entries.
- [Registered Wall Tablets](../devices/README.md): automation stays off tablets (`automation.connection` is `not_on_tablets`; the section cannot be switched on). A personal account on the wall tablet gets everything above.
- The AI overview does not use automation facts.

## Invariants and Failure Behavior

- The token never leaves the server: not in any response, activity entry or the household document.
- Sensitive entities never reach a caller who may not see them.
- At most one Home Assistant read per household per 15 s per server instance.
- Missing credentials return "not connected"; an unreadable token says an owner or admin can replace it; non-2xx answers say what went wrong (redirect, rejected token, not Home Assistant, other status); network failures say the server could not reach Home Assistant.
- A failed refresh keeps the last list.

## Validation

- `tests/unit/automation-list.test.ts` (noise, grouping, labels, the snapshot cache: one load per window, failures cached; refresh labels), `automation-privacy.test.ts` (privacy filter and viewer config, settings validation, token encryption, the header slot). `tests/unit/household-governance.test.ts` covers the state labels.
- `tests/server/home-assistant.test.ts`: address safety, path stripping, 404 wording, snapshot trimming and truncation.
- `tests/server/home-assistant-store.test.ts` (emulator): transactional checks, the household flag, audit entries without the token, encryption with and without the key, legacy tokens, replace and disconnect, settings.
- `tests/server/home-assistant-actions.test.ts` (emulator): the connected-flag backfill, settings permissions and validation, what members and children are sent, not-connected answers, disconnect permission.
- `tests/server/device-identity.test.ts` checks every export of `src/app/automation/actions.ts` refuses a device token.
- `tests/e2e/household-ux.spec.ts` (connect form, guide), `tests/e2e/tablet-pages.spec.ts` (48 px hit areas at 1263 × 818).
- Manually test against a real Home Assistant: connect with a dashboard URL, refresh age, Show all, the privacy toggle, Update token, disconnect.

## When This Document Must Be Updated

Update this README when credential storage, server authentication, Home Assistant endpoints, the privacy rules, caching, permission enforcement, connection errors, or automation integrations change.

Session restore (release 2.1, SL-11): while the signed-in session is still being restored the page shows its own loading skeleton, never the sign-in prompt; a genuinely signed-out visitor still gets the prompt. The shared gate is described in [Application Shell](../application-shell/README.md).
