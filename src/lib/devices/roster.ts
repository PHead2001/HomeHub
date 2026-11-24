// The "Who's here?" roster on a registered wall tablet (docs/modules/devices/README.md,
// "Actors and kid profiles"; design 6.1, WT-8b, WT-21a). Pure: built from the live
// `members` listener. Shows active owners, admins, members and children, kid profiles
// included; never pending people, departing or removed members, guests or devices.
// Adults by name, then children by name. The server applies the same rule to every
// action, so a stale roster can never credit an ineligible person.

import { effectivePermissions } from '@/lib/household-policy';
import type { HouseholdPermission, PermissionOverrides } from '@/lib/types';
import { policyPermits, type DeviceCapabilityPolicy } from '@/lib/devices/action-policy';

export type RosterPerson = {
  uid: string;
  name: string;
  role: 'owner' | 'admin' | 'member' | 'child';
  kind: 'account' | 'identity';
  avatarUrl: string | null;
  /**
   * Their effective permissions (role preset plus overrides, as the gate computes them), so a
   * face is offered only what that person may do (a child's face gets a child's options,
   * PE-17e). The server decides again for every action.
   */
  permissions?: Record<HouseholdPermission, boolean>;
};

/** Whether this person may use a capability (one of its permissions), as far as the tablet knows. */
export const personMay = (person: RosterPerson, permissions: readonly HouseholdPermission[] | null): boolean =>
  !permissions || !person.permissions || permissions.some((permission) => person.permissions![permission]);

/** Whether this person may use a capability under its policy (one-of and all-of permissions, `policyPermits`), as far as the tablet knows. */
export const personMayUse = (person: RosterPerson, policy: Pick<DeviceCapabilityPolicy, 'permissions' | 'permissionsAll'>): boolean =>
  !person.permissions || policyPermits(policy, (permission) => person.permissions![permission] === true);

const ELIGIBLE = new Set(['owner', 'admin', 'member', 'child']);

const nameOf = (data: Record<string, unknown>): string => {
  const raw = typeof data.displayName === 'string' ? data.displayName.trim() : '';
  // An email-valued name is never shown on a tablet (WT-10e).
  if (!raw || raw.includes('@')) return 'Someone';
  return raw.slice(0, 40);
};

export function rosterFrom(docs: ReadonlyArray<{ id: string; data: Record<string, unknown> }>): RosterPerson[] {
  const people: RosterPerson[] = [];
  for (const { id, data } of docs) {
    const role = data.role;
    if (typeof role !== 'string' || !ELIGIBLE.has(role)) continue;
    // A record without `status` is active (as in household-policy, normalizeMember, the rules
    // and the gate); pending, deleting and removed records are not.
    if ((data.status ?? 'active') !== 'active') continue;
    if (id.startsWith('device_')) continue;
    const avatar = typeof data.avatarUrl === 'string' && /^https:\/\//.test(data.avatarUrl) ? data.avatarUrl : null;
    people.push({
      uid: id,
      name: nameOf(data),
      role: role as RosterPerson['role'],
      kind: data.kind === 'identity' ? 'identity' : 'account',
      avatarUrl: avatar,
      permissions: effectivePermissions({
        uid: id, role: role as RosterPerson['role'], status: 'active',
        permissions: data.permissions && typeof data.permissions === 'object' ? data.permissions as PermissionOverrides : {},
      }),
    });
  }
  const rank = (person: RosterPerson) => (person.role === 'child' ? 1 : 0);
  return people.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name) || a.uid.localeCompare(b.uid));
}

export const isOwnerOrAdmin = (person: RosterPerson | null | undefined): boolean =>
  person?.role === 'owner' || person?.role === 'admin';

export const initialsOf = (name: string): string => {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? '') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase() || '?';
};
