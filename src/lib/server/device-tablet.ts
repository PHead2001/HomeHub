import 'server-only';

import { Timestamp } from 'firebase-admin/firestore';
import { adminDb } from '@/lib/server/firebase-admin';
import { readDeviceSettings, validateDevicePatch } from '@/lib/devices/settings';
import type { DeviceSettings } from '@/lib/devices/types';
import { notificationAudience } from '@functions/shared/notification-audience';
import { DeviceActionError, authorizeDeviceAction, deviceRecordRef, householdRefOf } from '@/lib/server/device-gate';
import { codeIsLive, isDeviceAdmin } from '@/lib/server/device-management';
import { finishDeviceRevocation } from '@/lib/server/device-identity';
import { writeDeviceAudit } from '@/lib/server/device-audit';

// Admin-PIN actions on the tablet itself (docs/modules/devices/README.md, "Protected
// exit and Tablet settings"; design 4.2, 14.6, WT-16, D-T5, S9). Each runs through the
// device gate with an owner or admin (role) and a FRESH PIN session (`admin-pin`,
// at most 30 s old), and re-runs every check inside its own transaction (`precheck`).
// They write their own activity entry (`device.settings_changed`, `device.removed`,
// `device.exited`, via 'device', "as Alex (PIN) on Kitchen tablet") instead of the
// generic `device.action`, so `finalize` is not called (no op ledger: admin-PIN
// capabilities carry no opId).

/** Room, name, sections, start page and every other record setting, from the tablet. */
export const updateDeviceSettingsFromTablet = async (
  input: { idToken: unknown; householdId: unknown; actorUid: unknown; pinSessionId: unknown; patch: unknown },
  options: { clientAddress?: string; clock?: () => Date } = {},
): Promise<{ changed: string[]; settings: DeviceSettings }> => {
  const authority = await authorizeDeviceAction({
    idToken: input?.idToken as string,
    householdId: input?.householdId as string,
    capability: 'device.settings',
    actorUid: input?.actorUid as string,
    pinSessionId: input?.pinSessionId as string,
  }, { clientAddress: options.clientAddress, clock: options.clock });
  const householdRef = householdRefOf(authority.householdId);
  const recordRef = deviceRecordRef(householdRef, authority.deviceId);
  return adminDb.runTransaction(async tx => {
    await authority.hooks.precheck(tx);
    // The server clock the precheck just used (re-read on every transaction attempt).
    const now = authority.now;
    const record = await tx.get(recordRef);
    const result = validateDevicePatch(input?.patch, readDeviceSettings(record.data()), 'admin');
    if (!result.ok) throw new DeviceActionError('invalid_input');
    if (result.changed.length === 0) return { changed: [], settings: result.next };
    const actor = authority.actor!;
    tx.update(recordRef, {
      ...result.updates,
      updatedAt: Timestamp.fromDate(now),
      updatedByUid: actor.uid,
      updatedVia: 'tablet-admin-pin',
    });
    const adminFields = result.changed.filter(field => field !== 'comfort');
    if (adminFields.length > 0) {
      writeDeviceAudit(tx, householdRef, {
        action: 'device.settings_changed', actorUid: actor.uid, actorName: actor.name, via: 'device',
        deviceId: authority.deviceId, deviceName: result.next.name, level: 'pin', details: { fields: adminFields.join(', ') },
      }, now);
    }
    return { changed: result.changed, settings: result.next };
  });
};

export type TabletExit = 'remove' | 'personal-sign-in' | 'new-code';

const EXIT_CAPABILITY = {
  remove: 'device.exit.remove',
  'personal-sign-in': 'device.exit.personal',
  'new-code': 'device.exit.newCode',
} as const;

const NOTIFICATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The protected exit (WT-16a-c, D-T5): "Remove this tablet" (`status: 'removed'`, never
 * re-pairable), "Sign in with a personal account" and "Use a different code"
 * (`status: 'unpaired'`, record kept, needs a re-pair). One transaction: the gate's
 * precheck, then the record's generation bump (every request with the old credential is
 * refused at once, PIN sessions included), the tablet's unused codes revoked, the
 * activity entry and one notification per active owner and admin (WT-16f). After the
 * commit the credential is ended (refresh tokens revoked, the Auth user deleted or
 * disabled); a failure there is reported as `authCleanup: 'pending'` and finished by a
 * retry, the Devices list or the daily sweep. Nobody's account is touched.
 */
/**
 * The owners' notice when "Use a different code" kept a re-pair code (D8, final review N2):
 * that code still works until it expires, so nobody reads the notice as "nothing can pair now".
 */
export const keptCodeNotice = (expiresAtMs: number, timeZone: string): string => {
  const time = expiresAtMs > 0
    ? new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', timeZone }).format(new Date(expiresAtMs))
    : null;
  return `The re-pair code made for it still works${time ? ` until ${time}` : ' until it expires'}. Cancel it in Devices if you didn't expect this.`;
};

