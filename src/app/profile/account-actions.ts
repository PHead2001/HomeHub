'use server';

import { MembershipError, verifyCaller } from '@/lib/server/household-membership';
import { deleteMyAccount, exportMyData, verifyRecentCaller, type AccountDeletion, type MyDataExport } from '@/lib/server/my-account';
import { DELETE_CONFIRMATION } from '@/lib/profile/account-data';

export type AccountActionResult<T> = { ok: true; data: T } | { ok: false; message: string };

/** PR-26: the signed-in person's own data as JSON (identity from the verified ID token only). */
export async function exportMyDataAction(input: { idToken: string }): Promise<AccountActionResult<MyDataExport>> {
  try {
    const caller = await verifyCaller(input?.idToken);
    const data = await exportMyData(caller);
    return { ok: true, data: JSON.parse(JSON.stringify(data)) as MyDataExport };
  } catch (error) {
    if (error instanceof MembershipError) return { ok: false, message: error.userMessage };
    console.error('Data export failed', error instanceof Error ? error.message : String(error));
    return { ok: false, message: 'Something went wrong on our side. Please try again in a moment.' };
  }
}

/**
 * PR-26: deletes the signed-in person's account. Needs a sign-in within the last five
 * minutes (checked on the server) and the typed confirmation; refused for an owner.
 */
export async function deleteMyAccountAction(input: { idToken: string; confirm: string }): Promise<AccountActionResult<AccountDeletion>> {
  try {
    if (input?.confirm !== DELETE_CONFIRMATION) return { ok: false, message: `Type ${DELETE_CONFIRMATION} to confirm.` };
    const caller = await verifyRecentCaller(input?.idToken);
    return { ok: true, data: await deleteMyAccount(caller) };
  } catch (error) {
    if (error instanceof MembershipError) return { ok: false, message: error.userMessage };
    console.error('Account deletion failed', error instanceof Error ? error.message : String(error));
    return { ok: false, message: 'Something went wrong on our side. Part of your account may already be removed; try again to finish.' };
  }
}
