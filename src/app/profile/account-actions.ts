'use server';

import { MembershipError, verifyCaller } from '@/lib/server/household-membership';
import { exportMyData, type MyDataExport } from '@/lib/server/my-account';

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
