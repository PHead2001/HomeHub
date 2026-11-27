import type { HouseholdPermission, HouseholdRole, PermissionOverrides } from '@/lib/types';
import { getEffectivePermissions } from '@/lib/permissions';
import { HomeHubAiError } from '@/ai/errors';
import { memberIsCurrent } from '@/lib/guest-pass';

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
  // Active and not on a guest pass that has ended (HO-14): `memberIsCurrent`.
  if (!approvedRoles.includes(role) || !memberIsCurrent(member)) throw new HomeHubAiError('forbidden');

  const permissions = getEffectivePermissions(role, (member.permissions || {}) as PermissionOverrides);
  return { role, permissions };
};
