'use server';

import {
  MembershipError,
  deleteHousehold,
  leaveHousehold,
  redeemInvite,
  verifyCaller,
  type JoinResult,
} from '@/lib/server/household-membership';

export type MembershipActionResult<T> = { ok: true; data: T } | { ok: false; message: string };

const failure = (error: unknown): { ok: false; message: string } => {
  if (error instanceof MembershipError) return { ok: false, message: error.userMessage };
  console.error('Household membership action failed', error);
  return { ok: false, message: 'Something went wrong on our side. Please try again in a moment.' };
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
