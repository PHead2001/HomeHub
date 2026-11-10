# Home Automation

## Purpose and Scope

This module owns Home Assistant credentials, connection checks, and read-only entity-state retrieval. It does not currently call Home Assistant services or control devices.

## User-Facing Capabilities

- Owners/admins (`automation.manage`) connect a public https Home Assistant address and long-lived token at `/automation`; the connection is tested before it is stored.
- The page subtitle says HomeHub only reads states and never switches anything; the address placeholder is a public https example (`https://your-home.ui.nabu.casa`), never a `.local` address.
- Members with `automation.view` see devices grouped by type, with search, friendly names and units, and can refresh (a live Home Assistant request, so the button stays). States are shown in plain words ("Not home", "Unavailable") on tinted chips (on, off, needs attention, unavailable, value; `src/components/automation/entity-state.ts`).
- Managers disconnect, which deletes the stored credentials.
- People without `automation.manage` see an `EmptyState` explaining that an owner or admin must connect it. No devices, and no search matches (with Clear search), also use `EmptyState`.
- Signed-out visitors see the shared Sign in prompt.
- Client-side failures (the server action could not be reached) show `friendlyError` text; server action errors are already plain language.

## Entry Points

- `src/app/automation/page.tsx`
- `src/components/automation-client.tsx`
- `src/components/automation/entity-state.ts`
- `src/app/automation/actions.ts`
- `src/lib/server/home-assistant.ts` (address safety and state fetch)
- `tests/server/home-assistant.test.ts`

## Architecture and Data Flow

Every action (`getHomeAssistantStatus`, `getHomeAssistantEntities`, `saveHomeAssistantConnection`, `disconnectHomeAssistant`) receives the caller's Firebase ID token and household ID, verifies the token with the Admin SDK and authorizes against the caller's membership record (`automation.view` to read, `automation.manage` to change). Credentials are read and written only with the Admin SDK. Saving tests the connection first, then writes in a transaction that re-checks that the household still exists, is not being deleted, and that the caller still has `automation.manage` (`src/lib/server/home-assistant-store.ts`), so a household deleted during a slow connection test never gets its token back. Requests go to `GET {url}/api/states` with an 8 s timeout, `redirect: manual` and `cache: no-store`; responses are trimmed to entity ID, state, friendly name, unit and device class (max 1000) and are not persisted.

## Data Model and Persistence

- Credentials: `households/{householdId}/home-automation/credentials`.
- Stored fields: `url` and `accessToken`.
- Entity responses use `HomeAssistantEntity`; no entity-state history is stored.

## Authentication, Roles, and Security

Firestore rules deny every client read and write of `home-automation/*` (`allow read, write: if false`), owners and admins included, so the long-lived token never reaches a browser. Credentials are read and written only by the server actions above with the Admin SDK, after they verify the caller's ID token and membership. No client code touches the path. Covered by `tests/rules/firestore.rules.test.ts` ("Home Assistant credentials": every role, owner included, is denied get, list, create, update and delete). Addresses must be `https`, without embedded credentials, and must resolve only to public IP addresses (loopback, private, link-local/metadata, CGNAT, unique-local and multicast ranges are refused); `.local`, `.lan`, `.internal` and `.home.arpa` names are refused. The URL is re-validated on every request, so stored legacy `http://…local` addresses fail safely with a clear message. The connection itself re-validates every resolved address at connect time (`pinnedFetch`, see Integrations below), so a DNS answer that changes between validation and the request (DNS rebinding) is refused; redirects are not followed.

## Integrations and Background Processing

- External API: Home Assistant REST `GET /api/states`.
- Outbound request safety (`src/lib/server/home-assistant.ts`): the member-supplied URL must be https, carry no credentials, and not use a local-only name; `normalizeHomeAssistantUrl` resolves it and requires every address to be public (`isPublicAddress` blocks loopback, private, link-local and metadata, CGNAT, multicast and IPv6 forms that embed them), on save and again on every fetch. The request itself goes through `pinnedFetch`, a `node:https` GET whose socket lookup (`publicOnlyLookup`) re-resolves and re-validates at connect time, so a DNS answer that changes between the check and the connection (DNS rebinding) is refused before anything is sent. Redirects are never followed, responses are capped at 5 MB and time out after 8 s, and a response `Response` cannot represent (a null-body status such as 205 sent with a body, or a status outside 200-599) is rejected as "did not respond like Home Assistant" rather than escaping as an uncaught exception. This is the mitigation for CodeQL `js/request-forgery`: the URL is user-supplied by design.
- No Home Assistant Cloud Function, scheduled job, notification writer, or FCM path exists.
- No environment variable config is used for the household-specific URL/token.

## Cross-Module Dependencies

The homepage overview intentionally omits automation facts in the current implementation. Existing Home Assistant state access requires household credentials and an external request path that is not yet independently server-authorized enough for overview aggregation; no credential or entity attribute is sent to OpenAI.

- [Identity and Profile](../identity-profile/README.md) and [Household Governance](../household-governance/README.md) supply identity and household context.
- [Firebase Platform](../firebase-platform/README.md) supplies Firestore configuration/rules.
- [Application Shell and Dashboard](../application-shell/README.md) exposes navigation.

## Invariants and Failure Behavior

- Missing/incomplete credentials return explicit errors.
- Non-2xx Home Assistant responses include the status in the returned error.
- Network failures report that the server could not reach Home Assistant.
- A failed connection marks the UI unconfigured but does not delete stored credentials.
- Current behavior is read-only despite older README/UI wording about controlling devices.

## Validation

- Run `npm.cmd run lint` and `npm.cmd run typecheck` after implementation changes.
- Manually test missing/incomplete credentials, valid connection, invalid token, unreachable URL, state listing, disconnect, and cross-household credential denial.
- Runtime-test the server action under deployed authentication before asserting its Firestore credential read always succeeds.

## When This Document Must Be Updated

Update this README when credential storage, server authentication, Home Assistant endpoints, entity/control capabilities, permission enforcement, connection errors, or automation integrations change.

Session restore (release 2.1, SL-11): while the signed-in session is still being restored the page shows its own loading skeleton, never the sign-in prompt; a genuinely signed-out visitor still gets the prompt. The shared gate is described in [Application Shell](../application-shell/README.md).
