'use server';

import { MembershipError, verifyCaller } from '@/lib/server/household-membership';
import { QuietHoursError, updateQuietHours, type QuietHoursRefusal } from '@/lib/server/quiet-hours';
import type { QuietHours } from '@/lib/devices/quiet-hours';

// Household quiet hours (docs/modules/devices/README.md, "Night dimming"): owners and
// admins (role), from a personal session (`verifyCaller`: a tablet token is refused).

export type QuietHoursActionResult =
  | { ok: true; data: { quietHours: QuietHours | null; changed: boolean } }
  | { ok: false; code: QuietHoursRefusal | 'unauthenticated' | 'failed'; message: string };

export async function updateQuietHoursAction(input: { idToken: string; householdId: string; quietHours: QuietHours | null }): Promise<QuietHoursActionResult> {
  try {
    const caller = await verifyCaller(typeof input?.idToken === 'string' ? input.idToken : '');
    return { ok: true, data: await updateQuietHours(caller, { householdId: input?.householdId, quietHours: input?.quietHours }) };
  } catch (error) {
    if (error instanceof QuietHoursError) return { ok: false, code: error.code, message: error.message };
    if (error instanceof MembershipError && error.code === 'unauthenticated') return { ok: false, code: 'unauthenticated', message: error.userMessage };
    console.error('Quiet hours update failed', error instanceof Error ? error.message : String(error));
    return { ok: false, code: 'failed', message: 'Something went wrong on our side. Please try again in a moment.' };
  }
}
