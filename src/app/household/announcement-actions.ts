'use server';

import { MembershipError, verifyCaller } from '@/lib/server/household-membership';
import { HouseAnnouncementError, postHouseAnnouncement, type HouseAnnouncementRefusal } from '@/lib/server/house-announcements';

// "Message the house" (NO-25): owners and admins (role), from a personal session
// (`verifyCaller`: a wall tablet's token is refused).

export type HouseAnnouncementActionResult =
  | { ok: true; data: { id: string; expiresAt: string } }
  | { ok: false; code: HouseAnnouncementRefusal | 'unauthenticated' | 'failed'; message: string };

export async function postHouseAnnouncementAction(input: { idToken: string; householdId: string; message: string; hours: number; push: boolean }): Promise<HouseAnnouncementActionResult> {
  try {
    const caller = await verifyCaller(typeof input?.idToken === 'string' ? input.idToken : '');
    return { ok: true, data: await postHouseAnnouncement(caller, { householdId: input?.householdId, message: input?.message, hours: input?.hours, push: input?.push }) };
  } catch (error) {
    if (error instanceof HouseAnnouncementError) return { ok: false, code: error.code, message: error.message };
    if (error instanceof MembershipError && error.code === 'unauthenticated') return { ok: false, code: 'unauthenticated', message: error.userMessage };
    console.error('House message failed', error instanceof Error ? error.message : String(error));
    return { ok: false, code: 'failed', message: 'Something went wrong on our side. Please try again in a moment.' };
  }
}
