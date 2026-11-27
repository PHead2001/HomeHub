import 'server-only';

import { Timestamp } from 'firebase-admin/firestore';
import { adminDb } from '@/lib/server/firebase-admin';
import { notificationAudience } from '@functions/shared/notification-audience';
import { publicDisplayName } from '@/lib/member-directory';
import type { VerifiedCaller } from '@/lib/server/household-membership';
import { HOUSE_ANNOUNCEMENT_SOURCE_TYPE, validateHouseAnnouncement } from '@/lib/house-announcements';

// "Message the house" (NO-25; docs/modules/notifications/README.md). Only an active owner or
// admin (by role) may post, checked here in one transaction that re-reads the household and
// the caller's membership; the notification is written with the Admin SDK (only this path
// adds the server-only `silent` field and the activity entry). Household-wide, so the
// message carries the poster's public name only, never an email.

export type HouseAnnouncementRefusal = 'invalid_input' | 'not_found' | 'household_deleting' | 'not_member' | 'forbidden';

export class HouseAnnouncementError extends Error {
  constructor(readonly code: HouseAnnouncementRefusal, message: string) {
    super(message);
  }
}

export const postHouseAnnouncement = async (
  caller: VerifiedCaller,
  input: { householdId: unknown; message: unknown; hours: unknown; push: unknown },
  now = new Date(),
): Promise<{ id: string; expiresAt: string }> => {
  const id = input?.householdId;
  if (typeof id !== 'string' || !id || id.length > 200 || id.includes('/')) throw new HouseAnnouncementError('not_found', 'That household no longer exists.');
  const checked = validateHouseAnnouncement({ message: input?.message, hours: input?.hours, push: input?.push });
  if (!checked.ok) throw new HouseAnnouncementError('invalid_input', checked.message);
  const householdRef = adminDb.collection('households').doc(id);
  return adminDb.runTransaction(async (tx) => {
    const [household, member] = await Promise.all([tx.get(householdRef), tx.get(householdRef.collection('members').doc(caller.uid))]);
    if (!household.exists) throw new HouseAnnouncementError('not_found', 'That household no longer exists.');
    if (household.get('deletingAt')) throw new HouseAnnouncementError('household_deleting', 'This household is being deleted.');
    const data = member.data();
    if (!member.exists || (data?.status ?? 'active') !== 'active' || data?.role === 'newuser' || data?.kind === 'identity') {
      throw new HouseAnnouncementError('not_member', 'You are not part of this household.');
    }
    if (data?.role !== 'owner' && data?.role !== 'admin') throw new HouseAnnouncementError('forbidden', 'Only owners and admins can message the house.');
    const name = publicDisplayName(typeof data?.displayName === 'string' ? data.displayName : caller.displayName, '');
    const expiresAt = new Date(now.getTime() + checked.value.hours * 60 * 60 * 1000);
    const ref = householdRef.collection('notifications').doc(`${HOUSE_ANNOUNCEMENT_SOURCE_TYPE}-${now.getTime()}-${caller.uid}`);
    tx.set(ref, {
      householdId: id,
      category: 'general',
      title: name ? `House message from ${name}` : 'House message',
      message: checked.value.message,
      createdAt: Timestamp.fromDate(now),
      firstCreatedAt: Timestamp.fromDate(now),
      expiresAt: Timestamp.fromDate(expiresAt),
      sourceType: HOUSE_ANNOUNCEMENT_SOURCE_TYPE,
      sourceId: caller.uid,
      // The poster is never pushed about their own message (NO-11).
      createdByUid: caller.uid,
      audience: notificationAudience({}),
      readBy: {},
      dismissedBy: {},
      // Shown everywhere; pushed to phones only when asked (held during household quiet hours).
      ...(checked.value.push ? {} : { silent: true }),
    });
    tx.set(householdRef.collection('auditLogs').doc(), {
      actorUid: caller.uid,
      actorName: name || null,
      action: 'household.message_posted',
      createdAt: now.toISOString(),
      details: { hours: checked.value.hours, push: checked.value.push },
    });
    return { id: ref.id, expiresAt: expiresAt.toISOString() };
  });
};
