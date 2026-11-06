import type { HouseholdPermission, HouseholdRole, PermissionOverrides } from '@/lib/types';
import { getEffectivePermissions } from '@/lib/permissions';
import { HomeHubAiError } from '@/ai/errors';

export type ResolvedHouseholdAuthority = {
  role: HouseholdRole;
  permissions: Record<HouseholdPermission, boolean>;
};

const approvedRoles: HouseholdRole[] = ['owner', 'admin', 'member', 'child', 'guest'];

// Mirrors firestore.rules: households/{id}/members/{uid} is the only authority.
// Legacy household fields (memberEmails, ownerEmail, ownerUid) never grant access.
export const resolveHouseholdAuthority = ({
  uid,
  member,
}: {
  uid: string;
  member?: Record<string, unknown>;
}): ResolvedHouseholdAuthority => {
  if (!member) throw new HomeHubAiError('forbidden');
  if (typeof member.uid === 'string' && member.uid !== uid) throw new HomeHubAiError('forbidden');

  const role = member.role as HouseholdRole;
  const status = typeof member.status === 'string' ? member.status : 'active';
  if (!approvedRoles.includes(role) || status !== 'active') throw new HomeHubAiError('forbidden');

  const permissions = getEffectivePermissions(role, (member.permissions || {}) as PermissionOverrides);
  return { role, permissions };
};
