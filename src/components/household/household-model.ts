/**
 * Pure helpers for the Household Manager (members, roles, invites, activity).
 * React-free so they are unit-tested (tests/unit/household-model.test.ts).
 *
 * Authorization stays in `src/lib/household-policy.ts` (enforced by the server
 * actions), `src/lib/permissions.ts` and the Firestore rules; these helpers only
 * decide what to show and how to word it.
 */

import { getEffectivePermissions, getRolePresetPermissions, householdPermissions, permissionLabels } from '@/lib/permissions';
import { OWNER_ONLY_PERMISSIONS, canGrantPermission, effectivePermissions, normalizeOverrides, type PolicyMember } from '@/lib/household-policy';
import { completionInstant, type ChoreRecord } from '@/lib/chores/dates';
import { resolveAssigneeUid } from '../../../functions/src/shared/assignee';
import { publicDisplayName } from '@/lib/member-directory';
import { HOUSEHOLD_NAME_MAX } from '@/lib/household-records';
import type { AuditLog, HouseholdMember, HouseholdPermission, HouseholdRole, InviteCode, PermissionOverrides } from '@/lib/types';

/** Household names are limited to 80 characters by the Firestore rules. */
export { HOUSEHOLD_NAME_MAX };

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
    || a.uid.localeCompare(b.uid));
}

/** The name housemates see: the display name, never the email (src/lib/member-directory.ts). */
export function memberName(member: Pick<HouseholdMember, 'displayName'>): string {
  return publicDisplayName(member.displayName);
}

