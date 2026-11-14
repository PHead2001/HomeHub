/**
 * Household management policy: who may do what to whom.
 *
 * Pure (no Firebase, no React). The server actions in
 * `src/lib/server/household-membership.ts` enforce it inside their transactions
 * and the Household Manager uses the same functions to decide what to show, so
 * the two can never disagree.
 *
 * - `household.manageInvites`: create and revoke invite codes.
 * - `household.manageMembers`: approve, change roles, remove, rename the
 *   household; only on people whose rank is strictly lower than the actor's, and
 *   never assigning a role at or above the actor's own rank.
 * - `household.manageRoles`: edit another member's permission overrides; never
 *   your own, never someone at or above your rank, and never granting a
 *   permission you do not hold yourself. Revoking is allowed.
 * - `household.delete` and `household.transferOwnership`: the owner only. They
 *   can never be granted through overrides.
 */

import { assignableRoles, getMemberPermissions, getRolePresetPermissions, householdPermissions } from '@/lib/permissions';
import type { HouseholdMember, HouseholdPermission, HouseholdRole, PermissionOverrides } from '@/lib/types';

/** Only the owner holds these, whatever a stored override says. */
export const OWNER_ONLY_PERMISSIONS: readonly HouseholdPermission[] = ['household.delete', 'household.transferOwnership'];

export const isOwnerOnlyPermission = (permission: HouseholdPermission): boolean => OWNER_ONLY_PERMISSIONS.includes(permission);

/** The membership fields the policy reads. `status` defaults to active, as in the rules. */
export type PolicyMember = Pick<HouseholdMember, 'uid' | 'role'> & {
  status?: HouseholdMember['status'];
  permissions?: PermissionOverrides;
  /** `'identity'`: a kid profile with no sign-in (fixed Child role, never an owner). */
  kind?: HouseholdMember['kind'];
};

export type PolicyRefusal =
  /** The actor or target has no usable membership record. */
  | 'not_member'
  /** The actor does not hold the permission this operation needs. */
  | 'missing_permission'
  /** People cannot manage themselves this way. */
  | 'self'
  /** The target's rank is equal to or above the actor's (this includes the owner). */
  | 'rank'
  /** The role cannot be assigned by anyone (owner, pending). */
  | 'role_not_assignable'
  /** The role is at or above the actor's own rank. */
  | 'role_too_high'
  /** Only the owner may do this, or the permission belongs to the owner alone. */
  | 'owner_only'
  /** The actor tried to grant a permission they do not hold. */
  | 'grant_unheld'
  /** The target is still pending and has no permissions to edit, or cannot become owner. */
  | 'target_pending'
  /** A kid profile's role is fixed at Child. */
  | 'identity_fixed_role'
  /** A kid profile cannot become the owner. */
  | 'target_identity';

export type PolicyDecision = { ok: true } | { ok: false; reason: PolicyRefusal };

const allow: PolicyDecision = { ok: true };
const refuse = (reason: PolicyRefusal): PolicyDecision => ({ ok: false, reason });

const RANKS: Record<HouseholdRole, number> = {
  owner: 4,
  admin: 3,
  member: 2,
  child: 1,
  guest: 1,
  newuser: 0,
};

/**
 * owner > admin > member > child = guest > newuser (pending). Anything else
 * (including legacy role names, which the rules do not honor either) ranks lowest.
 */
export const rank = (role: HouseholdRole | null | undefined): number => (role ? RANKS[role] ?? 0 : 0);

const isActive = (member: PolicyMember | null | undefined): member is PolicyMember =>
  Boolean(member) && (member!.status || 'active') === 'active';

/**
 * What a member can actually do: role preset merged with overrides (the owner
 * always has everything; pending or inactive people have nothing), with the two
 * owner-only permissions forced off for everyone but the owner.
 */
export const effectivePermissions = (member: PolicyMember | null | undefined): Record<HouseholdPermission, boolean> => {
  const permissions = {
    ...getMemberPermissions(member ? { role: member.role, status: member.status || 'active', permissions: member.permissions } : null),
  };
  if (!member || member.role !== 'owner') {
    for (const permission of OWNER_ONLY_PERMISSIONS) permissions[permission] = false;
  }
  return permissions;
};

export const holdsPermission = (member: PolicyMember | null | undefined, permission: HouseholdPermission): boolean =>
  Boolean(effectivePermissions(member)[permission]);

const requirePermission = (actor: PolicyMember | null | undefined, permission: HouseholdPermission): PolicyDecision => {
  if (!isActive(actor) || actor.role === 'newuser') return refuse('not_member');
  return holdsPermission(actor, permission) ? allow : refuse('missing_permission');
};

/** Create and revoke invite codes. */
export const canManageInvites = (actor: PolicyMember | null | undefined): PolicyDecision =>
  requirePermission(actor, 'household.manageInvites');

/** Rename the household. */
export const canRenameHousehold = (actor: PolicyMember | null | undefined): PolicyDecision =>
  requirePermission(actor, 'household.manageMembers');

/** Send the daily "still needs a role" reminder about pending people (they can approve them). */
export const canRemindPendingMembers = (actor: PolicyMember | null | undefined): PolicyDecision =>
  requirePermission(actor, 'household.manageMembers');

/** Shared guard: an active actor acting on someone else of strictly lower rank. */
const outranks = (actor: PolicyMember, target: PolicyMember | null | undefined): PolicyDecision => {
  if (!target) return refuse('not_member');
  if (actor.uid === target.uid) return refuse('self');
  return rank(actor.role) > rank(target.role) ? allow : refuse('rank');
};

