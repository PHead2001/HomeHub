// Ending a registered tablet's Firebase Auth session after its device record
// left the `active` state (removed, unpaired) or moved to a newer generation.
// Shared by the web app's server code (src/lib/server/device-identity.ts) and
// the daily sweep in ../reminders.ts. The Auth client is passed in (structural
// type), so both firebase-admin copies can use it. See
// docs/modules/devices/README.md.

export const DEVICE_UID_PREFIX = "device_";

/**
 * The Admin Auth calls this module needs.
 */
export type DeviceAuthClient = {
  getUser(uid: string): Promise<{
    uid: string; disabled: boolean;
    customClaims?: {[key: string]: unknown};
    metadata?: {creationTime?: string};
  }>;
  revokeRefreshTokens(uid: string): Promise<void>;
  deleteUser(uid: string): Promise<void>;
  updateUser(uid: string, properties: {disabled: boolean}): Promise<unknown>;
  listUsers(maxResults?: number, pageToken?: string): Promise<{
    users: Array<{uid: string; customClaims?: {[key: string]: unknown}}>;
    pageToken?: string;
  }>;
};

export type DeviceRecordState = {
  status?: unknown;
  generation?: unknown;
};

export type RevocationOutcome =
  "none" | "revoked" | "deleted" | "disabled" | "missing";

const isNotFound = (error: unknown): boolean =>
  Boolean(error && typeof error === "object" &&
    (error as {code?: unknown}).code === "auth/user-not-found");

/**
 * The Auth user's id for a device id.
 * @param {string} deviceId The device record id.
 * @return {string} `device_<deviceId>`.
 */
export const deviceUidFor = (deviceId: string): string =>
  `${DEVICE_UID_PREFIX}${deviceId}`;

/**
 * Brings the Auth user of one device in line with its record (idempotent):
 * - `removed` (or no record): refresh tokens revoked, user deleted;
 * - `unpaired`: refresh tokens revoked, user disabled (re-pairable);
 * - `active` but the Auth user's stored claims carry an older generation:
 *   refresh tokens revoked (the previous credential of a re-pair).
 * Nothing is done when the user is already in that state.
 * @param {DeviceAuthClient} auth Admin Auth.
 * @param {string} deviceId The device record id.
 * @param {DeviceRecordState | null} record The record, or null when gone.
 * @return {Promise<RevocationOutcome>} What was done.
 */
export const finishRevocationForRecord = async (
  auth: DeviceAuthClient,
  deviceId: string,
  record: DeviceRecordState | null,
): Promise<RevocationOutcome> => {
  const uid = deviceUidFor(deviceId);
  let user;
  try {
    user = await auth.getUser(uid);
  } catch (error) {
    if (isNotFound(error)) return "missing";
    throw error;
  }
  const status = record ? record.status : "removed";
  if (status === "removed" || status === undefined || status === null) {
    await auth.revokeRefreshTokens(uid);
    try {
      await auth.deleteUser(uid);
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
    return "deleted";
  }
  if (status === "unpaired") {
    if (user.disabled) return "none";
    await auth.revokeRefreshTokens(uid);
    await auth.updateUser(uid, {disabled: true});
    return "disabled";
  }
  const stored = user.customClaims ? user.customClaims.hh_gen : undefined;
  const generation = record ? record.generation : undefined;
  if (typeof generation === "number" &&
    (typeof stored !== "number" || stored < generation)) {
    await auth.revokeRefreshTokens(uid);
    return "revoked";
  }
  return "none";
};

/**
 * Retries an Auth call a few times (best effort; the daily sweep catches up).
 * @param {Function} work The call.
 * @param {number} attempts How many tries.
 * @return {Promise<boolean>} True when it succeeded.
 */
export const withRetries = async (
  work: () => Promise<unknown>,
  attempts = 3,
): Promise<boolean> => {
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      await work();
      return true;
    } catch {
      // Try again; the caller logs a final failure.
    }
  }
  return false;
};
