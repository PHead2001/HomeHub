// The "Who's here?" roster on a registered wall tablet (docs/modules/devices/README.md,
// "Actors and kid profiles"; design 6.1, WT-8b, WT-21a). Pure: built from the live
// `members` listener. Shows active owners, admins, members and children, kid profiles
// included, and tablet guest passes (`guest_<id>`, WT-21) only until their `accessUntil`;
// never pending people, departing or removed members, account guests or devices.
// Adults by name, then children, then guest passes. The server applies the same rule to every
// action, so a stale roster can never credit an ineligible person.

import { effectivePermissions } from '@/lib/household-policy';
import { accessUntilMs, guestPassEnded, isGuestIdentityUid } from '@/lib/guest-pass';
import type { HouseholdPermission, PermissionOverrides } from '@/lib/types';
import { policyPermits, type DeviceCapabilityPolicy } from '@/lib/devices/action-policy';

export type RosterPerson = {
  uid: string;
  name: string;
  role: 'owner' | 'admin' | 'member' | 'child' | 'guest';
  kind: 'account' | 'identity';
  avatarUrl: string | null;
  /**
   * Their effective permissions (role preset plus overrides, as the gate computes them), so a
   * face is offered only what that person may do (a child's face gets a child's options,
   * PE-17e). The server decides again for every action.
   */
  permissions?: Record<HouseholdPermission, boolean>;
  /** A tablet guest pass (WT-21): when it ends, so the row drops it on time (`withoutEndedPasses`). */
  accessUntilMs?: number;
};

/** The roster without guest passes that have ended by `nowMs`. */
export const withoutEndedPasses = (people: RosterPerson[], nowMs: number): RosterPerson[] =>
  people.some((person) => person.accessUntilMs !== undefined && person.accessUntilMs <= nowMs)
    ? people.filter((person) => person.accessUntilMs === undefined || person.accessUntilMs > nowMs)
    : people;

/** The next time a pass in the roster ends, or null. */
export const nextPassEnd = (people: readonly RosterPerson[]): number | null => {
  const ends = people.map((person) => person.accessUntilMs).filter((ms): ms is number => ms !== undefined);
  return ends.length > 0 ? Math.min(...ends) : null;
};

/** Whether this person may use a capability (one of its permissions), as far as the tablet knows. */
export const personMay = (person: RosterPerson, permissions: readonly HouseholdPermission[] | null): boolean =>
  !permissions || !person.permissions || permissions.some((permission) => person.permissions![permission]);

/** Whether this person may use a capability under its policy (one-of and all-of permissions, `policyPermits`), as far as the tablet knows. */
export const personMayUse = (person: RosterPerson, policy: Pick<DeviceCapabilityPolicy, 'permissions' | 'permissionsAll'>): boolean =>
  !person.permissions || policyPermits(policy, (permission) => person.permissions![permission] === true);

const ELIGIBLE = new Set(['owner', 'admin', 'member', 'child', 'guest']);

const nameOf = (data: Record<string, unknown>): string => {
  const raw = typeof data.displayName === 'string' ? data.displayName.trim() : '';
  // An email-valued name is never shown on a tablet (WT-10e).
  if (!raw || raw.includes('@')) return 'Someone';
  return raw.slice(0, 40);
};

export function rosterFrom(docs: ReadonlyArray<{ id: string; data: Record<string, unknown> }>, nowMs: number = Date.now()): RosterPerson[] {
  const people: RosterPerson[] = [];
  for (const { id, data } of docs) {
    const role = data.role;
    if (typeof role !== 'string' || !ELIGIBLE.has(role)) continue;
    // A record without `status` is active (as in household-policy, normalizeMember, the rules
    // and the gate); pending, deleting and removed records are not.
    if ((data.status ?? 'active') !== 'active') continue;
    if (id.startsWith('device_')) continue;
    // Guests only as a running tablet pass; any ended pass is gone from the row.
    if (role === 'guest' && !(data.kind === 'identity' && isGuestIdentityUid(id))) continue;
    if (guestPassEnded(data, nowMs)) continue;
    const avatar = typeof data.avatarUrl === 'string' && /^https:\/\//.test(data.avatarUrl) ? data.avatarUrl : null;
    people.push({
      uid: id,
      name: nameOf(data),
      role: role as RosterPerson['role'],
      kind: data.kind === 'identity' ? 'identity' : 'account',
      avatarUrl: avatar,
      ...(accessUntilMs(data.accessUntil) !== null ? { accessUntilMs: accessUntilMs(data.accessUntil)! } : {}),
      permissions: effectivePermissions({
        uid: id, role: role as RosterPerson['role'], status: 'active',
        permissions: data.permissions && typeof data.permissions === 'object' ? data.permissions as PermissionOverrides : {},
      }),
    });
  }
  const rank = (person: RosterPerson) => (person.role === 'guest' ? 2 : person.role === 'child' ? 1 : 0);
  return people.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name) || a.uid.localeCompare(b.uid));
}

export const isOwnerOrAdmin = (person: RosterPerson | null | undefined): boolean =>
  person?.role === 'owner' || person?.role === 'admin';

export const initialsOf = (name: string): string => {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? '') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase() || '?';
};
