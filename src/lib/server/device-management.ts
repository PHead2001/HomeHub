import 'server-only';

import { createHash, randomInt } from 'node:crypto';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { adminAuth, adminDb } from '@/lib/server/firebase-admin';
import { INVITE_CHARS } from '@/lib/invite-codes';
import { DEVICE_CODE_TTL_MS, MAX_LIVE_DEVICE_CODES, normalizeDeviceCode } from '@/lib/devices/device-codes';
import {
  DEVICE_NAME_MAX,
  DEVICE_ROOM_MAX,
  defaultDeviceSettings,
  readDeviceSettings,
  readLabel,
  readSectionsInput,
  validateDevicePatch,
} from '@/lib/devices/settings';
import {
  isDeviceId,
  type DeviceManagementRefusal,
  type DeviceSettings,
  type RedeemRefusal,
} from '@/lib/devices/types';
import { notificationAudience } from '@functions/shared/notification-audience';
import { finishRevocationForRecord, withRetries } from '@functions/shared/device-revocation';
import {
  DeviceAuthError,
  devicesEnabled,
  finishDeviceRevocation,
  mintDeviceCredential,
  revokeDeviceSessions,
  verifyDevice,
  verifyRedemptionAppCheck,
} from '@/lib/server/device-identity';
import { writeDeviceAudit } from '@/lib/server/device-audit';
import type { VerifiedCaller } from '@/lib/server/household-membership';

// Device management (docs/modules/devices/README.md): device codes and re-pair codes,
// redemption, settings edits, heartbeat and removal. Every operation runs in one
// transaction that re-reads the household, the actor's membership and the records it
// changes. Authority for codes, re-pair, settings and removal is the owner or admin
// ROLE (not a permission override; JC-22). Device records and codes are written only
// here (Admin SDK); no client may write them.

type Tx = FirebaseFirestore.Transaction;
type DocRef = FirebaseFirestore.DocumentReference;

export class DeviceError extends Error {
  constructor(readonly code: DeviceManagementRefusal | RedeemRefusal, message?: string) {
    super(message ?? code);
  }
}

const NOTIFICATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DEVICES_LINK = '/household?tab=devices';
const CODE_ATTEMPTS = 6;

const householdsRef = () => adminDb.collection('households');
const deviceCodesRef = () => adminDb.collection('deviceCodes');

const requireFlag = () => {
  if (!devicesEnabled()) throw new DeviceError('unavailable', "Wall tablets aren't available yet.");
};

const requireId = (value: unknown): string => {
  if (typeof value !== 'string' || !value || value.length > 200 || value.includes('/')) {
    throw new DeviceError('invalid_input', 'That household or tablet was not found.');
  }
  return value;
};

