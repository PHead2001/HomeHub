import 'server-only';

// Activity-log entries for registered tablets (docs/modules/devices/README.md,
// "Activity log"). Shape-compatible with the household entries written by
// src/lib/server/household-membership.ts (`writeAudit`): the Activity tab reads
// both. No entry ever holds a code, nonce, token, PIN, hash or session id, and the
// actor's email is never stored (`actorEmail: null`).

export type DeviceAuditAction =
  | 'device.code_created'
  | 'device.repair_code_created'
  | 'device.code_revoked'
  | 'device.paired'
  | 'device.repaired'
  | 'device.settings_changed'
  | 'device.removed'
  | 'device.exited';

export type DeviceAuditEntry = {
  action: DeviceAuditAction;
  actorUid: string;
  actorName: string | null;
  deviceId?: string;
  deviceName?: string;
  /** Where the change was made: a person's Devices list, or the tablet itself. */
  via: 'devices-list' | 'device';
  details?: Record<string, string | number | boolean | null>;
};

const FORBIDDEN_DETAIL_KEYS = /code|nonce|token|pin|hash|salt|secret|session/i;

export const writeDeviceAudit = (
  transaction: FirebaseFirestore.Transaction,
  householdRef: FirebaseFirestore.DocumentReference,
  entry: DeviceAuditEntry,
  now: Date,
) => {
  const details = Object.fromEntries(
    Object.entries(entry.details ?? {}).filter(([key]) => !FORBIDDEN_DETAIL_KEYS.test(key)),
  );
  transaction.set(householdRef.collection('auditLogs').doc(), {
    actorUid: entry.actorUid,
    actorEmail: null,
    actorName: entry.actorName,
    action: entry.action,
    ...(entry.deviceId ? { deviceId: entry.deviceId } : {}),
    ...(entry.deviceName ? { targetName: entry.deviceName, deviceName: entry.deviceName } : {}),
    via: entry.via,
    createdAt: now.toISOString(),
    details,
  });
};
