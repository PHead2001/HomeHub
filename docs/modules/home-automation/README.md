# Home Automation

## Purpose and Scope

This module owns Home Assistant credentials, connection checks, and read-only entity-state retrieval. It does not currently call Home Assistant services or control devices.

## User-Facing Capabilities

- Configure a Home Assistant URL and long-lived access token at `/automation`.
- Test the stored connection.
- List entity IDs, friendly names, and current states.
- Disconnect by deleting the stored credentials.

## Entry Points

- `src/app/automation/page.tsx`
- `src/components/automation-client.tsx`
- `src/app/automation/actions.ts`
- Credential save/delete methods in `src/contexts/auth-context.tsx`
- `HomeAssistantCredentials` and `HomeAssistantEntity` in `src/lib/types.ts`

## Architecture and Data Flow

The client saves credentials in Firestore through auth context. The server action reads those credentials, then sends `GET {url}/api/states` with a Bearer token and `cache: no-store`. Returned entity state is rendered but not persisted.

## Data Model and Persistence

- Credentials: `households/{householdId}/home-automation/credentials`.
- Stored fields: `url` and `accessToken`.
- Entity responses use `HomeAssistantEntity`; no entity-state history is stored.

## Authentication, Roles, and Security

Navigation uses `automation.view`, but the route/client only require a signed-in user with a household. The generic Firestore household rule allows every approved member to read/write the credential document; `automation.manage` and `automation.control` are not enforced at the rule boundary.

The long-lived token is stored directly in Firestore and is readable by approved members. The server action accepts caller-provided email and household ID and does not independently verify a server-side Firebase session. Its Firestore read through the web client SDK requires authenticated runtime verification.

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
