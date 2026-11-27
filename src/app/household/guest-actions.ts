'use server';

import { MembershipError, verifyCaller, type MembershipErrorCode } from '@/lib/server/household-membership';
import { createTabletGuestPass } from '@/lib/server/guest-passes';

// Tablet guest passes from the Members tab (audit HO-24, WT-21). Personal sessions only
// (`verifyCaller`); owners and admins by role, checked inside the transaction. Removing
// one early is the normal Remove (`removeMemberAction`).

export type GuestPassActionResult<T> = { ok: true; data: T } | { ok: false; code: MembershipErrorCode; message: string };

export async function createTabletGuestPassAction(input: {
  idToken: string;
  householdId: string;
  name: string;
  hours: number;
  feedPets: boolean;
  tickChores: boolean;
}): Promise<GuestPassActionResult<{ guestId: string; name: string; accessUntil: string }>> {
  try {
    const caller = await verifyCaller(typeof input?.idToken === 'string' ? input.idToken : '');
    return { ok: true, data: await createTabletGuestPass(caller, input) };
  } catch (error) {
    if (error instanceof MembershipError) return { ok: false, code: error.code, message: error.userMessage };
    console.error('Tablet guest pass action failed', error instanceof Error ? error.message : String(error));
    return { ok: false, code: 'failed', message: 'Something went wrong on our side. Please try again in a moment.' };
  }
}
