import type { HouseholdPermission, HouseholdRole, PermissionOverrides } from '@/lib/types';
import { getEffectivePermissions } from '@/lib/permissions';
import { HomeHubAiError } from '@/ai/errors';

export type ResolvedHouseholdAuthority = {
  role: HouseholdRole;
  permissions: Record<HouseholdPermission, boolean>;
};

export const resolveHouseholdAuthority = ({
  uid,
  email,
  household,
  member,
}: {
  uid: string;
  email: string;
  household: Record<string, unknown>;
  member?: Record<string, unknown>;
}): ResolvedHouseholdAuthority => {
  const memberEmails = Array.isArray(household.memberEmails) ? household.memberEmails : [];
  if (!member && !memberEmails.includes(email)) throw new HomeHubAiError('forbidden');
  if (member?.status === 'pending' || member?.role === 'newuser') throw new HomeHubAiError('forbidden');

  const ownerEvidence = household.ownerUid === uid || household.ownerEmail === email;
  const role: HouseholdRole = member
    ? (member.role as HouseholdRole)
    : ownerEvidence ? 'owner' : 'member';
  const permissions = getEffectivePermissions(
    role,
    member ? (member.permissions || {}) as PermissionOverrides : {}
  );
  return { role, permissions };
};