export const exitTablet = async (
  input: { idToken: unknown; householdId: unknown; actorUid: unknown; pinSessionId: unknown; exit: unknown },
  options: { clientAddress?: string; clock?: () => Date } = {},
): Promise<{ status: 'removed' | 'unpaired'; authCleanup: 'done' | 'pending' }> => {
  const exit = input?.exit;
  if (exit !== 'remove' && exit !== 'personal-sign-in' && exit !== 'new-code') throw new DeviceActionError('invalid_input');
  const authority = await authorizeDeviceAction({
    idToken: input?.idToken as string,
    householdId: input?.householdId as string,
    capability: EXIT_CAPABILITY[exit],
    actorUid: input?.actorUid as string,
    pinSessionId: input?.pinSessionId as string,
  }, { clientAddress: options.clientAddress, clock: options.clock });
  const householdRef = householdRefOf(authority.householdId);
  const recordRef = deviceRecordRef(householdRef, authority.deviceId);
  const status = exit === 'remove' ? 'removed' as const : 'unpaired' as const;
  const committed = await adminDb.runTransaction(async tx => {
    await authority.hooks.precheck(tx);
    const now = authority.now;
    const [record, codes, admins] = await Promise.all([
      tx.get(recordRef),
      tx.get(adminDb.collection('deviceCodes').where('householdId', '==', householdRef.id)),
      tx.get(householdRef.collection('members').where('role', 'in', ['owner', 'admin'])),
    ]);
    const actor = authority.actor!;
    const settings = readDeviceSettings(record.data());
    const generation = (record.get('generation') as number) + 1;
    const stamp = Timestamp.fromDate(now);
    tx.update(recordRef, {
      status,
      generation,
      removedAt: stamp,
      removedByUid: actor.uid,
      endedReason: exit === 'remove' ? 'removed' : exit,
    });
    const previous = record.get('generation') as number;
    // The latest expiry of a re-pair code kept for the person to type (D8), for the owners' notice.
    let keptUntil: number | null = null;
    for (const code of codes.docs) {
      if (code.get('deviceId') === authority.deviceId && codeIsLive(code, now)) {
        // "Use a different code" (emulator evidence D8): an owner's or admin's live re-pair code
        // made for this record at the generation being ended is the code the person is about to
        // type, so it moves to the new generation instead of being cancelled. The old credential
        // is still refused (the generation moves on here, and again when the code is redeemed).
        // Every other code, and every code on Remove or a personal sign-in, is cancelled.
        if (exit === 'new-code' && code.get('kind') === 'repair' && code.get('targetGeneration') === previous) {
          tx.update(code.ref, { targetGeneration: generation, carriedFromGeneration: previous, carriedAt: stamp });
          const expires = code.get('expiresAt');
          const at = expires instanceof Timestamp ? expires.toMillis() : 0;
          keptUntil = Math.max(keptUntil ?? 0, at);
        } else {
          tx.update(code.ref, { revokedAt: stamp, revokedByUid: actor.uid, revokedReason: 'superseded' });
        }
      }
    }
    writeDeviceAudit(tx, householdRef, {
      action: exit === 'remove' ? 'device.removed' : 'device.exited', actorUid: actor.uid, actorName: actor.name, via: 'device',
      deviceId: authority.deviceId, deviceName: settings.name, level: 'pin',
      // `codeKept` (never the code): a re-pair code for this tablet still works (final review N2).
      details: { reason: exit, name: settings.name, room: settings.room, generation, ...(keptUntil !== null ? { codeKept: true } : {}) },
    }, now);
    const reasonText = exit === 'remove'
      ? 'was removed on the tablet'
      : exit === 'personal-sign-in' ? 'was switched to a personal sign-in on the tablet' : 'was signed out on the tablet to use a different code';
    for (const admin of admins.docs.filter(d => isDeviceAdmin(d.data()))) {
      tx.set(householdRef.collection('notifications').doc(`device-removed-${authority.deviceId}-${generation}-${admin.id}`), {
        householdId: householdRef.id,
        category: 'system',
        title: exit === 'remove' ? 'Wall tablet removed' : 'Wall tablet signed out',
        message: `${settings.name}${settings.room ? ` (${settings.room})` : ''} ${reasonText} by ${actor.name}.${exit === 'remove' ? '' : keptUntil !== null ? ` ${keptCodeNotice(keptUntil, authority.timeZone)}` : ' Re-pair it from Devices to use it again.'}`,
        createdAt: stamp,
        expiresAt: Timestamp.fromMillis(now.getTime() + NOTIFICATION_TTL_MS),
        deepLink: '/household?tab=devices',
        sourceType: 'device-removed',
        sourceId: authority.deviceId,
        stateKey: String(generation),
        targetUserUid: admin.id,
        audience: notificationAudience({ targetUserUid: admin.id }),
        readBy: {},
        dismissedBy: {},
      });
    }
    return { generation };
  });
  const cleanup = await finishDeviceRevocation(authority.deviceId, { status, generation: committed.generation });
  return { status, authCleanup: cleanup.ok ? 'done' : 'pending' };
};
