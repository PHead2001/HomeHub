# Home Automation

## Purpose and Scope

This module owns Home Assistant credentials, connection checks, and read-only entity-state retrieval. It does not currently call Home Assistant services or control devices.

## User-Facing Capabilities

- Owners/admins (`automation.manage`) connect a public https Home Assistant address and long-lived token at `/automation`; the connection is tested before it is stored.
- Members with `automation.view` see devices grouped by type, with search, friendly names, states and units, and can refresh.
- Managers disconnect, which deletes the stored credentials.
- People without `automation.manage` see an explanation instead of the setup form.

## Entry Points

- `src/app/automation/page.tsx`
- `src/components/automation-client.tsx`
- `src/app/automation/actions.ts`
- `src/lib/server/home-assistant.ts` (address safety and state fetch)
- `tests/server/home-assistant.test.ts`

## Architecture and Data Flow

Every action (`getHomeAssistantStatus`, `getHomeAssistantEntities`, `saveHomeAssistantConnection`, `disconnectHomeAssistant`) receives the caller's Firebase ID token and household ID, verifies the token with the Admin SDK and authorizes against the caller's membership record (`automation.view` to read, `automation.manage` to change). Credentials are read and written only with the Admin SDK. Requests go to `GET {url}/api/states` with an 8 s timeout, `redirect: manual` and `cache: no-store`; responses are trimmed to entity ID, state, friendly name, unit and device class (max 1000) and are not persisted.

## Data Model and Persistence

- Credentials: `households/{householdId}/home-automation/credentials`.
- Stored fields: `url` and `accessToken`.
- Entity responses use `HomeAssistantEntity`; no entity-state history is stored.

## Authentication, Roles, and Security

Firestore rules make `home-automation/*` unreadable by every client role, including the owner; only server actions read the token. Addresses must be `https`, without embedded credentials, and must resolve only to public IP addresses (loopback, private, link-local/metadata, CGNAT, unique-local and multicast ranges are refused); `.local`, `.lan`, `.internal` and `.home.arpa` names are refused. The URL is re-validated on every request, so stored legacy `http://…local` addresses fail safely with a clear message. Residual risk: DNS can change between validation and the request; redirects are not followed.

## Integrations and Background Processing

- External API: Home Assistant REST `GET /api/states`.
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
