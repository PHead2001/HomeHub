'use server';

import { adminDb } from '@/lib/server/firebase-admin';
import { MembershipError, verifyCaller } from '@/lib/server/household-membership';
import { CalendarFeedError, disableCalendarFeed, readCalendarFeed, rotateCalendarFeed, type CalendarFeedRefusal } from '@/lib/server/calendar-feed';

// Phone calendar feed (audit CA-25): owners and admins (role), from a personal session
// (`verifyCaller`: a wall tablet's token has no email and is refused). Logic and storage:
// src/lib/server/calendar-feed.ts.

export type CalendarFeedActionResult =
  | { ok: true; data: { token: string | null } }
  | { ok: false; code: CalendarFeedRefusal | 'unauthenticated' | 'failed'; message: string };

type Input = { idToken: string; householdId: string; action: 'read' | 'rotate' | 'disable' };

export async function calendarFeedAction(input: Input): Promise<CalendarFeedActionResult> {
  try {
    const caller = await verifyCaller(typeof input?.idToken === 'string' ? input.idToken : '');
    const householdId = input?.householdId;
    const data = input?.action === 'rotate'
      ? await rotateCalendarFeed(adminDb, caller, householdId)
      : input?.action === 'disable'
        ? await disableCalendarFeed(adminDb, caller, householdId)
        : await readCalendarFeed(adminDb, caller, householdId);
    return { ok: true, data };
  } catch (error) {
    if (error instanceof CalendarFeedError) return { ok: false, code: error.code, message: error.message };
    if (error instanceof MembershipError && error.code === 'unauthenticated') return { ok: false, code: 'unauthenticated', message: error.userMessage };
    console.error('Calendar feed action failed', error instanceof Error ? error.message : String(error));
    return { ok: false, code: 'failed', message: 'Something went wrong on our side. Please try again in a moment.' };
  }
}
