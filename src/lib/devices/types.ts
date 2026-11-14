// Registered wall tablets (device principals): shared types and identity helpers.
// See docs/modules/devices/README.md. Pure: used by the server, the rules tests and the UI.

/** Firebase uid prefix of every device principal: `device_<deviceId>`. */
export const DEVICE_UID_PREFIX = 'device_';

/** A Firestore auto id (20 characters, letters and digits). */
const DEVICE_ID = /^[A-Za-z0-9]{20}$/;

export const isDeviceId = (value: unknown): value is string => typeof value === 'string' && DEVICE_ID.test(value);

export const deviceUid = (deviceId: string) => `${DEVICE_UID_PREFIX}${deviceId}`;

export type DeviceStatus = 'active' | 'unpaired' | 'removed';

/** The sections a tablet can show. Home and household notices are always on. */
export const DEVICE_SECTIONS = ['chores', 'shopping', 'pets', 'calendar', 'maintenance'] as const;
export type DeviceSectionKey = typeof DEVICE_SECTIONS[number];
export type DeviceSections = Record<DeviceSectionKey, boolean>;

export type DeviceStartPage =
  | { kind: 'home' }
  | { kind: 'chores' }
  | { kind: 'chores-room'; roomId: string }
  | { kind: 'shopping' }
  | { kind: 'shopping-list'; listId: string }
  | { kind: 'pets' }
  | { kind: 'calendar' }
  | { kind: 'maintenance' };

export type DeviceComfort = {
  theme: 'system' | 'light' | 'dark';
  textScale: 100 | 115 | 130;
  motion: 'system' | 'reduced' | 'full';
  sound: boolean;
};

export type DeviceDisplay = {
  weather: boolean;
  weatherPlace: string | null;
  temperatureUnit: 'C' | 'F';
  seasonal: boolean;
};

export type DeviceIdle = { homeAfterSec: number; ambientAfterSec: number };

/** Everything an owner or admin can edit on a device record. */
export type DeviceSettings = {
  name: string;
  room: string;
  sections: DeviceSections;
  startPage: DeviceStartPage;
  comfort: DeviceComfort;
  display: DeviceDisplay;
  idle: DeviceIdle;
  camera: 'front' | 'rear';
};

/** `households/{h}/devices/{deviceId}`, written only by the server. */
export type DeviceRecord = DeviceSettings & {
  id: string;
  status: DeviceStatus;
  generation: number;
  createdAt?: unknown;
  createdByUid?: string;
  pairedAt?: unknown;
  pairedByUid?: string;
  lastSeenAt?: unknown;
  appVersion?: string;
  updatedAt?: unknown;
  updatedByUid?: string;
  updatedVia?: 'devices-list' | 'tablet-admin-pin' | 'tablet-comfort';
  removedAt?: unknown;
  removedByUid?: string;
  endedReason?: 'removed' | 'personal-sign-in' | 'new-code' | 'household-deleted';
};

/** `deviceCodes/{code}` (top level), written only by the server. */
export type DeviceCodeRecord = {
  code: string;
  householdId: string;
  kind: 'pair' | 'repair';
  deviceId?: string;
  targetGeneration?: number;
  name?: string;
  room?: string;
  sections?: DeviceSections;
  createdByUid: string;
  createdAt: unknown;
  expiresAt: unknown;
  usedAt?: unknown;
  usedByDeviceId?: string;
  usedDeviceName?: string;
  revokedAt?: unknown;
  revokedReason?: 'manual' | 'superseded' | 'household-deleted';
};

/** Developer claims of a device ID token (flat, no PII). */
export type DeviceClaims = {
  hh_kind: 'device';
  hh_household: string;
  hh_device: string;
  hh_gen: number;
};

/**
 * The device claims of a decoded token, or null when it is not a well-formed device
 * principal (same shape test as `isDevicePrincipal()` in firestore.rules): the kind,
 * no email, a string device id matching the uid suffix, a numeric generation and a
 * household id. `signInProvider` is the token's `firebase.sign_in_provider`.
 */
export const readDeviceClaims = (token: {
  uid?: string;
  email?: unknown;
  signInProvider?: unknown;
  [claim: string]: unknown;
}): DeviceClaims | null => {
  if (token.hh_kind !== 'device') return null;
  if (token.email !== undefined && token.email !== null) return null;
  if (token.signInProvider !== undefined && token.signInProvider !== 'custom') return null;
  const device = token.hh_device;
  const household = token.hh_household;
  const generation = token.hh_gen;
  if (typeof device !== 'string' || !isDeviceId(device)) return null;
  if (token.uid !== undefined && token.uid !== deviceUid(device)) return null;
  if (typeof household !== 'string' || !household || household.includes('/')) return null;
  if (typeof generation !== 'number' || !Number.isInteger(generation) || generation < 1) return null;
  return { hh_kind: 'device', hh_household: household, hh_device: device, hh_gen: generation };
};

/** Why a code redemption was refused (section 3.3 of the module README). */
export type RedeemRefusal =
  | 'not_found'
  | 'wrong_kind'
  | 'expired'
  | 'used'
  | 'revoked'
  | 'creator_lost_access'
  | 'superseded'
  | 'not_repairable'
  | 'household_deleting'
  | 'household_needs_upkeep'
  | 'rate_limited'
  | 'app_check_failed'
  | 'invalid_input'
  | 'unavailable'
  | 'failed';

/** Why a device management action was refused. */
export type DeviceManagementRefusal =
  | 'unauthenticated'
  | 'unavailable'
  | 'invalid_input'
  | 'not_found'
  | 'not_member'
  | 'forbidden'
  | 'household_deleting'
  | 'too_many_codes'
  | 'not_repairable'
  | 'device_not_active'
  | 'start_page_section_off'
  | 'device_revoked'
  | 'rate_limited'
  | 'conflict'
  | 'failed';
