import 'server-only';

import { getAppCheck } from 'firebase-admin/app-check';
import { adminAuth, adminDb } from '@/lib/server/firebase-admin';
import type { DecodedIdToken } from 'firebase-admin/auth';
import { deviceUid, readDeviceClaims, type DeviceClaims } from '@/lib/devices/types';
import { classifyVerifyError } from '@/lib/devices/verify-errors';
import { finishRevocationForRecord, withRetries, type RevocationOutcome } from '@functions/shared/device-revocation';

// Device principal identity (docs/modules/devices/README.md, "Device identity"):
// Firebase Auth custom tokens for uid `device_<deviceId>` with the claims
// hh_kind/hh_household/hh_device/hh_gen, verification of a device ID token against
// its record, and ending a device's session after removal, unpairing or re-pairing.

/**
 * The server-side switch for every device feature (`HOMEHUB_DEVICES_ENABLED=true`).
 * Read on every call, so turning it off needs no rebuild.
 */
export const devicesEnabled = (): boolean => process.env.HOMEHUB_DEVICES_ENABLED === 'true';

const isNotFound = (error: unknown) =>
  Boolean(error && typeof error === 'object' && (error as { code?: unknown }).code === 'auth/user-not-found');

/**
 * Issues the one-time credential a tablet exchanges for its session:
 * 1. the Auth user `device_<id>` exists and is enabled (created with no email or name);
 * 2. the claims are stored on the user (`setCustomUserClaims`, the copy every newly
 *    issued ID token carries);
 * 3. a custom token with the same claims (used once; it is not the session).
 */
export const mintDeviceCredential = async (deviceId: string, householdId: string, generation: number): Promise<string> => {
  const uid = deviceUid(deviceId);
  const claims: DeviceClaims = { hh_kind: 'device', hh_household: householdId, hh_device: deviceId, hh_gen: generation };
  try {
    await adminAuth.getUser(uid);
    await adminAuth.updateUser(uid, { disabled: false });
  } catch (error) {
    if (!isNotFound(error)) throw error;
    await adminAuth.createUser({ uid, disabled: false });
  }
  await adminAuth.setCustomUserClaims(uid, claims);
  return adminAuth.createCustomToken(uid, claims);
};

export type DeviceIdentity = {
  deviceId: string;
  householdId: string;
  generation: number;
  record: FirebaseFirestore.DocumentData;
  recordRef: FirebaseFirestore.DocumentReference;
};

export class DeviceAuthError extends Error {
  constructor(readonly code: 'unauthenticated' | 'not_a_device' | 'wrong_household' | 'device_revoked' | 'household_deleting' | 'unavailable') {
    super(code);
  }
}

export type VerifyIdToken = (idToken: string, checkRevoked: boolean) => Promise<DecodedIdToken>;

/**
 * Verifies a device ID token (revocation and disabled users checked) and its record:
 * the token is a well-formed device principal of `householdId`, the household exists
 * and is not being deleted, and the record is `active` at the token's generation. A
 * revoked, disabled or deleted credential is `device_revoked`, an invalid or expired token
 * `unauthenticated`; a verifier outage (network, internal error, quota, unknown) is
 * `unavailable`, which never ends a tablet's session (`classifyVerifyError`).
 * `verifyIdToken` is injectable for tests.
 */
export const verifyDevice = async (
  idToken: unknown,
  householdId: unknown,
  verifyIdToken: VerifyIdToken = (token, checkRevoked) => adminAuth.verifyIdToken(token, checkRevoked),
): Promise<DeviceIdentity> => {
  if (typeof idToken !== 'string' || !idToken) throw new DeviceAuthError('unauthenticated');
  let decoded;
  try {
    decoded = await verifyIdToken(idToken, true);
  } catch (error) {
    const failure = classifyVerifyError(error);
    if (failure === 'revoked') throw new DeviceAuthError('device_revoked');
    if (failure === 'invalid') throw new DeviceAuthError('unauthenticated');
    console.warn('Device token could not be verified right now.', error instanceof Error ? error.message : String(error));
    throw new DeviceAuthError('unavailable');
  }
  const claims = readDeviceClaims({ ...decoded, uid: decoded.uid, email: decoded.email, signInProvider: decoded.firebase?.sign_in_provider });
  if (!claims) throw new DeviceAuthError('not_a_device');
  if (claims.hh_household !== householdId) throw new DeviceAuthError('wrong_household');
  const householdRef = adminDb.collection('households').doc(claims.hh_household);
  const recordRef = householdRef.collection('devices').doc(claims.hh_device);
  const [household, record] = await Promise.all([householdRef.get(), recordRef.get()]);
  if (!household.exists || household.get('deletingAt')) throw new DeviceAuthError('household_deleting');
  const data = record.exists ? record.data() || {} : null;
  if (!data || data.status !== 'active' || data.generation !== claims.hh_gen) throw new DeviceAuthError('device_revoked');
  return { deviceId: claims.hh_device, householdId: claims.hh_household, generation: claims.hh_gen, record: data, recordRef };
};

/**
 * Ends the Auth session of a device whose record is no longer active (or moved to a
 * newer generation): revoke refresh tokens, then delete (`removed`) or disable
 * (`unpaired`) the Auth user. Idempotent; re-run by a retry of Remove, by the Devices
 * list's load and by the daily sweep. `record` is the record as just committed.
 */
export const finishDeviceRevocation = async (
  deviceId: string,
  record: { status?: unknown; generation?: unknown } | null,
): Promise<{ ok: boolean; outcome?: RevocationOutcome }> => {
  let outcome: RevocationOutcome | undefined;
  const ok = await withRetries(async () => {
    outcome = await finishRevocationForRecord(adminAuth, deviceId, record);
  });
  if (!ok) console.warn('Device sign-out could not be finished yet; the daily sweep retries it.', { deviceId });
  return { ok, outcome };
};

/** Revokes the refresh tokens of a device (every earlier credential, WT-19i). */
export const revokeDeviceSessions = async (deviceId: string): Promise<boolean> => {
  return withRetries(async () => {
    try {
      await adminAuth.revokeRefreshTokens(deviceUid(deviceId));
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  });
};

/**
 * App Check for the one unauthenticated device endpoint (redemption): a limited-use
 * token, consumed. Fails closed when it is missing, invalid or already used (so a
 * deployment without the reCAPTCHA site key cannot pair tablets). Skipped only in
 * emulator mode.
 */
export const verifyRedemptionAppCheck = async (token: unknown): Promise<boolean> => {
  if (process.env.NEXT_PUBLIC_USE_FIREBASE_EMULATORS === 'true') return true;
  if (typeof token !== 'string' || !token || token.length > 4096) return false;
  try {
    const result = await getAppCheck(adminAuth.app).verifyToken(token, { consume: true });
    return !result.alreadyConsumed;
  } catch {
    return false;
  }
};
