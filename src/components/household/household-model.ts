/**
 * Pure helpers for the Household Manager (members, roles, invites, activity).
 * React-free so they are unit-tested (tests/unit/household-model.test.ts).
 *
 * Authorization stays in `src/lib/household-policy.ts` (enforced by the server
 * actions), `src/lib/permissions.ts` and the Firestore rules; these helpers only
 * decide what to show and how to word it.
 */

import { getEffectivePermissions, getRolePresetPermissions, householdPermissions } from '@/lib/permissions';
import { OWNER_ONLY_PERMISSIONS, canGrantPermission, effectivePermissions, normalizeOverrides, type PolicyMember } from '@/lib/household-policy';
import { completionInstant, type ChoreRecord } from '@/lib/chores/dates';
import type { AuditLog, HouseholdMember, HouseholdPermission, HouseholdRole, InviteCode, PermissionOverrides } from '@/lib/types';

/** Household names are limited to 80 characters by the Firestore rules. */
export const HOUSEHOLD_NAME_MAX = 80;

/** Roles shown as matrix columns. `newuser` (pending) has no permissions and is described instead. */
export const MATRIX_ROLES: readonly HouseholdRole[] = ['owner', 'admin', 'member', 'child', 'guest'];

/** Order members are listed in (owner first, pending last). */
export const ROLE_ORDER: readonly HouseholdRole[] = ['owner', 'admin', 'member', 'child', 'guest', 'newuser'];

/** Only the owner holds these; the editor locks them (see `src/lib/household-policy.ts`). */
export { OWNER_ONLY_PERMISSIONS, normalizeOverrides };

const ROLE_LABELS: Record<HouseholdRole, string> = {
  owner: 'Owner',
  admin: 'Admin',
  member: 'Member',
  child: 'Child',
  guest: 'Guest',
  // `newuser` is an internal name; people see "Pending".
  newuser: 'Pending',
};

export function roleLabel(role: HouseholdRole | null | undefined): string {
  return role ? ROLE_LABELS[role] ?? 'Member' : 'Member';
}

const ROLE_SUMMARIES: Record<HouseholdRole, string> = {
  owner: 'Everything, including deleting the household and handing it over.',
  admin: 'Runs the household: people, invites and every module.',
  member: 'Day-to-day use: chores, shopping, pets and maintenance.',
  child: 'Sees and completes chores and logs pet care.',
  guest: 'Can look around but not change anything.',
  newuser: 'Waiting for approval. Sees nothing until someone picks a role.',
};

export function roleSummary(role: HouseholdRole): string {
  return ROLE_SUMMARIES[role];
}

export function sortMembers(members: readonly HouseholdMember[]): HouseholdMember[] {
  return [...members].sort((a, b) =>
    ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role)
    || memberName(a).localeCompare(memberName(b))
    || a.email.localeCompare(b.email));
}

export function memberName(member: Pick<HouseholdMember, 'displayName' | 'email'>): string {
  return member.displayName?.trim() || member.email;
}

/** First word of the display name, for short prompts ("Approve Jamie?"). */
export function memberFirstName(member: Pick<HouseholdMember, 'displayName' | 'email'>): string {
  const name = member.displayName?.trim();
  if (name) return name.split(/\s+/)[0];
  return member.email.split('@')[0];
}

export function isPendingMember(member: Pick<HouseholdMember, 'role'>): boolean {
  return member.role === 'newuser';
}

/* ------------------------------------------------------------------------- */
/* Validation                                                                 */
/* ------------------------------------------------------------------------- */

/** Inline message for a household name, or null when it is fine. */
export function householdNameError(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return 'Give your household a name.';
  if (trimmed.length > HOUSEHOLD_NAME_MAX) return `Keep it under ${HOUSEHOLD_NAME_MAX} characters.`;
  return null;
}

/** Show invite codes as XXXX-XXXX-XX while people type, with or without dashes. */
export function formatInviteInput(value: string): string {
  const compact = value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10);
  return [compact.slice(0, 4), compact.slice(4, 8), compact.slice(8)].filter(Boolean).join('-');
}

export function inviteCodeError(code: string): string | null {
  const compact = code.replace(/[^A-Za-z0-9]/g, '');
  if (!compact) return 'Enter the invite code you were given.';
  if (compact.length !== 10) return 'Invite codes have 10 letters and numbers, like ABCD-EFGH-JK.';
  return null;
}

/* ------------------------------------------------------------------------- */
/* Invites                                                                    */
/* ------------------------------------------------------------------------- */

export type InviteState = 'active' | 'revoked' | 'used' | 'expired';

