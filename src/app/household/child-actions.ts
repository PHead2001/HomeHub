'use server';

import { MembershipError, verifyCaller, type MembershipErrorCode } from '@/lib/server/household-membership';
import { createChildIdentity, removeChildIdentity, updateChildIdentity } from '@/lib/server/child-identities';

// Kid profiles (child identities) from the Members tab (docs/modules/devices/README.md,
// "Actors"). Personal sessions only (`verifyCaller`); owners and admins by role,
// checked inside each transaction.

export type ChildActionResult<T> = { ok: true; data: T } | { ok: false; code: MembershipErrorCode; message: string };

const FAILED = 'Something went wrong on our side. Please try again in a moment.';

const run = async <T>(idToken: unknown, work: (caller: Awaited<ReturnType<typeof verifyCaller>>) => Promise<T>): Promise<ChildActionResult<T>> => {
  try {
    const caller = await verifyCaller(typeof idToken === 'string' ? idToken : '');
    return { ok: true, data: await work(caller) };
  } catch (error) {
    if (error instanceof MembershipError) return { ok: false, code: error.code, message: error.userMessage };
    console.error('Kid profile action failed', error instanceof Error ? error.message : String(error));
    return { ok: false, code: 'failed', message: FAILED };
  }
};

export async function createChildIdentityAction(input: { idToken: string; householdId: string; name: string }): Promise<ChildActionResult<{ childId: string; name: string }>> {
  return run(input?.idToken, caller => createChildIdentity(caller, input));
}

export async function updateChildIdentityAction(input: {
  idToken: string; householdId: string; childId: string; name?: string; avatarUrl?: string | null;
}): Promise<ChildActionResult<{ changed: string[] }>> {
  return run(input?.idToken, caller => updateChildIdentity(caller, input));
}

export async function removeChildIdentityAction(input: { idToken: string; householdId: string; childId: string }): Promise<ChildActionResult<{ removed: boolean }>> {
  return run(input?.idToken, caller => removeChildIdentity(caller, input));
}