const toDate = (value: unknown): Date | null => {
  if (value instanceof Timestamp) return value.toDate();
  if (value instanceof Date) return value;
  if (typeof value === 'string' || typeof value === 'number') {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  return null;
};

/**
 * A code's authoritative expiry: the earlier of its stored `expiresAt` and 15 minutes
 * after Firestore stored the document (a stored expiry is never trusted further).
 */
export const deviceCodeExpiry = (snapshot: FirebaseFirestore.DocumentSnapshot): Date | null => {
  const storedAt = snapshot.createTime?.toDate();
  const claimed = toDate(snapshot.get('expiresAt'));
  if (!storedAt || !claimed) return null;
  return new Date(Math.min(claimed.getTime(), storedAt.getTime() + DEVICE_CODE_TTL_MS));
};

const codeIsLive = (snapshot: FirebaseFirestore.DocumentSnapshot, now: Date) => {
  if (snapshot.get('usedAt') || snapshot.get('revokedAt')) return false;
  const expiry = deviceCodeExpiry(snapshot);
  return Boolean(expiry && expiry > now);
};

const memberName = (data: FirebaseFirestore.DocumentData | undefined): string | null =>
  typeof data?.displayName === 'string' && data.displayName.trim() && !/\S+@\S+/.test(data.displayName) ? data.displayName.trim() : null;

const isDeviceAdmin = (data: FirebaseFirestore.DocumentData | undefined) =>
  Boolean(data && (data.role === 'owner' || data.role === 'admin') && (data.status ?? 'active') === 'active');

type AdminContext = { householdRef: DocRef; household: FirebaseFirestore.DocumentData; actorName: string | null };

/**
 * The household and the caller's own membership, read in the transaction. The caller
 * must be an active owner or admin (role) of a household that is not being deleted.
 */
const loadDeviceAdmin = async (tx: Tx, caller: VerifiedCaller, householdId: unknown): Promise<AdminContext> => {
  const id = requireId(householdId);
  const householdRef = householdsRef().doc(id);
  const [household, member] = await Promise.all([
    tx.get(householdRef),
    tx.get(householdRef.collection('members').doc(caller.uid)),
  ]);
  if (!household.exists) throw new DeviceError('not_found', 'That household no longer exists.');
  if (household.get('deletingAt')) throw new DeviceError('household_deleting', 'This household is being deleted.');
  if (!member.exists) throw new DeviceError('not_member', 'You are not part of this household.');
  if (!isDeviceAdmin(member.data())) throw new DeviceError('forbidden', 'Only owners and admins can manage wall tablets.');
  return { householdRef, household: household.data() || {}, actorName: memberName(member.data()) };
};

const randomCode = () => {
  const segment = (length: number) => Array.from({ length }, () => INVITE_CHARS[randomInt(INVITE_CHARS.length)]).join('');
  return `${segment(4)}-${segment(4)}-${segment(2)}`;
};

/** A new code no device code or member invite has ever used. */
const reserveCode = async (tx: Tx): Promise<DocRef> => {
  for (let attempt = 0; attempt < CODE_ATTEMPTS; attempt++) {
    const code = randomCode();
    const [device, invite] = await Promise.all([
      tx.get(deviceCodesRef().doc(code)),
      tx.get(adminDb.collection('inviteCodes').doc(code)),
    ]);
    if (!device.exists && !invite.exists) return deviceCodesRef().doc(code);
  }
  throw new DeviceError('conflict', 'Could not create a code. Please try again.');
};

export type DeviceCodeResult = { code: string; expiresAt: string; kind: 'pair' | 'repair' };

/**
 * A new single-use code that pairs a new tablet (WT-1). Owners and admins only; at
 * most 10 live codes per household. The name, room and sections become the new
 * device record's when the code is redeemed.
 */
export const createDeviceCode = async (
  caller: VerifiedCaller,
  input: { householdId: unknown; name: unknown; room: unknown; sections?: unknown },
  now = new Date(),
): Promise<DeviceCodeResult> => {
  requireFlag();
  const name = readLabel(input?.name, DEVICE_NAME_MAX);
  if (!name) throw new DeviceError('invalid_input', `Give the tablet a name of 1 to ${DEVICE_NAME_MAX} characters.`);
  const room = readLabel(input?.room, DEVICE_ROOM_MAX);
  if (!room) throw new DeviceError('invalid_input', `Give the room a name of 1 to ${DEVICE_ROOM_MAX} characters.`);
  const sections = readSectionsInput(input?.sections);
  if (!sections) throw new DeviceError('invalid_input', 'Choose which sections the tablet shows.');
  return adminDb.runTransaction(async tx => {
    const context = await loadDeviceAdmin(tx, caller, input?.householdId);
    const codes = await tx.get(deviceCodesRef().where('householdId', '==', context.householdRef.id));
    if (codes.docs.filter(d => codeIsLive(d, now)).length >= MAX_LIVE_DEVICE_CODES) {
      throw new DeviceError('too_many_codes', 'There are already 10 unused codes. Cancel one or wait for them to expire.');
    }
    const ref = await reserveCode(tx);
    const expiresAt = new Date(now.getTime() + DEVICE_CODE_TTL_MS);
    tx.create(ref, {
      code: ref.id,
      householdId: context.householdRef.id,
      kind: 'pair',
      name,
      room,
      sections,
      createdByUid: caller.uid,
      createdAt: Timestamp.fromDate(now),
      expiresAt: Timestamp.fromDate(expiresAt),
    });
    writeDeviceAudit(tx, context.householdRef, {
      action: 'device.code_created', actorUid: caller.uid, actorName: context.actorName, via: 'devices-list',
      details: { kind: 'pair', name, room },
    }, now);
    return { code: ref.id, expiresAt: expiresAt.toISOString(), kind: 'pair' as const };
  });
};

/**
 * A single-use code that reconnects an existing record (WT-19h): same record, settings
 * kept, generation bumped at redemption. The record must be active or unpaired (a
 * removed record cannot be re-paired). Older unused re-pair codes of the same tablet
 * are revoked in the same transaction, and the code remembers the record's generation
 * so a removal or another re-pair in between makes it `superseded` (WT-19j).
 */
export const createDeviceRepairCode = async (
  caller: VerifiedCaller,
  input: { householdId: unknown; deviceId: unknown },
  now = new Date(),
): Promise<DeviceCodeResult> => {
  requireFlag();
  if (!isDeviceId(input?.deviceId)) throw new DeviceError('not_found', 'That tablet was not found.');
  const deviceId = input.deviceId;
  return adminDb.runTransaction(async tx => {
    const context = await loadDeviceAdmin(tx, caller, input?.householdId);
    const recordRef = context.householdRef.collection('devices').doc(deviceId);
    const [record, codes] = await Promise.all([
      tx.get(recordRef),
      tx.get(deviceCodesRef().where('householdId', '==', context.householdRef.id)),
    ]);
    if (!record.exists) throw new DeviceError('not_found', 'That tablet was not found.');
    const status = record.get('status');
    if (status !== 'active' && status !== 'unpaired') throw new DeviceError('not_repairable', 'That tablet was removed. Pair a new one instead.');
    const live = codes.docs.filter(d => codeIsLive(d, now));
    const superseded = live.filter(d => d.get('kind') === 'repair' && d.get('deviceId') === deviceId);
    if (live.length - superseded.length >= MAX_LIVE_DEVICE_CODES) {
      throw new DeviceError('too_many_codes', 'There are already 10 unused codes. Cancel one or wait for them to expire.');
    }
    const ref = await reserveCode(tx);
    const settings = readDeviceSettings(record.data());
    const expiresAt = new Date(now.getTime() + DEVICE_CODE_TTL_MS);
    for (const old of superseded) {
      tx.update(old.ref, { revokedAt: Timestamp.fromDate(now), revokedByUid: caller.uid, revokedReason: 'superseded' });
    }
    tx.create(ref, {
      code: ref.id,
      householdId: context.householdRef.id,
      kind: 'repair',
      deviceId,
      targetGeneration: record.get('generation'),
      name: settings.name,
      room: settings.room,
      createdByUid: caller.uid,
      createdAt: Timestamp.fromDate(now),
      expiresAt: Timestamp.fromDate(expiresAt),
    });
    writeDeviceAudit(tx, context.householdRef, {
      action: 'device.repair_code_created', actorUid: caller.uid, actorName: context.actorName, via: 'devices-list',
      deviceId, deviceName: settings.name, details: { kind: 'repair', name: settings.name, room: settings.room },
    }, now);
    return { code: ref.id, expiresAt: expiresAt.toISOString(), kind: 'repair' as const };
  });
};

/** Cancels one unused code of this household (owners and admins). Idempotent. */
export const revokeDeviceCode = async (
  caller: VerifiedCaller,
  input: { householdId: unknown; code: unknown },
  now = new Date(),
): Promise<{ code: string }> => {
  requireFlag();
  const code = normalizeDeviceCode(typeof input?.code === 'string' ? input.code : '');
  if (!code) throw new DeviceError('not_found', 'That code was not found.');
  return adminDb.runTransaction(async tx => {
    const context = await loadDeviceAdmin(tx, caller, input?.householdId);
    const ref = deviceCodesRef().doc(code);
    const snapshot = await tx.get(ref);
    // Another household's code is reported exactly like one that does not exist.
    if (!snapshot.exists || snapshot.get('householdId') !== context.householdRef.id) {
      throw new DeviceError('not_found', 'That code was not found.');
    }
    if (snapshot.get('revokedAt') || snapshot.get('usedAt')) return { code };
    tx.update(ref, { revokedAt: Timestamp.fromDate(now), revokedByUid: caller.uid, revokedReason: 'manual' });
    writeDeviceAudit(tx, context.householdRef, {
      action: 'device.code_revoked', actorUid: caller.uid, actorName: context.actorName, via: 'devices-list',
      ...(snapshot.get('deviceId') ? { deviceId: snapshot.get('deviceId') as string } : {}),
      details: { kind: snapshot.get('kind') ?? 'pair', name: snapshot.get('name') ?? null },
    }, now);
    return { code };
  });
};

// ---------------------------------------------------------------------------
// Redemption
// ---------------------------------------------------------------------------

const NONCE = /^[A-Za-z0-9_-]{43}$/;
const hashNonce = (nonce: string) => createHash('sha256').update(nonce).digest('hex');

export type RedeemResult = { customToken: string; householdId: string; deviceId: string };

type Committed = { deviceId: string; householdId: string; generation: number; retry: boolean };

/**
 * Redeems a device code in one transaction (WT-1d/e, WT-3a, WT-19h-j):
 * 1. the code exists (a member invite code gets `wrong_kind`), is not revoked and not
 *    expired by its authoritative bound;
 * 2. a code already used with the same nonce is the same tablet retrying after an
 *    uncertain response: it gets a new credential for the record it created, while that
 *    record is still active at that generation; any other use is `used`;
 * 3. the household exists, is not being deleted and carries no legacy email fields, and
 *    the code's creator is still an approved owner or admin (D-T14);
 * 4. `pair` creates the record; `repair` bumps the generation of the target record
 *    (refused when removed, or when its generation moved since the code was made);
 * 5. the code is marked used; activity and the creator's notification are written.
 * Two tablets redeeming one code race on the code document: exactly one commits.
 * After the commit every earlier credential of the device is revoked, then the new
 * credential is minted.
 */
export const redeemDeviceCode = async (input: { code: unknown; nonce: unknown }, now = new Date()): Promise<RedeemResult> => {
  const code = normalizeDeviceCode(typeof input?.code === 'string' ? input.code : '');
  if (!code) throw new DeviceError('invalid_input');
  if (typeof input?.nonce !== 'string' || !NONCE.test(input.nonce)) throw new DeviceError('invalid_input');
  const nonceHash = hashNonce(input.nonce);

  const committed: Committed = await adminDb.runTransaction(async tx => {
    const codeRef = deviceCodesRef().doc(code);
    const codeSnap = await tx.get(codeRef);
    if (!codeSnap.exists) {
      // Only to choose the message; a member invite is never redeemed here.
      const invite = await tx.get(adminDb.collection('inviteCodes').doc(code));
      throw new DeviceError(invite.exists ? 'wrong_kind' : 'not_found');
    }
    const data = codeSnap.data() || {};
    if (data.revokedAt) throw new DeviceError('revoked');
    const expiry = deviceCodeExpiry(codeSnap);
    if (!expiry || expiry <= now) throw new DeviceError('expired');
    const householdId = typeof data.householdId === 'string' ? data.householdId : '';
    if (!householdId) throw new DeviceError('not_found');
    const householdRef = householdsRef().doc(householdId);

    if (data.usedAt) {
      if (data.redemptionNonceHash !== nonceHash || typeof data.usedByDeviceId !== 'string') throw new DeviceError('used');
      const record = await tx.get(householdRef.collection('devices').doc(data.usedByDeviceId));
      if (!record.exists || record.get('status') !== 'active' || record.get('generation') !== data.usedGeneration) {
        throw new DeviceError('used');
      }
      return { deviceId: data.usedByDeviceId, householdId, generation: data.usedGeneration as number, retry: true };
    }

    const creatorUid = typeof data.createdByUid === 'string' ? data.createdByUid : '';
    const repairRef = data.kind === 'repair' && isDeviceId(data.deviceId) ? householdRef.collection('devices').doc(data.deviceId) : null;
    const [household, creator, repairSnap] = await Promise.all([
      tx.get(householdRef),
      creatorUid ? tx.get(householdRef.collection('members').doc(creatorUid)) : Promise.resolve(null),
      repairRef ? tx.get(repairRef) : Promise.resolve(null),
    ]);
    if (!household.exists) throw new DeviceError('not_found');
    if (household.get('deletingAt')) throw new DeviceError('household_deleting');
    const householdData = household.data() || {};
    if ('memberEmails' in householdData || 'ownerEmail' in householdData) throw new DeviceError('household_needs_upkeep');
    if (!creator?.exists || !isDeviceAdmin(creator.data())) throw new DeviceError('creator_lost_access');
    const creatorName = memberName(creator.data());

    let recordRef: DocRef;
    let generation: number;
    let settings: DeviceSettings;
    const stamp = Timestamp.fromDate(now);
    if (data.kind === 'repair') {
      if (!repairRef || !repairSnap?.exists) throw new DeviceError('not_repairable');
      const status = repairSnap.get('status');
      if (status === 'removed') throw new DeviceError('not_repairable');
      if (status !== 'active' && status !== 'unpaired') throw new DeviceError('not_repairable');
      const current = repairSnap.get('generation');
      if (typeof current !== 'number' || current !== data.targetGeneration) throw new DeviceError('superseded');
      recordRef = repairRef;
      generation = current + 1;
      settings = readDeviceSettings(repairSnap.data());
      // Settings are kept (WT-19h); only the credential state changes.
      tx.update(recordRef, {
        status: 'active',
        generation,
        pairedAt: stamp,
        pairedByUid: creatorUid,
        removedAt: FieldValue.delete(),
        removedByUid: FieldValue.delete(),
        endedReason: FieldValue.delete(),
      });
    } else {
      recordRef = householdRef.collection('devices').doc();
      generation = 1;
      settings = defaultDeviceSettings(
        readLabel(data.name, DEVICE_NAME_MAX) ?? 'Wall tablet',
        readLabel(data.room, DEVICE_ROOM_MAX) ?? 'Home',
        readSectionsInput(data.sections) ?? undefined,
      );
      tx.create(recordRef, {
        id: recordRef.id,
        ...settings,
        status: 'active',
        generation,
        createdAt: stamp,
        createdByUid: creatorUid,
        pairedAt: stamp,
        pairedByUid: creatorUid,
      });
    }

    tx.update(codeRef, {
      usedAt: stamp,
      usedByDeviceId: recordRef.id,
      usedDeviceName: settings.name,
      usedGeneration: generation,
      redemptionNonceHash: nonceHash,
    });
    writeDeviceAudit(tx, householdRef, {
      action: data.kind === 'repair' ? 'device.repaired' : 'device.paired',
      actorUid: creatorUid, actorName: creatorName, via: 'device',
      deviceId: recordRef.id, deviceName: settings.name,
      details: { deviceId: recordRef.id, name: settings.name, room: settings.room, generation },
    }, now);
    // The code's creator always learns that their code was used (S15).
    tx.set(householdRef.collection('notifications').doc(`device-paired-${recordRef.id}-${generation}`), {
      householdId,
      category: 'system',
      title: data.kind === 'repair' ? 'Wall tablet set up again' : 'Wall tablet paired',
      message: `${settings.name} (${settings.room}) was set up with your code. If that wasn't you, remove it from Devices.`,
      createdAt: stamp,
      expiresAt: Timestamp.fromMillis(now.getTime() + NOTIFICATION_TTL_MS),
      deepLink: DEVICES_LINK,
      sourceType: 'device-paired',
      sourceId: recordRef.id,
      stateKey: String(generation),
      targetUserUid: creatorUid,
      audience: notificationAudience({ targetUserUid: creatorUid }),
      readBy: {},
      dismissedBy: {},
    });
    return { deviceId: recordRef.id, householdId, generation, retry: false };
  });

  // Every earlier credential of this device ends (a re-pair, or a retry whose first
  // answer was lost), then the new one is issued. A failure here leaves the record
  // paired; the tablet retries with the same code and nonce.
  if (!(await revokeDeviceSessions(committed.deviceId))) throw new DeviceError('failed');
  let customToken: string;
  try {
    customToken = await mintDeviceCredential(committed.deviceId, committed.householdId, committed.generation);
  } catch (error) {
    console.error('Device credential could not be issued', error instanceof Error ? error.message : String(error));
    throw new DeviceError('failed');
  }
  // A removal or another re-pair that committed after this redemption may have finished
  // its own sign-out before the credential above was issued: read the record again (after
  // minting), and if it moved on, end what was just issued and refuse.
  const current = await householdsRef().doc(committed.householdId).collection('devices').doc(committed.deviceId).get();
  if (current.get('status') !== 'active' || current.get('generation') !== committed.generation) {
    await finishDeviceRevocation(committed.deviceId, current.exists ? { status: current.get('status'), generation: current.get('generation') } : null);
    throw new DeviceError(current.get('status') === 'active' ? 'superseded' : 'not_repairable');
  }
  return { customToken, householdId: committed.householdId, deviceId: committed.deviceId };
};

// In-memory windows for redemption (per client address and per instance), the
// pattern of runGuarded in src/ai/action-auth.ts.
type LimitState = typeof globalThis & { __homeHubDeviceWindows?: Map<string, number[]> };
const limitState = globalThis as LimitState;
const windows = limitState.__homeHubDeviceWindows || new Map<string, number[]>();
limitState.__homeHubDeviceWindows = windows;

/** Counts one call in a 60 s window; false when `max` calls were already counted. */
export const takeRateSlot = (key: string, max: number, nowMs = Date.now()): boolean => {
  const recent = (windows.get(key) || []).filter(at => nowMs - at < 60_000);
  if (recent.length >= max) {
    windows.set(key, recent);
    return false;
  }
  recent.push(nowMs);
  windows.set(key, recent);
  return true;
};

export const REDEEM_LIMITS = { perAddress: 10, perInstance: 300 };

/**
 * The redemption endpoint's guards, then the redemption: the server flag, the rate
 * limits (per client address when known, and per instance always), then the consumed
 * limited-use App Check token (fails closed outside the emulator).
 */
export const redeemDeviceCodeGuarded = async (
  input: { code: unknown; nonce: unknown; appCheckToken: unknown; address: string | null },
  options: { now?: Date; limits?: { perAddress: number; perInstance: number } } = {},
): Promise<RedeemResult> => {
  if (!devicesEnabled()) throw new DeviceError('unavailable');
  const limits = options.limits ?? REDEEM_LIMITS;
  const nowMs = (options.now ?? new Date()).getTime();
  if (!takeRateSlot('redeem:instance', limits.perInstance, nowMs)) throw new DeviceError('rate_limited');
  if (input.address && !takeRateSlot(`redeem:address:${input.address}`, limits.perAddress, nowMs)) throw new DeviceError('rate_limited');
  if (!(await verifyRedemptionAppCheck(input.appCheckToken))) throw new DeviceError('app_check_failed');
  return redeemDeviceCode({ code: input.code, nonce: input.nonce }, options.now);
};

// ---------------------------------------------------------------------------
// Settings, heartbeat, removal
// ---------------------------------------------------------------------------

/**
 * Edits a tablet's settings from the Devices list (owners and admins). Only the named
 * fields are validated and written (dotted paths), so two admins editing different
 * fields both keep their change. Removed and unpaired records refuse every edit.
 * Admin-field edits are logged (`device.settings_changed`); comfort-only edits are not.
 */
export const updateDeviceSettings = async (
  caller: VerifiedCaller,
  input: { householdId: unknown; deviceId: unknown; patch: unknown },
  now = new Date(),
): Promise<{ changed: string[]; settings: DeviceSettings }> => {
  requireFlag();
  if (!isDeviceId(input?.deviceId)) throw new DeviceError('not_found', 'That tablet was not found.');
  const deviceId = input.deviceId;
  return adminDb.runTransaction(async tx => {
    const context = await loadDeviceAdmin(tx, caller, input?.householdId);
    const recordRef = context.householdRef.collection('devices').doc(deviceId);
    const record = await tx.get(recordRef);
    if (!record.exists) throw new DeviceError('not_found', 'That tablet was not found.');
    if (record.get('status') !== 'active') throw new DeviceError('device_not_active', 'That tablet is no longer paired. Re-pair it first.');
    const result = validateDevicePatch(input?.patch, readDeviceSettings(record.data()), 'admin');
    if (!result.ok) throw new DeviceError(result.code, result.message);
    if (result.changed.length === 0) return { changed: [], settings: result.next };
    tx.update(recordRef, {
      ...result.updates,
      updatedAt: Timestamp.fromDate(now),
      updatedByUid: caller.uid,
      updatedVia: 'devices-list',
    });
    const adminFields = result.changed.filter(field => field !== 'comfort');
    if (adminFields.length > 0) {
      writeDeviceAudit(tx, context.householdRef, {
        action: 'device.settings_changed', actorUid: caller.uid, actorName: context.actorName, via: 'devices-list',
        deviceId, deviceName: result.next.name, details: { fields: adminFields.join(', ') },
      }, now);
    }
    return { changed: result.changed, settings: result.next };
  });
};

const APP_VERSION = /^[0-9]{8}T[0-9]{9}Z$/;
const HEARTBEAT_MIN_INTERVAL_MS = 60_000;
export const HEARTBEAT_LIMIT_PER_MINUTE = 6;

/**
 * The tablet's heartbeat (WT-4a): stores the server's time as `lastSeenAt` and the
 * running build id as `appVersion` ('unknown' when it is not a build stamp). Written
 * only when the last one is older than 60 s or the version changed. The device token,
 * its household, record status and generation are verified first.
 */
export const recordDeviceHeartbeat = async (
  input: { idToken: unknown; householdId: unknown; appVersion: unknown },
  now = new Date(),
): Promise<{ written: boolean }> => {
  requireFlag();
  let identity;
  try {
    identity = await verifyDevice(input?.idToken, input?.householdId);
  } catch (error) {
    if (error instanceof DeviceAuthError) {
      throw new DeviceError(error.code === 'household_deleting' || error.code === 'device_revoked' ? error.code : 'unauthenticated');
    }
    throw error;
  }
  if (!takeRateSlot(`heartbeat:${identity.deviceId}`, HEARTBEAT_LIMIT_PER_MINUTE, now.getTime())) throw new DeviceError('rate_limited');
  const appVersion = typeof input?.appVersion === 'string' && APP_VERSION.test(input.appVersion) ? input.appVersion : 'unknown';
  return adminDb.runTransaction(async tx => {
    const [record, household] = await Promise.all([
      tx.get(identity.recordRef),
      tx.get(householdsRef().doc(identity.householdId)),
    ]);
    if (!household.exists || household.get('deletingAt')) throw new DeviceError('household_deleting');
    if (!record.exists || record.get('status') !== 'active' || record.get('generation') !== identity.generation) {
      throw new DeviceError('device_revoked');
    }
    const last = toDate(record.get('lastSeenAt'));
    const stale = !last || now.getTime() - last.getTime() >= HEARTBEAT_MIN_INTERVAL_MS;
    if (!stale && record.get('appVersion') === appVersion) return { written: false };
    tx.update(identity.recordRef, { lastSeenAt: Timestamp.fromDate(now), appVersion });
    return { written: true };
  });
};

export type RemoveResult = { authCleanup: 'done' | 'pending'; alreadyRemoved: boolean };

/**
 * Removes a tablet (WT-4j, WT-19a): one transaction sets `status: 'removed'`, bumps
 * the generation (so the rules and server refuse its token at once), revokes its unused
 * re-pair codes, logs `device.removed` and notifies every active owner and admin. After
 * the commit its refresh tokens are revoked and its Auth user deleted; when that fails
 * the result says `authCleanup: 'pending'` (a retry of Remove, the Devices list's load
 * or the daily sweep finishes it). Nobody's account is touched. A removed record stays
 * (history) and can never be re-paired.
 */
export const removeDevice = async (
  caller: VerifiedCaller,
  input: { householdId: unknown; deviceId: unknown },
  now = new Date(),
): Promise<RemoveResult> => {
  requireFlag();
  if (!isDeviceId(input?.deviceId)) throw new DeviceError('not_found', 'That tablet was not found.');
  const deviceId = input.deviceId;
  const committed = await adminDb.runTransaction(async tx => {
    const context = await loadDeviceAdmin(tx, caller, input?.householdId);
    const recordRef = context.householdRef.collection('devices').doc(deviceId);
    const [record, codes, admins] = await Promise.all([
      tx.get(recordRef),
      tx.get(deviceCodesRef().where('householdId', '==', context.householdRef.id)),
      tx.get(context.householdRef.collection('members').where('role', 'in', ['owner', 'admin'])),
    ]);
    if (!record.exists) throw new DeviceError('not_found', 'That tablet was not found.');
    const generation = record.get('generation');
    if (record.get('status') === 'removed') return { generation, alreadyRemoved: true };
    const next = (typeof generation === 'number' ? generation : 0) + 1;
    const name = readDeviceSettings(record.data()).name;
    const room = readDeviceSettings(record.data()).room;
    const stamp = Timestamp.fromDate(now);
    tx.update(recordRef, {
      status: 'removed',
      generation: next,
      removedAt: stamp,
      removedByUid: caller.uid,
      endedReason: 'removed',
    });
    for (const code of codes.docs) {
      if (code.get('deviceId') === deviceId && codeIsLive(code, now)) {
        tx.update(code.ref, { revokedAt: stamp, revokedByUid: caller.uid, revokedReason: 'superseded' });
      }
    }
    writeDeviceAudit(tx, context.householdRef, {
      action: 'device.removed', actorUid: caller.uid, actorName: context.actorName, via: 'devices-list',
      deviceId, deviceName: name, details: { name, room, generation: next },
    }, now);
    for (const admin of admins.docs.filter(d => isDeviceAdmin(d.data()))) {
      tx.set(context.householdRef.collection('notifications').doc(`device-removed-${deviceId}-${next}-${admin.id}`), {
        householdId: context.householdRef.id,
        category: 'system',
        title: 'Wall tablet removed',
        message: `${name} (${room}) was removed${context.actorName ? ` by ${context.actorName}` : ''} and signed out.`,
        createdAt: stamp,
        expiresAt: Timestamp.fromMillis(now.getTime() + NOTIFICATION_TTL_MS),
        deepLink: DEVICES_LINK,
        sourceType: 'device-removed',
        sourceId: deviceId,
        stateKey: String(next),
        targetUserUid: admin.id,
        audience: notificationAudience({ targetUserUid: admin.id }),
        readBy: {},
        dismissedBy: {},
      });
    }
    return { generation: next, alreadyRemoved: false };
  });
  const cleanup = await finishDeviceRevocation(deviceId, { status: 'removed', generation: committed.generation });
  return { authCleanup: cleanup.ok ? 'done' : 'pending', alreadyRemoved: committed.alreadyRemoved };
};

/**
 * Run when an owner or admin opens the Devices list: finishes the Auth sign-out of
 * every tablet that is no longer active (idempotent; at most once a minute per
 * household on this instance). Returns how many still could not be finished, and the
 * server's time (the list's Online state is measured against it).
 */
export const reconcileDeviceSessions = async (caller: VerifiedCaller, householdId: unknown): Promise<{ pending: number; serverNow: string }> => {
  requireFlag();
  const id = requireId(householdId);
  await adminDb.runTransaction(tx => loadDeviceAdmin(tx, caller, id));
  // The list shows Online from server time, never the viewer's clock.
  const serverNow = new Date().toISOString();
  if (!takeRateSlot(`reconcile:${id}`, 1)) return { pending: 0, serverNow };
  const records = await householdsRef().doc(id).collection('devices').where('status', 'in', ['removed', 'unpaired']).get();
  let pending = 0;
  for (const record of records.docs) {
    const result = await finishDeviceRevocation(record.id, { status: record.get('status'), generation: record.get('generation') });
    if (!result.ok) pending += 1;
  }
  return { pending, serverNow };
};

// ---------------------------------------------------------------------------
// Household deletion (used by deleteHousehold in household-membership.ts)
// ---------------------------------------------------------------------------

/** Reads, inside deleteHousehold's first transaction, every device and code of the household. */
export const readHouseholdDevicesForDeletion = (tx: Tx, householdRef: DocRef) => Promise.all([
  tx.get(householdRef.collection('devices')),
  tx.get(deviceCodesRef().where('householdId', '==', householdRef.id)),
]);

/**
 * Writes, in that same transaction, every device `removed` with a bumped generation
 * (`endedReason: 'household-deleted'`) and every unused code revoked. Device reads
 * stop at this commit (the rules also refuse every device read once `deletingAt` is set).
 */
export const markHouseholdDevicesRemoved = (
  tx: Tx,
  [devices, codes]: [FirebaseFirestore.QuerySnapshot, FirebaseFirestore.QuerySnapshot],
  callerUid: string,
  now: Date,
) => {
  const stamp = Timestamp.fromDate(now);
  for (const device of devices.docs) {
    if (device.get('status') === 'removed') continue;
    const generation = device.get('generation');
    tx.update(device.ref, {
      status: 'removed',
      generation: (typeof generation === 'number' ? generation : 0) + 1,
      removedAt: stamp,
      removedByUid: callerUid,
      endedReason: 'household-deleted',
    });
  }
  for (const code of codes.docs) {
    if (code.get('usedAt') || code.get('revokedAt')) continue;
    tx.update(code.ref, { revokedAt: stamp, revokedByUid: callerUid, revokedReason: 'household-deleted' });
  }
};

/**
 * After deleteHousehold's first transaction and before any data is deleted: every
 * device's refresh tokens are revoked and its Auth user deleted (each retried 3 times;
 * a failure is logged and left to the daily sweep). Returns the ids that failed.
 */
export const revokeHouseholdDeviceUsers = async (deviceIds: string[]): Promise<string[]> => {
  const failed: string[] = [];
  for (const deviceId of deviceIds) {
    const ok = await withRetries(() => finishRevocationForRecord(adminAuth, deviceId, { status: 'removed' }));
    if (!ok) {
      failed.push(deviceId);
      console.warn('A wall tablet could not be signed out during household deletion; the daily sweep retries it.', { deviceId });
    }
  }
  return failed;
};
