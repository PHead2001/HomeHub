# Household Governance

## Purpose and Scope

This module owns household creation and recovery, membership, roles, permission presets/overrides, temporary invites, pending approval, member departure/removal, ownership transfer, and audit activity. It does not own feature records except compatibility cleanup such as unassigning chores when a member leaves.

## User-Facing Capabilities

- Create or join a household from the global onboarding overlay. Enter submits either form; an empty or over-long name and an incomplete invite code are explained inline under the field (`FieldError`). Invite codes are re-formatted as `XXXX-XXXX-XX` while typing or pasting, with or without dashes. The pending-approval overlay names the household the person asked to join.
- Manage Overview, Invite Codes, Members, Roles, Activity, and Danger Zone at `/household`. Tabs a viewer cannot use are not shown: Invite Codes needs `household.manageInvites`, Activity is for owners and admins (the rules let only them read audit entries). Signed-out visitors get a Sign in prompt. What a person may do on this page comes from the management policy below (their effective permissions and rank), not from their role name.
- All Household Manager data is live (Firestore listeners); there is no Refresh button.
- Overview: four stat cards (2x2 on phones, four across from `md`); long household names, even without spaces, wrap inside their card (at most three lines; `tests/e2e/shell-wave4.spec.ts` checks that the longest allowed name (80 characters) with no spaces stays inside its card and never overlaps the next one). The member and active-invite counts tick in with `NumberTicker` (the card's title keeps the plain text). Rename the household inline (Enter saves; errors inline). The household ID is plain small text, not an input.
- Generate, copy, revoke, and use temporary invite codes. An empty invite list shows an `EmptyState` with a Create invite code action. Create invite code (both the button and the empty-state action) stays disabled until the household, the signed-in member and `household.manageInvites` have loaded, so a tap is never silently ignored; `EmptyState` actions accept `disabled` for this. The rules still let only owners and admins list invite codes, so a member who was granted `household.manageInvites` sees (and can revoke) only the codes they created during the current visit.
- Members (D13/H25): the member cards enter staggered (`Stagger`; instant under reduced motion). Each member is a card with `MemberAvatar` (photo or gradient) in a collision-free member color (`memberColorMap`), a color stripe, a role chip, "(you)", join time, a custom-permission count and, with `chores.view`, chores done this week and still open. Role changes, Customize permissions, Make owner and Remove live in a "..." menu that lists only actions the policy lets the viewer perform on that person (the role list holds only roles below the viewer's own); with none, no menu is rendered. Choosing a role asks for confirmation and says that custom permissions are reset. A household with only you shows an `EmptyState` inviting others.
- Pending people (`newuser`, shown as "Pending"; the internal name never appears) appear to people with `household.manageMembers` as an "Approve Jamie?" banner at the top of Members (slides in; instant under reduced motion) with a role picker (default Member; only roles below the viewer's own), Approve (the role-change server action) and Deny (the remove server action, after confirmation). A badge on the Members tab counts pending people.
- Roles (D12/H25): a permission matrix with permissions as rows (grouped by module) and the five role presets as columns; the viewer's role column is highlighted. Choosing a member in "Show" (or Customize permissions from their card) shows that member's role default beside their own permissions. When the policy lets the viewer edit that member (`household.manageRoles`, not themselves, not someone at or above their own rank; otherwise the description says why), the member column is editable: each cell is a real `role="checkbox"` button (Tab to move, Space/Enter to toggle), checkmarks draw in within 150 ms (instant under reduced motion), cells that differ from the default carry a dot, and a bar shows unsaved changes with Use role defaults, Discard and Save permissions. Locked cells (lock icon, reason as tooltip and for screen readers, and a short note under the matrix): the owner-only permissions (`household.delete`, `household.transferOwnership`), and any permission the viewer does not hold that the member does not already have. A permission the member already has can always be taken away. If a draft would grant something the viewer does not hold (for example through Use role defaults), the bar says so and Save is disabled. Save permissions asks for confirmation. Only differences from the role default are stored.
- Activity: plain-language entries ("Created an invite code", "Changed a role to Admin") with relative times; an empty log shows an `EmptyState`.
- Remove, Deny, Make owner, Leave, role changes and permission saves ask for confirmation in an alert dialog (no `window.confirm`). Approve does not: it is already a deliberate choice of role plus a button.
- Owners can permanently delete the household from Danger Zone after typing its name to confirm; the delete control is shown only to the owner, and Leave only to non-owners.
- Failures use `toastError` (plain language via `friendlyError`); raw Firebase text is never shown. Successful outcomes use short toasts.

## Entry Points

- `src/app/household/page.tsx`
- `src/components/household-management-client.tsx`
- `src/components/household-manager.tsx`
- `src/components/household/*`: `household-model.ts` (pure helpers: role labels, validation, invite state, relative time, chore stats, override toggling, audit wording), `use-household-live-data.ts` (listeners), `member-card.tsx`, `pending-member-banner.tsx`, `roles-panel.tsx`, `permission-matrix.tsx`, `confirm-action-dialog.tsx`
- `src/contexts/auth-context.tsx`
- `src/lib/household-policy.ts` (pure management policy shared by the server actions and the UI)
- `src/app/household/actions.ts` (server actions) and `src/lib/server/household-membership.ts` (their transactions)
- `src/lib/permissions.ts`
- Household/member/invite/audit types in `src/lib/types.ts`
- `firestore.rules`
- `scripts/e2e/seed.mjs`

## Architecture and Data Flow

`AuthProvider` creates households and loads the caller's own membership record (a profile pointing at a household without a record, or one the rules deny, is cleared; there is no legacy recovery. Offline or other transient failures keep the reference and show a "Couldn't load your household" screen with Try again). Joining calls the `joinHouseholdWithInvite` server action (`src/app/household/actions.ts` → `src/lib/server/household-membership.ts`), which verifies the ID token and, in one Admin SDK transaction, checks the invite (exists, not revoked, not expired, uses left), refuses existing members and people still in another household, creates the pending record, increments `useCount`, records the redemption, updates the profile cache (including `uid`), writes an audit entry, and sends a targeted approval notification to each active owner/admin. Codes are accepted in any case, with or without dashes or spaces. Leaving and deleting also run through server actions (`leaveHouseholdAction` and `deleteHouseholdAction` in the same files), each verifying the ID token first. Leaving (any non-owner) runs in one transaction that re-reads the caller's membership, so a concurrent ownership transfer makes it retry and be refused; it deletes the caller's member record, removes their email from `memberEmails`, clears their profile cache, unassigns their incomplete chores and recurring templates, writes a `member.left` audit entry, and sends a targeted notification to each other active owner/admin. Deleting requires an active `owner` member record and an exact (trimmed) household-name match; it first, in one transaction, marks the household `deletingAt`, sets every membership to status `deleting` (rules grant nothing to non-active members, so all client reads, writes and uploads stop) and revokes every invite; joining and leaving are refused from then on. It then deletes Storage objects under `households/{householdId}/` (when a bucket is configured) and recursively deletes every subcollection except `members`; then, in one batch, it clears the profile cache of every member whose profile still points at the household, deletes the household's `inviteCodes`, the member records and the household document. If cleanup fails partway, the household stays frozen: members see that it is being deleted, and the owner gets a Finish deleting action that resumes it. `HouseholdManager` chooses the onboarding or pending-approval overlay. `HouseholdManagementClient` performs no management writes itself: rename, invite create/revoke/revoke-all, approve and role change, permission edits, removal and ownership transfer each call a server action (see Management Operations) with a fresh ID token and show the returned plain-language message when one is refused. The only Firestore write left in the component is the daily pending-member reminder (owners and admins only, as the rules require). `useHouseholdLiveData` opens `onSnapshot` listeners on the household document (live name) and `members`, and, only when the viewer's role may read them, on `inviteCodes` (`householdId ==`), `auditLogs`, and two single-field chore queries for member stats (`isCompleted == false`, and `completedAt >=` the start of this week, Monday local time). Each listener fails independently, so a denied invite or audit read never blanks the member list.

`households/{householdId}/members/{uid}` is the only authority for household access in Firestore rules, Storage rules and server actions. `households.memberEmails`, `households.ownerEmail` and `users/{email}.{householdId,role,permissions}` are display/compatibility data and never grant access; a user listed only in `memberEmails` has no access and cannot create their own membership record. `households.ownerUid` must always point at an active `owner` membership record (enforced by rules); legacy households without `ownerUid` must be backfilled from their verified owner record before owner edits work.

## Management Policy

`src/lib/household-policy.ts` is a pure module (no Firebase, no React). The server actions enforce it inside their transactions and the Household Manager uses the same functions to decide what to show.

- Rank: owner > admin > member > child = guest > pending (`newuser`). Unknown or legacy role names rank lowest and grant nothing.
- Effective permission: the role preset merged with the member's overrides (`getMemberPermissions`); the owner always has the full preset; pending or non-active people have nothing; `household.delete` and `household.transferOwnership` are forced off for everyone but the owner, whatever an override says.
- `household.view` and `household.manageInvites` work as ticked. A member granted `household.manageInvites` can create and revoke invite codes; an admin with it unticked cannot.
- `household.manageMembers`: approve pending people, change roles, remove members and rename the household. Member operations apply only to people whose rank is strictly lower than the actor's (never the owner, never an equal, never yourself), and the assigned role must be strictly below the actor's own rank (`owner` and `newuser` are never assignable).
- `household.manageRoles`: edit another member's permission overrides, with three guards: not your own; not someone at or above your rank; no granting (setting to true) a permission you do not effectively hold. Revoking is allowed under the same rank guard. Pending people have no permissions to edit.
- `household.delete` and `household.transferOwnership`: the owner only, always. They cannot be granted through overrides (the server refuses the save; the rules' `noOwnerOnlyOverrides` rejects the write too).
- Each refusal has a typed reason (`PolicyRefusal`: `not_member`, `missing_permission`, `self`, `rank`, `role_not_assignable`, `role_too_high`, `owner_only`, `grant_unheld`, `target_pending`) and a plain-language sentence (`refusalMessage`).

## Management Operations

All are server actions in `src/app/household/actions.ts` backed by `src/lib/server/household-membership.ts`. Each verifies the ID token (identity never comes from caller-supplied fields), then runs one Admin SDK transaction that re-reads the household and the actor's membership (and the target's), refuses when the household is being deleted or the policy says no, performs the writes and adds the activity-log entry in the same transaction. Results are `{ ok: true, data }` or `{ ok: false, code, message }`, where `code` is a policy reason or one of `unauthenticated`, `invalid_input`, `not_found`, `household_deleting`, `conflict`, `failed`.

| Action | Policy | Writes | Activity-log action |
|---|---|---|---|
| `renameHouseholdAction` | `household.manageMembers` | household `name`, `updatedAt` (name trimmed, 1-80 characters; an unchanged name writes nothing) | `household.renamed` (`householdName`, `previousName`) |
| `createInviteAction` | `household.manageInvites` | `inviteCodes/{code}`: code generated on the server (never reusing an existing document), 30 minutes, one use | `invite.generated` (`code`) |
| `revokeInviteAction` | `household.manageInvites` | `revokedAt` on a code of this household (another household's code is reported as not found; an already revoked code is a no-op) | `invite.revoked` (`code`) |
| `revokeAllInvitesAction` | `household.manageInvites` | `revokedAt` on every code that could still be used | `invite.revoked_all` (`count`) |
| `changeMemberRoleAction` | `canAssignRole` | member `role`, `status: active`, `permissions: {}`, `approvedAt`, `approvedByUid`; profile cache `role`, `permissions` | `member.approved` for a pending person, else `member.role_changed` (`role`, `previousRole`) |
| `updateMemberPermissionsAction` | `canEditPermissions` on the effective differences | member `permissions` (only differences from the role default); profile cache `permissions` (replaced). Refused with `conflict` when the member's role is no longer the one the editor showed | `member.permissions_changed` (`granted`, `revoked`) |
| `removeMemberAction` | `canManageMember` | deletes the member record; removes their email from `memberEmails`; clears the profile cache if it still points at this household; unassigns their open chores and their recurring templates | `member.removed` (`pending: true` when a request was denied) |
| `transferOwnershipAction` | owner only | household `ownerUid`, `ownerEmail`; new owner `role: owner`, previous owner `role: admin`, both with `permissions: {}`; both profile caches; one household-wide notification | `ownership.transferred` |

Activity-log entries written by these actions take `actorUid` and `actorEmail` from the verified token, `actorName` from the actor's membership record (falling back to the token), target fields from the target's membership record read in the transaction, and `createdAt` from the server clock (an ISO string, as before). Joining, leaving and these operations are therefore all authored by the server; the one entry still written by a browser is `household.created` (see below).

Removal keeps completed chores assigned to the person who did them (the earlier client batch unassigned those too, erasing history) and clears recurring templates the same way leaving does.

### Not yet closed in the rules

`firestore.rules` did not change with the move to server actions, so that browsers still running an older build keep working. Until the follow-up release, the rules still accept the old role-based client writes: an owner or admin can still write memberships, invites, the household name and activity-log entries directly, without the policy above. The follow-up release must:

- deny client `update` and `delete` on `households/{id}/members/{uid}` (the daily pending-member reminder still updates `lastNewUserReminderAt` from the browser and must move to the server first);
- deny client `create` and `update` on `inviteCodes`, and either let `household.manageInvites` holders list their household's codes or serve the list from the server;
- deny client updates of household `name`, `ownerUid`, `ownerEmail` and `memberEmails`;
- deny client `create` on `auditLogs` (`validNewAuditEntry`), which first needs household creation (`createHousehold` in `src/contexts/auth-context.tsx` writes the household, the owner's membership, the profile pointer and a `household.created` entry in one client batch) to move to a server action or lose its client-written entry;
- deny the owner/admin updates of other people's `users/{email}` household fields, now written only by the server;
- decide who may read `auditLogs` (still owner/admin by role) and gate reads on `household.view`.

The emulator E2E seed creates Household A and Household B, matching fake identities, a limited member, and a legacy profile-elevation fixture. Cross-household and conservative fallback checks complement the primary owner/admin/member/pending membership path.

## Data Model and Persistence

- Household: `households/{householdId}` with `name`, owner fields, `memberEmails`, timestamps, and `timeZone`. `timeZone` is captured from the creator's browser when the household is created (owners/admins may change it; the rules bound it to a 64-character string). Server-side upkeep uses it for recurring-chore dates and maintenance due days; households without one use `America/Chicago`.
- Membership: `households/{householdId}/members/{uid}`.
- Temporary invite: `inviteCodes/{code}`.
- Audit: `households/{householdId}/auditLogs/{auditId}`.
- System events: `households/{householdId}/notifications/{notificationId}`.
- Legacy compatibility: `users/{email}.{householdId,role,permissions}`, `households.memberEmails`, and `households.ownerEmail`.

Household IDs are slugified names plus a four-character suffix. Invite codes use readable `XXXX-XXXX-XX` values, expire after 30 minutes, and default to one use. The legacy optional `Household.inviteCode` field remains in the type for compatibility but is no longer generated for joining.

## Authentication, Roles, and Security

Roles are `owner`, `admin`, `member`, `child`, `guest`, and system-only `newuser`. Legacy `super-admin` normalizes to owner and `user` to member. Permission presets and per-member overrides are defined in `src/lib/permissions.ts`.

Who may manage what is decided by the management policy above and enforced by the server actions. The rules are a second, older layer that is still role-based (see Not yet closed in the rules): they let approved members list memberships, let owners manage every membership and admins manage non-owner memberships, and block identity (`uid`/`email`) rewrites. The only client-created membership is the creator's `owner` record written in the same batch as a brand-new household; joining an existing household is a server operation. Pending users can read their own membership and the household document (for the waiting screen) but no household subcollections. Deleting your own record removes access; it never grants it.

Ownership invariants are enforced by rules: a membership has role `owner` exactly when `households.ownerUid` points at it, so the last owner cannot demote or remove themselves, and ownership moves only through a single batch that updates `ownerUid` and both membership records.

In the rules, invite codes are created, listed and revoked by owners/admins (`useCount` must start at 0, `maxUses` 1–10); the app itself creates and revokes them only through the server actions, for anyone holding `household.manageInvites`. Clients can no longer read or redeem invites; redemption (expiry, revocation, use count) is a server operation. Owners/admins may update only the role/permissions of profiles that already point at their household, or clear that household; they cannot point another user's profile at a household.

## Integrations and Background Processing

- Governance events create system notifications and therefore can trigger FCM delivery.
- Pending-member reminder checks run client-side when an owner or admin with `household.manageMembers` opens Household Manager; each daily pending state uses a deterministic notification identity so overlapping visits do not create duplicates. No daily scheduled function exists.
- Household deletion is a server action (`deleteHouseholdAction`) that uses the Admin SDK's recursive delete; there is no Cloud Function or scheduled cleanup for it.

## Cross-Module Dependencies

- [Identity and Profile](../identity-profile/README.md) supplies Auth identity and compatibility profile documents.
- [Notifications](../notifications/README.md) displays and pushes system events.
- [Chores](../chores/README.md) is updated to unassign departing/removed members.
- [Firebase Platform](../firebase-platform/README.md) owns rules and Cloud Function deployment.

## Invariants and Failure Behavior

- `newuser` is not manually assignable and has no preset permissions.
- Owners cannot leave before transferring ownership or deleting the household; only the owner can delete, and the delete dialog stays disabled until the typed name matches. The server rechecks ownership and the name.
- Nobody but the owner can act on the owner; the owner's role changes only through an ownership transfer, and the owner cannot be removed.
- Every management operation re-reads the actor and the target inside its transaction, so a concurrent demotion, role change or removal is seen before anything is written.
- A role change resets the member's permission overrides.
- Household creation retries candidate IDs but does not use an explicit nonexistence transaction/precondition around the full batch.
- Manager listeners fail independently, so denied invite/audit/chore queries never blank member data; a failed members listener shows a notice and the caller's own record.
- Member chore stats count chores assigned to the member (chores do not record who ticked them). This week's completions are read with two single-field queries, the same pair of timestamps the Chores module's `completionInstant` reads: `completedAtServer >= weekStart` (the authoritative server stamp, a Timestamp) and the legacy `completedAt >= weekStart` (ISO string); documents missing one field are covered by the other. Open chores come from `isCompleted == false`. The three results are merged by document id (`mergeChoresById`), so a chore found twice counts once, and bucketed with `completionInstant` (`choreStatsByEmail`). Counts are shown only once all three listeners have answered for the current household and week and none failed (`choreStatsReady`); before that, or after a failure, member cards show no chore counts rather than 0. The week boundary moves at local Monday midnight (and is re-checked when the tab regains focus or visibility), which re-subscribes all three queries.
- An unsaved permission draft is tied to the member, their role and their stored overrides; a live role or permission change discards it.
- The permission editor never sends owner-only overrides; the server refuses them (`owner_only`) and the rules reject them.
- `/household?tab=<tab>` opens that tab, including when the page is already open (`overview`, `invites`, `members`, `roles`, `activity`, or `danger`); unknown values, and tabs the viewer cannot see, fall back to Overview. Choosing a tab replaces the URL with `?tab=<tab>` (Overview has no parameter), so refresh and Back keep it. Approval notifications deep-link to `/household?tab=members`.
- Join-request and member-left notifications are written server-side with one notification per event and active owner/admin (a rejoin creates new documents, so push fires again), each targeted by `targetUserUid`. The daily pending-member reminder written client-side by Household Manager is not targeted, so it is shown and pushed to every approved member; push recipients come only from approved member records, never from `memberEmails`.

## Validation

- Run `npm.cmd run lint` and `npm.cmd run typecheck` after governance changes.
- Run `npm.cmd run test:e2e:local` for authenticated owner loading and Household Manager fixture coverage; `tests/e2e/household-ux.spec.ts` covers live data, inline validation, long-name wrapping, the phone 2x2 stat grid, member cards and their menu, the approval banner, keyboard toggling in the permission matrix, `?tab=` deep links and tab clicks writing the URL, an invite created while the clipboard is blocked (success toast with the code, no failure toast), the profile avatar and the automation page.
- `tests/unit/household-governance.test.ts` covers the pure helpers (validation, invite formatting and state, role labels, chore stats, override toggling, audit wording, avatar file checks, Home Assistant state labels) and that Enter in the create-household name field submits its form.
- `tests/unit/household-policy.test.ts` covers the management policy: every actor/target role pair for member management and permission editing, assignable roles, the three `household.manageRoles` guards, self-escalation attempts, owner-only operations and the locked matrix cells.
- `npm run test:server` runs `tests/server/household-management.test.ts` against the emulator: each server action's happy path and writes, every policy refusal, the activity-log entry with the verified actor, and concurrent role/permission/removal changes.
- Manually test household creation collisions, legacy recovery/backfill, invite creation/expiry/revocation/use, pending approval, each role preset, overrides, admin-vs-owner protections, removal, leave, ownership transfer, audit records, and chore reassignment.
- Run `npm run test:rules`: the Firestore/Storage emulator matrix covers unauthenticated callers, other households, pending users, every role, permission overrides, legacy `memberEmails`-only identities, self-deletion, ownership transfer, invite tampering, profile re-pointing, notification targeting and audit forgery.

## When This Document Must Be Updated

Update this README when the management policy, a management server action or its writes change, when Household Manager tabs, member cards, the approval banner or the permission matrix change, or when household/member/invite/audit paths or fields, role presets, permission helpers, approval/reminder behavior, ownership/leave/delete workflows, legacy compatibility, system notifications, emulator seed membership, or governance security rules change.

Session restore (release 2.1, SL-11): while the signed-in session is still being restored the page shows its own loading skeleton, never the sign-in prompt; a genuinely signed-out visitor still gets the prompt. The shared gate is described in [Application Shell](../application-shell/README.md).
