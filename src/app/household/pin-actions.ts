'use server';

import { MembershipError, verifyCaller } from '@/lib/server/household-membership';
import {
  PinError,
  clearChildPin,
  clearMemberPin,
  clearPinLockout,
  pinStatuses,
  setChildPin,
  setMyPin,
  updatePointsPinPolicy,
  type PinRefusal,
  type PinStatus,
} from '@/lib/server/pins';
import type { PointsPinPolicy } from '@/lib/devices/action-policy';

// Tablet PIN management from personal sessions (docs/modules/devices/README.md, "PINs").
// Every action authenticates with `verifyCaller` (a verified ID token with an email),
// so a tablet's token is refused: nothing PIN-related can be done from a tablet. The
// authority matrix (WT-17) is enforced in src/lib/server/pins.ts inside each
// transaction. No result ever carries PIN material.

export type PinActionResult<T> = { ok: true; data: T } | { ok: false; code: PinRefusal; message: string };

const FAILED = 'Something went wrong on our side. Please try again in a moment.';

const run = async <T>(idToken: unknown, work: (caller: Awaited<ReturnType<typeof verifyCaller>>) => Promise<T>): Promise<PinActionResult<T>> => {
  try {
    const caller = await verifyCaller(typeof idToken === 'string' ? idToken : '');
    return { ok: true, data: await work(caller) };
  } catch (error) {
    if (error instanceof PinError) return { ok: false, code: error.code, message: error.message };
    if (error instanceof MembershipError && error.code === 'unauthenticated') return { ok: false, code: 'unauthenticated', message: error.userMessage };
    console.error('PIN action failed', error instanceof Error ? error.message : String(error));
    return { ok: false, code: 'failed', message: FAILED };
  }
};

/** Set or change your own tablet PIN (from your own signed-in session). */
export async function setMyPinAction(input: { idToken: string; householdId: string; pin: string }): Promise<PinActionResult<{ set: boolean }>> {
  return run(input?.idToken, caller => setMyPin(caller, input));
}

/** Clear your own PIN, or (owner/admin) the PIN of someone with a lower role. */
export async function clearMemberPinAction(input: { idToken: string; householdId: string; targetUid: string }): Promise<PinActionResult<{ cleared: boolean }>> {
  return run(input?.idToken, caller => clearMemberPin(caller, input));
}

/** Set a kid profile's PIN (owner/admin). */
export async function setChildPinAction(input: { idToken: string; householdId: string; childId: string; pin: string }): Promise<PinActionResult<{ set: boolean }>> {
  return run(input?.idToken, caller => setChildPin(caller, input));
}

/** Clear a kid profile's PIN (owner/admin). */
export async function clearChildPinAction(input: { idToken: string; householdId: string; childId: string }): Promise<PinActionResult<{ cleared: boolean }>> {
  return run(input?.idToken, caller => clearChildPin(caller, input));
}

/** Unlock a PIN after too many wrong tries: yourself, or an owner/admin above the person's role. */
export async function clearPinLockoutAction(input: { idToken: string; householdId: string; targetUid: string }): Promise<PinActionResult<{ cleared: boolean }>> {
  return run(input?.idToken, caller => clearPinLockout(caller, input));
}

/** Who has a PIN and whose is locked (owners and admins: everyone; others: themselves). */
export async function pinStatusAction(input: { idToken: string; householdId: string }): Promise<PinActionResult<Record<string, PinStatus>>> {
  return run(input?.idToken, caller => pinStatuses(caller, input));
}

/** The household's points-PIN setting for wall tablets (owners and admins). */
export async function updatePointsPinAction(input: { idToken: string; householdId: string; pointsPin: PointsPinPolicy }): Promise<PinActionResult<{ pointsPin: PointsPinPolicy }>> {
  return run(input?.idToken, caller => updatePointsPinPolicy(caller, input));
}