export function inviteState(invite: Pick<InviteCode, 'revokedAt' | 'expiresAt' | 'maxUses' | 'useCount'>, now = new Date()): InviteState {
  if (invite.revokedAt) return 'revoked';
  if ((invite.useCount ?? 0) >= (invite.maxUses ?? 1)) return 'used';
  const expiresAt = new Date(invite.expiresAt);
  if (Number.isNaN(expiresAt.getTime()) || expiresAt <= now) return 'expired';
  return 'active';
}

export function isActiveInvite(invite: Pick<InviteCode, 'revokedAt' | 'expiresAt' | 'maxUses' | 'useCount'>, now = new Date()): boolean {
  return inviteState(invite, now) === 'active';
}

export const INVITE_STATE_LABELS: Record<InviteState, string> = {
  active: 'Active',
  revoked: 'Revoked',
  used: 'Used',
  expired: 'Expired',
};

/* ------------------------------------------------------------------------- */
/* Time                                                                       */
/* ------------------------------------------------------------------------- */

/** "just now", "5 min ago", "3 h ago", "2 days ago", then a short date. Future: "in 12 min". */
export function relativeTime(value: string | undefined | null, now = new Date()): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const diffMs = now.getTime() - date.getTime();
  const future = diffMs < 0;
  const minutes = Math.round(Math.abs(diffMs) / 60_000);
  const phrase = (text: string) => (future ? `in ${text}` : `${text} ago`);
  if (minutes < 1) return future ? 'in under a minute' : 'just now';
  if (minutes < 60) return phrase(`${minutes} min`);
  const hours = Math.round(minutes / 60);
  if (hours < 24) return phrase(`${hours} h`);
  const days = Math.round(hours / 24);
  if (days < 7) return phrase(`${days} ${days === 1 ? 'day' : 'days'}`);
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: date.getFullYear() === now.getFullYear() ? undefined : 'numeric' });
}

/** Monday 00:00 local time of the week containing `now`. */
export function startOfWeek(now = new Date()): Date {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const day = (start.getDay() + 6) % 7; // Monday = 0
  start.setDate(start.getDate() - day);
  return start;
}

/** Monday 00:00 local time of the week after the one containing `now`. */
export function startOfNextWeek(now = new Date()): Date {
  const next = startOfWeek(now);
  next.setDate(next.getDate() + 7);
  return next;
}

/* ------------------------------------------------------------------------- */
/* Member stats                                                               */
/* ------------------------------------------------------------------------- */

export type MemberChoreStats = { doneThisWeek: number; open: number };

export type ChoreLike = {
  id?: string;
  assignedToEmail?: string | null;
  isCompleted?: boolean;
  completedAt?: string | null;
  /** Server completion stamp (Timestamp-like); authoritative when present. */
  completedAtServer?: unknown;
};

/**
 * Merges chore lists from several queries by document id (later lists win), so a
 * chore found by more than one query (open, completed by server stamp, completed
 * by the legacy client date) counts once.
 */
export function mergeChoresById<T extends { id?: string }>(...lists: readonly (readonly T[])[]): T[] {
  const byId = new Map<string, T>();
  const anonymous: T[] = [];
  for (const list of lists) {
    for (const chore of list) {
      if (chore.id) byId.set(chore.id, chore);
      else anonymous.push(chore);
    }
  }
  return [...byId.values(), ...anonymous];
}

/**
 * Counts per member email: chores completed since `weekStart` and chores still open.
 * Chores carry the assignee, not who ticked them, so "done" means "assigned to and done".
 * The completion time is the Chores module's `completionInstant` (the server stamp
 * `completedAtServer` when present, else `completedAt`).
 */
export function choreStatsByEmail(chores: readonly ChoreLike[], weekStart: Date): Map<string, MemberChoreStats> {
  const stats = new Map<string, MemberChoreStats>();
  const bump = (email: string, key: keyof MemberChoreStats) => {
    const entry = stats.get(email) ?? { doneThisWeek: 0, open: 0 };
    entry[key] += 1;
    stats.set(email, entry);
  };
  for (const chore of chores) {
    const email = chore.assignedToEmail?.trim().toLowerCase();
    if (!email) continue;
    if (chore.isCompleted) {
      const at = completionInstant({
        isCompleted: true,
        completedAt: chore.completedAt ?? undefined,
        completedAtServer: chore.completedAtServer as ChoreRecord['completedAtServer'],
      });
      if (at && at >= weekStart) bump(email, 'doneThisWeek');
    } else {
      bump(email, 'open');
    }
  }
  return stats;
}