/** Approve, change the role of, or remove `target` (`household.manageMembers`). */
export const canManageMember = (actor: PolicyMember | null | undefined, target: PolicyMember | null | undefined): PolicyDecision => {
  const permitted = requirePermission(actor, 'household.manageMembers');
  if (!permitted.ok) return permitted;
  return outranks(actor!, target);
};

export const canRemoveMember = canManageMember;

/** Give `target` the role `newRole`; approving a pending person is the same check. */
export const canAssignRole = (
  actor: PolicyMember | null | undefined,
  target: PolicyMember | null | undefined,
  newRole: HouseholdRole,
): PolicyDecision => {
  const manageable = canManageMember(actor, target);
  if (!manageable.ok) return manageable;
  if (target?.kind === 'identity') return refuse('identity_fixed_role');
  if (!assignableRoles.includes(newRole)) return refuse('role_not_assignable');
  return rank(newRole) < rank(actor!.role) ? allow : refuse('role_too_high');
};

/** Effective permission values that an edit would change (permission → new value). */
export type PermissionChanges = Partial<Record<HouseholdPermission, boolean>>;

/** Removes overrides equal to the role default and any owner-only grants. */
export const normalizeOverrides = (role: HouseholdRole, overrides: PermissionOverrides | null | undefined): PermissionOverrides => {
  const defaults = getRolePresetPermissions(role);
  const result: PermissionOverrides = {};
  for (const permission of householdPermissions) {
    const value = overrides?.[permission];
    if (typeof value !== 'boolean' || value === defaults[permission]) continue;
    if (isOwnerOnlyPermission(permission) && value) continue;
    result[permission] = value;
  }
  return result;
};

/** What saving `nextOverrides` would change for a member with `role` and `currentOverrides`. */
export const permissionChanges = (
  role: HouseholdRole,
  currentOverrides: PermissionOverrides | null | undefined,
  nextOverrides: PermissionOverrides | null | undefined,
): PermissionChanges => {
  const before = effectivePermissions({ uid: '', role, status: 'active', permissions: currentOverrides ?? undefined });
  const after = effectivePermissions({ uid: '', role, status: 'active', permissions: nextOverrides ?? undefined });
  const changes: PermissionChanges = {};
  for (const permission of householdPermissions) {
    if (before[permission] !== after[permission]) changes[permission] = after[permission];
  }
  return changes;
};

/**
 * Edit `target`'s permission overrides (`household.manageRoles`). `changes` are
 * the effective values the edit would change; pass `{}` to ask whether the actor
 * may edit this person at all.
 */
export const canEditPermissions = (
  actor: PolicyMember | null | undefined,
  target: PolicyMember | null | undefined,
  changes: PermissionChanges = {},
): PolicyDecision => {
  const permitted = requirePermission(actor, 'household.manageRoles');
  if (!permitted.ok) return permitted;
  const outranked = outranks(actor!, target);
  if (!outranked.ok) return outranked;
  if (target!.role === 'newuser') return refuse('target_pending');
  const held = effectivePermissions(actor);
  for (const permission of householdPermissions) {
    const value = changes[permission];
    if (value !== true) continue;
    if (isOwnerOnlyPermission(permission)) return refuse('owner_only');
    if (!held[permission]) return refuse('grant_unheld');
  }
  return allow;
};

/** May the actor tick (grant) this one permission for someone they can edit? */
export const canGrantPermission = (actor: PolicyMember | null | undefined, permission: HouseholdPermission): PolicyDecision => {
  if (isOwnerOnlyPermission(permission)) return refuse('owner_only');
  return holdsPermission(actor, permission) ? allow : refuse('grant_unheld');
};

const isActiveOwner = (actor: PolicyMember | null | undefined): boolean =>
  isActive(actor) && actor.role === 'owner';

/** Owner only, always. */
export const canDeleteHousehold = (actor: PolicyMember | null | undefined): PolicyDecision => {
  if (!actor) return refuse('not_member');
  return isActiveOwner(actor) ? allow : refuse('owner_only');
};

/** Owner only, always; the new owner must be another approved, active member. */
export const canTransferOwnership = (actor: PolicyMember | null | undefined, target: PolicyMember | null | undefined): PolicyDecision => {
  if (!actor) return refuse('not_member');
  if (!isActiveOwner(actor)) return refuse('owner_only');
  if (!target) return refuse('not_member');
  if (actor.uid === target.uid) return refuse('self');
  if (target.kind === 'identity') return refuse('target_identity');
  if (target.role === 'newuser' || !isActive(target)) return refuse('target_pending');
  return allow;
};

const REFUSAL_MESSAGES: Record<PolicyRefusal, string> = {
  not_member: 'You are not an approved member of this household.',
  missing_permission: "You don't have permission to do that. Ask the household owner if you think you should.",
  self: "You can't do that to your own membership.",
  rank: 'You can only manage people with a lower role than yours.',
  role_not_assignable: "That role can't be assigned.",
  role_too_high: 'You can only assign roles below your own.',
  owner_only: 'Only the household owner can do that.',
  grant_unheld: "You can't give someone a permission you don't have yourself.",
  target_pending: 'Approve this person first.',
  identity_fixed_role: "A kid profile's role is always Child.",
  target_identity: "A kid profile can't own the household.",
};

/** Plain-language sentence for a refusal, for toasts, tooltips and server results. */
export const refusalMessage = (reason: PolicyRefusal): string => REFUSAL_MESSAGES[reason];
