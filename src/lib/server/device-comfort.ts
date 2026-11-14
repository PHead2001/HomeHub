import 'server-only';

import { Timestamp } from 'firebase-admin/firestore';
import { adminDb } from '@/lib/server/firebase-admin';
import { readDeviceSettings, validateDevicePatch } from '@/lib/devices/settings';
import type { DeviceSettings } from '@/lib/devices/types';
import { DeviceActionError, authorizeDeviceAction, deviceRecordRef, householdRefOf } from '@/lib/server/device-gate';

/**
 * Comfort settings from the tablet itself (theme, text size, motion, sound; D-T2,
 * WT-16d, WT-13b): anyone at the tablet, no actor, no PIN. Capability `device.comfort`
 * through the gate; only the four comfort fields are accepted (the same
 * `validateDevicePatch(..., 'comfort')` the Devices list form uses), written as dotted
 * paths inside a transaction that re-runs the gate's checks first. Not logged.
 */
export const updateDeviceComfort = async (
  input: { idToken: unknown; householdId: unknown; comfort: unknown },
  now = new Date(),
  options: { clientAddress?: string } = {},
): Promise<{ changed: string[]; settings: DeviceSettings }> => {
  const authority = await authorizeDeviceAction({
    idToken: input?.idToken as string,
    householdId: input?.householdId as string,
    capability: 'device.comfort',
  }, now, { clientAddress: options.clientAddress });
  const recordRef = deviceRecordRef(householdRefOf(authority.householdId), authority.deviceId);
  return adminDb.runTransaction(async tx => {
    await authority.hooks.precheck(tx);
    const record = await tx.get(recordRef);
    const result = validateDevicePatch({ comfort: input?.comfort }, readDeviceSettings(record.data()), 'comfort');
    if (!result.ok) throw new DeviceActionError('invalid_input');
    if (result.changed.length === 0) return { changed: [], settings: result.next };
    tx.update(recordRef, { ...result.updates, updatedAt: Timestamp.fromDate(now), updatedVia: 'tablet-comfort' });
    authority.hooks.finalize(tx, { targetPath: recordRef.path, summary: { changed: result.changed } });
    return { changed: result.changed, settings: result.next };
  });
};