/* ------------------------------------------------------------------------- */
/* Permission matrix                                                          */
/* ------------------------------------------------------------------------- */

/**
 * Toggles one permission in a member's override draft. Overrides that match the
 * role default are dropped, so the stored map only holds real differences.
 */
export function togglePermissionOverride(
  role: HouseholdRole,
  draft: PermissionOverrides,
  permission: HouseholdPermission,
): PermissionOverrides {
  if (OWNER_ONLY_PERMISSIONS.includes(permission) || role === 'owner') return draft;
  const defaults = getRolePresetPermissions(role);
  const current = draft[permission] ?? defaults[permission];
  const nextValue = !current;
  const next: PermissionOverrides = { ...draft };
  if (nextValue === defaults[permission]) delete next[permission];
  else next[permission] = nextValue;
  return next;
}

/**
 * Identity of a permission draft: the member, their role and their stored
 * overrides. A role change resets overrides to `{}`, which can leave the stored
 * overrides unchanged, so the role must be part of the key; otherwise a draft
 * prepared for the old role would survive a live role change and could be saved.
 */
export function permissionDraftKey(
  member: Pick<HouseholdMember, 'uid' | 'role' | 'permissions'> | null,
): string {
  if (!member) return '';
  return `${member.uid}|${member.role}|${JSON.stringify(normalizeOverrides(member.role, member.permissions))}`;
}

/**
 * Matrix cells the editor locks, with the reason: the two owner-only
 * permissions, and any permission the viewer does not hold that the member does
 * not already have (ticking it would be a grant). A permission the member
 * already has stays editable, so it can be taken away.
 */
export function lockedPermissionCells(
  actor: PolicyMember | null | undefined,
  role: HouseholdRole,
  saved: PermissionOverrides | undefined,
): Partial<Record<HouseholdPermission, string>> {
  const current = effectivePermissions({ uid: '', role, status: 'active', permissions: saved });
  const locked: Partial<Record<HouseholdPermission, string>> = {};
  for (const permission of householdPermissions) {
    if (OWNER_ONLY_PERMISSIONS.includes(permission)) locked[permission] = 'Only the owner can do this';
    else if (!current[permission] && !canGrantPermission(actor, permission).ok) {
      locked[permission] = "You can't give a permission you don't have yourself";
    }
  }
  return locked;
}

/** Permissions whose effective value differs between two override maps. */
export function changedPermissions(
  role: HouseholdRole,
  saved: PermissionOverrides | undefined,
  draft: PermissionOverrides | undefined,
): HouseholdPermission[] {
  const before = getEffectivePermissions(role, saved);
  const after = getEffectivePermissions(role, draft);
  return householdPermissions.filter((permission) => before[permission] !== after[permission]);
}

/** Permissions where the member differs from their role's default. */
export function customizedPermissions(role: HouseholdRole, overrides: PermissionOverrides | undefined): HouseholdPermission[] {
  return Object.keys(normalizeOverrides(role, overrides)) as HouseholdPermission[];
}

/* ------------------------------------------------------------------------- */
/* Activity                                                                   */
/* ------------------------------------------------------------------------- */

const AUDIT_LABELS: Record<string, string> = {
  'household.created': 'Created the household',
  'household.renamed': 'Renamed the household',
  'invite.generated': 'Created an invite code',
  'invite.revoked': 'Revoked an invite code',
  'invite.revoked_all': 'Revoked all active invite codes',
  'member.joined_pending': 'Asked to join',
  'member.approved': 'Approved a member',
  'member.role_changed': 'Changed a role',
  'member.permissions_changed': 'Customized permissions',
  'member.removed': 'Removed a member',
  'member.left': 'Left the household',
  'ownership.transferred': 'Transferred ownership',
};

/** Plain-language sentence for an audit entry; unknown actions fall back to a readable form. */
export function describeAuditAction(log: Pick<AuditLog, 'action' | 'details'>): string {
  const base = AUDIT_LABELS[log.action];
  const details = log.details ?? {};
  if (log.action === 'member.role_changed' && typeof details.role === 'string') {
    return `Changed a role to ${roleLabel(details.role as HouseholdRole)}`;
  }
  if (log.action === 'member.approved' && typeof details.role === 'string') {
    return `Approved a member as ${roleLabel(details.role as HouseholdRole)}`;
  }
  if (log.action === 'member.removed' && details.pending === true) return 'Denied a request to join';
  if (base) return base;
  const words = log.action.replace(/[._]+/g, ' ').trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : 'Household activity';
}