/** First word of the display name, for short prompts ("Approve Jamie?"). */
export function memberFirstName(member: Pick<HouseholdMember, 'displayName'>): string {
  return memberName(member).split(/\s+/)[0];
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

/**
 * The codes still active at `now`, as one key. While it is not empty the Invite
 * Codes list keeps its clock moving, so the last one ticks over to Expired and the
 * clock then stops (HO-8).
 */
export function inviteLiveKey(
  invites: readonly Pick<InviteCode, 'code' | 'revokedAt' | 'expiresAt' | 'maxUses' | 'useCount'>[],
  now = new Date(),
): string {
  return invites
    .filter((invite) => isActiveInvite(invite, now))
    .map((invite) => invite.code)
    .sort()
    .join('|');
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

/** 00:00 local time of the first day (Monday, or Sunday with `weekStartsOn` 0) of the week containing `now`. */
export function startOfWeek(now = new Date(), weekStartsOn: 0 | 1 = 1): Date {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  // Days since the household's first weekday (Monday unless it starts on Sunday, CA-16).
  const day = (start.getDay() - weekStartsOn + 7) % 7;
  start.setDate(start.getDate() - day);
  return start;
}

/** Monday 00:00 local time of the week after the one containing `now`. */
export function startOfNextWeek(now = new Date(), weekStartsOn: 0 | 1 = 1): Date {
  const next = startOfWeek(now, weekStartsOn);
  next.setDate(next.getDate() + 7);
  return next;
}

/* ------------------------------------------------------------------------- */
/* Member stats                                                               */
/* ------------------------------------------------------------------------- */

export type MemberChoreStats = { doneThisWeek: number; open: number };

export type ChoreLike = {
  id?: string;
  assignedToUid?: string | null;
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
 * Counts per member uid: chores completed since `weekStart` and chores still open.
 * Chores carry the assignee, not who ticked them, so "done" means "assigned to and done".
 * The assignee is the uid, or for older chores the member with that email
 * (`resolveAssigneeUid`, functions/src/shared/assignee.ts). The completion time is
 * the Chores module's `completionInstant` (the server stamp `completedAtServer`
 * when present, else `completedAt`).
 */
export function choreStatsByMember(
  chores: readonly ChoreLike[],
  members: readonly { uid: string; email?: string | null }[],
  weekStart: Date,
): Map<string, MemberChoreStats> {
  const stats = new Map<string, MemberChoreStats>();
  const bump = (uid: string, key: keyof MemberChoreStats) => {
    const entry = stats.get(uid) ?? { doneThisWeek: 0, open: 0 };
    entry[key] += 1;
    stats.set(uid, entry);
  };
  for (const chore of chores) {
    const uid = resolveAssigneeUid(chore, members);
    if (!uid) continue;
    if (chore.isCompleted) {
      const at = completionInstant({
        isCompleted: true,
        completedAt: chore.completedAt ?? undefined,
        completedAtServer: chore.completedAtServer as ChoreRecord['completedAtServer'],
      });
      if (at && at >= weekStart) bump(uid, 'doneThisWeek');
    } else {
      bump(uid, 'open');
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
/**
 * Whether the viewer sees another member's custom permissions (HO-12): the person
 * themself and holders of `household.manageRoles` (who edit them). Everyone else
 * (a Child, a Guest, a Member without it) sees role defaults only. A display rule: the
 * membership records, overrides included, stay readable to approved members, because
 * every screen's permission checks read them.
 */
export function canSeeMemberOverrides(
  viewer: { uid?: string | null; permissions?: Partial<Record<HouseholdPermission, boolean>> | null } | null | undefined,
  memberUid: string,
): boolean {
  if (!viewer) return false;
  return viewer.uid === memberUid || viewer.permissions?.['household.manageRoles'] === true;
}

export function customizedPermissions(role: HouseholdRole, overrides: PermissionOverrides | undefined): HouseholdPermission[] {
  return Object.keys(normalizeOverrides(role, overrides)) as HouseholdPermission[];
}

/* ------------------------------------------------------------------------- */
/* Activity                                                                   */
/* ------------------------------------------------------------------------- */

const AUDIT_LABELS: Record<string, string> = {
  'household.created': 'Created the household',
  'household.renamed': 'Renamed the household',
  'household.time_zone_changed': 'Changed the time zone',
  'invite.generated': 'Created an invite code',
  'invite.revoked': 'Revoked an invite code',
  'invite.revoked_all': 'Revoked all active invite codes',
  'member.joined_pending': 'Asked to join',
  'member.approved': 'Approved a member',
  'member.role_changed': 'Changed a role',
  'member.permissions_changed': 'Customized permissions',
  'member.removed': 'Removed a member',
  'member.left': 'Left the household',
  'member.request_cancelled': 'Cancelled a request to join',
  'member.guest_pass_ended': 'Guest pass ended; access removed',
  'guest.created': 'Added a tablet guest pass',
  'guest.removed': 'Removed a tablet guest pass',
  'ownership.transferred': 'Transferred ownership',
  'device.code_created': 'Created a wall-tablet code',
  'device.repair_code_created': 'Created a code to re-pair a wall tablet',
  'device.code_revoked': 'Cancelled a wall-tablet code',
  'device.paired': 'Paired a wall tablet',
  'device.repaired': 'Re-paired a wall tablet',
  'device.settings_changed': 'Changed wall-tablet settings',
  'device.removed': 'Removed a wall tablet',
  'device.exited': 'Signed a wall tablet out',
  'device.action': 'Used a wall tablet with a PIN',
  'device.policy_changed': 'Changed the points PIN for wall tablets',
  'device.quiet_hours_changed': 'Changed quiet hours for wall tablets',
  'pin.set': 'Set a tablet PIN',
  'pin.cleared': 'Cleared a tablet PIN',
  'pin.locked': 'Tablet PIN locked after too many wrong tries',
  'pin.device_locked': 'Tablet PIN paused on one tablet after wrong tries',
  'pin.lockout_cleared': 'Unlocked a tablet PIN',
  'child.created': 'Added a kid profile',
  'child.updated': 'Edited a kid profile',
  'child.removed': 'Removed a kid profile',
  // Home Assistant (AU-12; written by the server, never with the token).
  'automation.connected': 'Connected Home Assistant',
  'automation.token_replaced': 'Replaced the Home Assistant token',
  'automation.disconnected': 'Disconnected Home Assistant',
  'automation.settings_changed': 'Changed Home Assistant privacy or alerts',
  // Written by the Pets delete action (D-P12).
  'pet.deleted': 'Deleted a pet',
};

/** "Manage invites, Delete shopping" from the server's comma-joined permission keys. */
function permissionList(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.split(',').map((key) => key.trim()).filter(Boolean)
    .map((key) => permissionLabels[key as HouseholdPermission] ?? key)
    .join(', ');
}

/**
 * Plain-language sentence for an audit entry, with what changed when the server
 * recorded it (HO-8: from/to for roles and renames, the permissions given and taken
 * away). Unknown actions fall back to a readable form.
 */
export function describeAuditAction(log: Pick<AuditLog, 'action' | 'details'>): string {
  const base = AUDIT_LABELS[log.action];
  const details = log.details ?? {};
  if (log.action === 'member.role_changed' && typeof details.role === 'string') {
    const to = roleLabel(details.role as HouseholdRole);
    return typeof details.previousRole === 'string' && details.previousRole
      ? `Changed a role from ${roleLabel(details.previousRole as HouseholdRole)} to ${to}`
      : `Changed a role to ${to}`;
  }
  if (log.action === 'household.renamed' && typeof details.householdName === 'string' && details.householdName) {
    return typeof details.previousName === 'string' && details.previousName
      ? `Renamed the household from "${details.previousName}" to "${details.householdName}"`
      : `Renamed the household to "${details.householdName}"`;
  }
  if (log.action === 'household.time_zone_changed' && typeof details.timeZone === 'string' && details.timeZone) {
    return typeof details.previousTimeZone === 'string' && details.previousTimeZone
      ? `Changed the time zone from ${details.previousTimeZone} to ${details.timeZone}`
      : `Set the time zone to ${details.timeZone}`;
  }
  if (log.action === 'member.permissions_changed') {
    const granted = permissionList(details.granted);
    const revoked = permissionList(details.revoked);
    const parts = [granted && `allowed ${granted}`, revoked && `took away ${revoked}`].filter(Boolean);
    if (parts.length > 0) return `Customized permissions: ${parts.join('; ')}`;
  }
  if (log.action === 'member.approved' && typeof details.role === 'string') {
    const pass = typeof details.accessUntil === 'string' && details.accessUntil ? ' with a guest pass' : '';
    return `Approved a member as ${roleLabel(details.role as HouseholdRole)}${pass}`;
  }
  if (log.action === 'member.removed' && details.pending === true) return 'Denied a request to join';
  if (log.action === 'pet.deleted' && typeof details.petName === 'string' && details.petName.trim()) return `Deleted the pet ${details.petName.trim()}`;
  if (base) return base;
  const words = log.action.replace(/[._]+/g, ' ').trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : 'Household activity';
}

/** Activity filters (HO-28). */
export type AuditFilter = 'all' | 'people' | 'invites' | 'roles' | 'tablets';

export const AUDIT_FILTERS: ReadonlyArray<{ value: AuditFilter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'people', label: 'People' },
  { value: 'invites', label: 'Invites' },
  { value: 'roles', label: 'Roles and permissions' },
  { value: 'tablets', label: 'Tablets' },
];

/** Which filter an activity entry belongs to; household-wide changes (rename, time zone, pets) show under All only. */
export function auditCategory(action: string): Exclude<AuditFilter, 'all'> | 'other' {
  if (action === 'member.role_changed' || action === 'member.permissions_changed') return 'roles';
  if (action.startsWith('invite.')) return 'invites';
  if (action.startsWith('device.') || action.startsWith('pin.')) return 'tablets';
  if (action.startsWith('member.') || action === 'ownership.transferred' || action.startsWith('child.') || action.startsWith('guest.')) return 'people';
  return 'other';
}

export function filterAuditLogs<T extends Pick<AuditLog, 'action'>>(logs: readonly T[], filter: AuditFilter): T[] {
  return filter === 'all' ? [...logs] : logs.filter((log) => auditCategory(log.action) === filter);
}

/** Entries the Activity tab reads per page; "Load more" asks for the next page (HO-22). */
export const AUDIT_PAGE_SIZE = 50;
/** Newest invite codes the Invite Codes tab reads (HO-22); codes last 30 minutes, so every active one is among them. */
export const INVITE_LIST_LIMIT = 25;
/** Used, expired or revoked codes shown before "Show older" (HO-20). */
export const INVITE_HISTORY_SHOWN = 5;

/**
 * The invite list (HO-20): every active code, then the newest few that can no longer be
 * used; the rest wait behind "Show older".
 */
export function inviteHistory<T extends Pick<InviteCode, 'revokedAt' | 'expiresAt' | 'maxUses' | 'useCount'>>(
  invites: readonly T[],
  now: Date,
  showAll = false,
  keep = INVITE_HISTORY_SHOWN,
): { shown: T[]; hidden: number } {
  const active = invites.filter((invite) => isActiveInvite(invite, now));
  const inactive = invites.filter((invite) => !isActiveInvite(invite, now));
  const kept = showAll ? inactive : inactive.slice(0, keep);
  return { shown: [...active, ...kept], hidden: inactive.length - kept.length };
}

/** The exact time of an entry, shown beside "2 hours ago" (HO-20: not hover-only). */
export function absoluteTime(iso: string, timeZone?: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('en-US', { timeZone: timeZone || undefined, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(date);
}

/**
 * Who did it, for the Activity list: the actor, and for an action taken on a wall
 * tablet "as Alex (PIN) on Kitchen tablet" (WT-18b; the server records the device,
 * the selected person and the level separately).
 */
export function describeAuditActor(log: Pick<AuditLog, 'actorName' | 'actorEmail' | 'via' | 'deviceName' | 'level'>): string {
  const actor = log.actorName || log.actorEmail || 'HomeHub';
  if (log.via !== 'device' || !log.deviceName) return actor;
  if (log.level === 'pin' || log.level === 'face') return `as ${actor} (${log.level === 'pin' ? 'PIN' : 'face'}) on ${log.deviceName}`;
  return `${actor} on ${log.deviceName}`;
}

/**
 * What the Household page shows (HO-8): the sign-in prompt, a skeleton while the
 * household is still loading (never "No household yet" on a cold load), the
 * no-household card, the waiting or not-available card, or the page. Access comes
 * from the resolved permissions (`getMemberPermissions`, which also requires an
 * approved, active record), never from the role name.
 */
export type HouseholdPageGate = 'sign-in' | 'loading' | 'no-household' | 'waiting' | 'not-available' | 'page';

export function householdPageGate(input: {
  signedIn: boolean;
  householdLoading: boolean;
  hasHousehold: boolean;
  member: Pick<HouseholdMember, 'role' | 'status'> | null | undefined;
  permissions: Partial<Record<HouseholdPermission, boolean>> | null | undefined;
}): HouseholdPageGate {
  if (!input.signedIn) return 'sign-in';
  if (!input.hasHousehold) return input.householdLoading ? 'loading' : 'no-household';
  if (householdManagerReads(input.permissions).page) return 'page';
  const member = input.member;
  return !member || member.role === 'newuser' || member.status === 'pending' ? 'waiting' : 'not-available';
}

/**
 * Whether Members shows "It's just you so far": only when the list really loaded and
 * holds nobody else, never under a failed load (HO-8).
 */
export function showSoloMembersState(approvedCount: number, shownPendingCount: number, membersFailed: boolean): boolean {
  return !membersFailed && approvedCount <= 1 && shownPendingCount === 0;
}

/**
 * The Make owner confirmation (HO-8): a Child or Guest gets an explicit warning,
 * since ownership is full control whatever role the person had.
 */
export function transferOwnershipDescription(member: Pick<HouseholdMember, 'displayName' | 'role'>): string {
  const outcome = 'They get full control, including removing people and deleting the household. You become an admin.';
  if (member.role === 'child' || member.role === 'guest') {
    return `${memberName(member)} is a ${roleLabel(member.role)}, a role with limited access. ${outcome}`;
  }
  return 'They get full control, including deleting the household. You become an admin.';
}

/** Which Household Manager listeners the viewer opens (`householdManagerReads`). */
export type HouseholdManagerReads = {
  /** `household.view`: the page itself, and with it the household and member listeners. */
  page: boolean;
  /** Invite codes: `household.view` and `household.manageInvites`. */
  invites: boolean;
  /** Activity log: `household.view` and `household.manageMembers`. */
  audit: boolean;
  /** Other members' contact documents: `household.view` and `household.manageMembers`. */
  contacts: boolean;
  /** Member chore counts: `household.view` and `chores.view`. */
  choreStats: boolean;
};

/**
 * What the Household Manager reads, from the viewer's effective permissions
 * (`getMemberPermissions`). It mirrors firestore.rules, where invite codes, the
 * activity log and other members' contact documents need `household.view` as well
 * as their own permission, so no listener is opened that the rules would deny.
 * Without `household.view` the page reads nothing.
 */
/**
 * The Members stat on the Household overview (HO-10b): the approved count, and for
 * holders of `household.manageMembers` only, how many requests are pending
 * ("3 · 1 pending"). Everyone else never learns that anyone is waiting.
 * @returns {{ approved: number, pending: number | null, text: string }} `pending` is null when not shown.
 */
export function memberStat(approvedCount: number, pendingCount: number, canManageMembers: boolean) {
  const pending = canManageMembers && pendingCount > 0 ? pendingCount : null;
  return { approved: approvedCount, pending, text: pending === null ? String(approvedCount) : `${approvedCount} · ${pending} pending` };
}

export function householdManagerReads(permissions: Partial<Record<HouseholdPermission, boolean>> | null | undefined): HouseholdManagerReads {
  const page = Boolean(permissions?.['household.view']);
  const manageMembers = page && Boolean(permissions?.['household.manageMembers']);
  return {
    page,
    invites: page && Boolean(permissions?.['household.manageInvites']),
    audit: manageMembers,
    contacts: manageMembers,
    choreStats: page && Boolean(permissions?.['chores.view']),
  };
}
