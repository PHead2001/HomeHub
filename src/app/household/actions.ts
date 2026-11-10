'use server';

import {
  MembershipError,
  changeMemberRole,
  createHousehold,
  createInvite,
  deleteHousehold,
  leaveHousehold,
  redeemInvite,
  remindPendingMembers,
  removeMember,
  renameHousehold,
  revokeAllInvites,
  revokeInvite,
  transferOwnership,
  updateMemberPermissions,
  verifyCaller,
  type JoinResult,
  type MembershipErrorCode,
  type VerifiedCaller,
} from '@/lib/server/household-membership';
import type { HouseholdRole, InviteCode, PermissionOverrides } from '@/lib/types';

export type MembershipActionResult<T> = { ok: true; data: T } | { ok: false; message: string };

/**
 * Result of a household management action. `code` says why it was refused (a
 * policy reason from `src/lib/household-policy.ts` or a general one); `message`
 * is plain language and safe to show.
 */
export type HouseholdActionResult<T> = { ok: true; data: T } | { ok: false; code: MembershipErrorCode; message: string };

const failure = (error: unknown): { ok: false; code: MembershipErrorCode; message: string } => {
  if (error instanceof MembershipError) return { ok: false, code: error.code, message: error.userMessage };
  console.error('Household membership action failed', error);
  return { ok: false, code: 'failed', message: 'Something went wrong on our side. Please try again in a moment.' };
};

export async function joinHouseholdWithInvite(input: { idToken: string; code: string }): Promise<MembershipActionResult<JoinResult>> {
  try {
    const caller = await verifyCaller(input.idToken);
    const result = await redeemInvite(caller, input.code);
    // Plain JSON for the client boundary.
    return { ok: true, data: JSON.parse(JSON.stringify(result)) as JoinResult };
  } catch (error) {
    return failure(error);
  }
}

export async function leaveHouseholdAction(input: { idToken: string; householdId: string }): Promise<MembershipActionResult<null>> {
  try {
    const caller = await verifyCaller(input.idToken);
    await leaveHousehold(caller, input.householdId);
    return { ok: true, data: null };
  } catch (error) {
    return failure(error);
  }
}

export async function deleteHouseholdAction(input: { idToken: string; householdId: string; confirmName: string }): Promise<MembershipActionResult<null>> {
  try {
    const caller = await verifyCaller(input.idToken);
    await deleteHousehold(caller, input.householdId, input.confirmName);
    return { ok: true, data: null };
  } catch (error) {
    return failure(error);
  }
}

// Household management. The caller is whoever the ID token proves; the policy is
// applied on the server inside the transaction that performs the change.
const manage = async <T>(idToken: string, run: (caller: VerifiedCaller) => Promise<T>): Promise<HouseholdActionResult<T>> => {
  try {
    const caller = await verifyCaller(idToken);
    return { ok: true, data: await run(caller) };
  } catch (error) {
    return failure(error);
  }
};

/**
 * Creates a household owned by the caller (household, owner membership, profile
 * pointer and `household.created` activity entry in one transaction).
 */
export async function createHouseholdAction(input: { idToken: string; name: string; timeZone?: string }): Promise<HouseholdActionResult<JoinResult>> {
  return manage(input?.idToken, async caller => {
    const result = await createHousehold(caller, { name: input?.name, timeZone: input?.timeZone });
    // Plain JSON for the client boundary.
    return JSON.parse(JSON.stringify(result)) as JoinResult;
  });
}

export async function renameHouseholdAction(input: { idToken: string; householdId: string; name: string }): Promise<HouseholdActionResult<{ name: string }>> {
  return manage(input?.idToken, caller => renameHousehold(caller, input.householdId, input.name));
}

export async function createInviteAction(input: { idToken: string; householdId: string }): Promise<HouseholdActionResult<InviteCode>> {
  return manage(input?.idToken, caller => createInvite(caller, input.householdId));
}

export async function revokeInviteAction(input: { idToken: string; householdId: string; code: string }): Promise<HouseholdActionResult<{ code: string }>> {
  return manage(input?.idToken, caller => revokeInvite(caller, input.householdId, input.code));
}

export async function revokeAllInvitesAction(input: { idToken: string; householdId: string }): Promise<HouseholdActionResult<{ count: number }>> {
  return manage(input?.idToken, caller => revokeAllInvites(caller, input.householdId));
}

/** The daily reminder about pending people; returns how many were due. */
export async function remindPendingMembersAction(input: { idToken: string; householdId: string }): Promise<HouseholdActionResult<{ count: number }>> {
  return manage(input?.idToken, caller => remindPendingMembers(caller, input.householdId));
}

/** Approves a pending person or changes a member's role. */
export async function changeMemberRoleAction(input: { idToken: string; householdId: string; memberUid: string; role: HouseholdRole }): Promise<HouseholdActionResult<{ role: HouseholdRole; approved: boolean }>> {
  return manage(input?.idToken, caller => changeMemberRole(caller, input.householdId, input.memberUid, input.role));
}

export async function updateMemberPermissionsAction(input: {
  idToken: string;
  householdId: string;
  memberUid: string;
  overrides: PermissionOverrides;
  /** The role the editor was showing; a role change in between refuses the save. */
  expectedRole?: HouseholdRole;
}): Promise<HouseholdActionResult<{ permissions: PermissionOverrides }>> {
  return manage(input?.idToken, caller => updateMemberPermissions(caller, input.householdId, input.memberUid, input.overrides, input.expectedRole));
}

export async function removeMemberAction(input: { idToken: string; householdId: string; memberUid: string }): Promise<HouseholdActionResult<{ denied: boolean }>> {
  return manage(input?.idToken, caller => removeMember(caller, input.householdId, input.memberUid));
}

export async function transferOwnershipAction(input: { idToken: string; householdId: string; memberUid: string }): Promise<HouseholdActionResult<{ ownerUid: string }>> {
  return manage(input?.idToken, caller => transferOwnership(caller, input.householdId, input.memberUid));
}
