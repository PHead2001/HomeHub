import 'server-only';

import { Timestamp } from 'firebase-admin/firestore';
import { adminDb } from '@/lib/server/firebase-admin';
import { devicesEnabled } from '@/lib/server/device-identity';
import { writeDeviceAudit } from '@/lib/server/device-audit';
import { describeQuietHours, readQuietHours, validateQuietHours, type QuietHours } from '@/lib/devices/quiet-hours';
import type { VerifiedCaller } from '@/lib/server/household-membership';

// Household quiet hours (docs/modules/devices/README.md, "Night dimming"; design 14.4,
// D-T1, JC-20): `households/{h}.quietHours = { start, end, updatedAt, updatedByUid }` or
// null, in the household's time zone. Registered wall tablets dim during them. Set only
// here, by an active owner or admin (role), in one transaction that re-reads the household
// and the caller's membership; clients cannot write it (the household update rule allows
// only `timeZone` and `updatedAt`). Ships with the devices flag.

export type QuietHoursRefusal = 'unavailable' | 'invalid_input' | 'not_found' | 'household_deleting' | 'not_member' | 'forbidden';

export class QuietHoursError extends Error {
  constructor(readonly code: QuietHoursRefusal, message: string) {
    super(message);
  }
}

const memberName = (data: FirebaseFirestore.DocumentData | undefined): string | null =>
  typeof data?.displayName === 'string' && data.displayName.trim() && !data.displayName.includes('@') ? data.displayName.trim() : null;

export const updateQuietHours = async (
  caller: VerifiedCaller,
  input: { householdId: unknown; quietHours: unknown },
  now = new Date(),
): Promise<{ quietHours: QuietHours | null; changed: boolean }> => {
  if (!devicesEnabled()) throw new QuietHoursError('unavailable', "Wall tablets aren't available yet.");
  const id = input?.householdId;
  if (typeof id !== 'string' || !id || id.length > 200 || id.includes('/')) throw new QuietHoursError('not_found', 'That household no longer exists.');
  const checked = validateQuietHours(input?.quietHours);
  if (!checked.ok) throw new QuietHoursError('invalid_input', checked.message);
  const householdRef = adminDb.collection('households').doc(id);
  return adminDb.runTransaction(async tx => {
    const [household, member] = await Promise.all([tx.get(householdRef), tx.get(householdRef.collection('members').doc(caller.uid))]);
    if (!household.exists) throw new QuietHoursError('not_found', 'That household no longer exists.');
    if (household.get('deletingAt')) throw new QuietHoursError('household_deleting', 'This household is being deleted.');
    const data = member.data();
    if (!member.exists || (data?.status ?? 'active') !== 'active' || data?.role === 'newuser') throw new QuietHoursError('not_member', 'You are not part of this household.');
    if (data?.role !== 'owner' && data?.role !== 'admin') throw new QuietHoursError('forbidden', 'Only owners and admins can change quiet hours.');
    const previous = readQuietHours(household.get('quietHours'));
    const next = checked.value;
    if (previous?.start === next?.start && previous?.end === next?.end) return { quietHours: next, changed: false };
    tx.update(householdRef, {
      quietHours: next ? { start: next.start, end: next.end, updatedAt: Timestamp.fromDate(now), updatedByUid: caller.uid } : null,
    });
    writeDeviceAudit(tx, householdRef, {
      action: 'device.quiet_hours_changed', actorUid: caller.uid, actorName: memberName(data), via: 'devices-list',
      details: { quietHours: describeQuietHours(next), previous: describeQuietHours(previous) },
    }, now);
    return { quietHours: next, changed: true };
  });
};
