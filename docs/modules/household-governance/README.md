# Household Governance

## Purpose and Scope

This module owns household creation and recovery, membership, roles, permission presets/overrides, temporary invites, pending approval, member departure/removal, ownership transfer, and audit activity. It does not own feature records except compatibility cleanup such as unassigning chores when a member leaves.

## User-Facing Capabilities

- Create or join a household from the global onboarding overlay.
- Manage Overview, Invite Codes, Members, Roles, Activity, and Danger Zone at `/household`.
- Rename a household without changing its ID.
- Generate, copy, revoke, and use temporary invite codes.
- Approve `newuser` members by assigning an active role.
- Change roles, customize permission overrides, remove members, leave, and transfer ownership.
- View basic audit activity.
- See a disabled household-delete control; recursive deletion is not implemented.

## Entry Points

- `src/app/household/page.tsx`
- `src/components/household-management-client.tsx`
- `src/components/household-manager.tsx`
- `src/contexts/auth-context.tsx`
- `src/lib/permissions.ts`
- Household/member/invite/audit types in `src/lib/types.ts`
- `firestore.rules`
- `scripts/e2e/seed.mjs`

## Architecture and Data Flow

`AuthProvider` creates, joins, leaves, and recovers household membership. `HouseholdManager` chooses the onboarding or pending-approval overlay. `HouseholdManagementClient` performs management operations with Firestore batches/transactions and writes audit/system notification records.

Legacy users are resolved through `users/{email}.householdId` and `households.memberEmails`; missing UID member documents are backfilled best-effort. Only household-owned owner UID/email evidence grants owner. Every other legacy email member is normalized to `member` with no profile-derived permission overrides, even when `users/{email}.role` contains an old elevated value.

The emulator E2E seed creates Household A and Household B, matching fake identities, a limited member, and a legacy profile-elevation fixture. Cross-household and conservative fallback checks complement the primary owner/admin/member/pending membership path.

## Data Model and Persistence

- Household: `households/{householdId}` with `name`, owner fields, `memberEmails`, and timestamps.
- Membership: `households/{householdId}/members/{uid}`.
- Temporary invite: `inviteCodes/{code}`.
- Audit: `households/{householdId}/auditLogs/{auditId}`.
- System events: `households/{householdId}/notifications/{notificationId}`.
- Legacy compatibility: `users/{email}.{householdId,role,permissions}`, `households.memberEmails`, and `households.ownerEmail`.

Household IDs are slugified names plus a four-character suffix. Invite codes use readable `XXXX-XXXX-XX` values, expire after 30 minutes, and default to one use. The legacy optional `Household.inviteCode` field remains in the type for compatibility but is no longer generated for joining.

## Authentication, Roles, and Security

Roles are `owner`, `admin`, `member`, `child`, `guest`, and system-only `newuser`. Legacy `super-admin` normalizes to owner and `user` to member. Permission presets and per-member overrides are defined in `src/lib/permissions.ts`.

Rules restrict member listing/management to owner/admin paths, prevent admins from changing/removing owners through the normal rule branch, and validate self-join identity against Auth. Pending users can read their own membership/waiting state but not ordinary household subcollections. Legacy `memberEmails` membership remains accepted.

Exactly-one-owner is enforced by current UI helpers and workflows, not comprehensively by Firestore rules.

## Integrations and Background Processing

- Governance events create system notifications and therefore can trigger FCM delivery.
- Pending-member reminder checks run client-side when an authorized user opens Household Manager; each daily pending state uses a deterministic notification identity so overlapping visits do not create duplicates. No daily scheduled function exists.
- There is no server-side recursive household deletion function.

## Cross-Module Dependencies

- [Identity and Profile](../identity-profile/README.md) supplies Auth identity and compatibility profile documents.
- [Notifications](../notifications/README.md) displays and pushes system events.
- [Chores](../chores/README.md) is updated to unassign departing/removed members.
- [Firebase Platform](../firebase-platform/README.md) owns rules and Cloud Function deployment.

## Invariants and Failure Behavior

- `newuser` is not manually assignable and has no preset permissions.
- Owners cannot leave before transferring ownership; the UI does not offer a functioning household delete.
- Admin workflows exclude the owner.
- Household creation retries candidate IDs but does not use an explicit nonexistence transaction/precondition around the full batch.
- Manager loading uses independent result handling so denied invite/audit queries do not necessarily blank member data.
- `/household?tab=members` is used as a deep link, but the current manager does not read that query parameter and opens its default tab.
- Pending-approval system notifications are not targeted to owner/admin recipients and may be pushed household-wide through legacy `memberEmails`.

## Validation

- Run `npm.cmd run lint` and `npm.cmd run typecheck` after governance changes.
- Run `npm.cmd run test:e2e:local` for authenticated owner loading and Household Manager fixture coverage.
- Manually test household creation collisions, legacy recovery/backfill, invite creation/expiry/revocation/use, pending approval, each role preset, overrides, admin-vs-owner protections, removal, leave, ownership transfer, audit records, and chore reassignment.
- Use Firestore Emulator rules tests when available; no automated rules suite currently exists.

## When This Document Must Be Updated

Update this README when household/member/invite/audit paths or fields, role presets, permission helpers, approval/reminder behavior, ownership/leave/delete workflows, legacy compatibility, system notifications, emulator seed membership, or governance security rules change.
