'use server';

import { DeviceError, recordDeviceHeartbeat } from '@/lib/server/device-management';
import { DeviceActionError } from '@/lib/server/device-errors';
import { endPinSession, verifyDevicePin } from '@/lib/server/pins';
import { updateDeviceComfort } from '@/lib/server/device-comfort';
import type { DeviceRefusal } from '@/lib/devices/action-policy';
import type { DeviceSettings } from '@/lib/devices/types';
import { clientAddress, trustedProxyHopsFromEnv, UNKNOWN_CLIENT } from '@/lib/devices/client-address';

// Server actions a registered wall tablet calls with its own Firebase ID token
// (docs/modules/devices/README.md). Every one verifies the device token, its household,
// record status and credential generation; none accepts a personal token (`not_a_device`).
// Results carry a refusal code from section 8.5; the tablet maps it to copy with
// `deviceRefusalResponse` (src/lib/devices/action-policy.ts). No result ever carries PIN
// material: verification returns only the session secret the tablet keeps in memory.

export type TabletActionResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: DeviceRefusal; retryAfterSec?: number; attemptsLeft?: number };

const refusal = (error: unknown, label: string): { ok: false; code: DeviceRefusal; retryAfterSec?: number; attemptsLeft?: number } => {
  if (error instanceof DeviceActionError) {
    return {
      ok: false,
      code: error.code,
      ...(error.retryAfterSec !== undefined ? { retryAfterSec: error.retryAfterSec } : {}),
      ...(error.attemptsLeft !== undefined ? { attemptsLeft: error.attemptsLeft } : {}),
    };
  }
  if (error instanceof DeviceError) {
    const code = error.code;
    const known: DeviceRefusal[] = ['unauthenticated', 'device_revoked', 'household_deleting', 'rate_limited', 'unavailable', 'invalid_input'];
    return { ok: false, code: known.includes(code as DeviceRefusal) ? code as DeviceRefusal : 'failed' };
  }
  console.error(`${label} failed`, error instanceof Error ? error.message : String(error));
  return { ok: false, code: 'failed' };
};

/**
 * The caller's trusted client address (rightmost trusted X-Forwarded-For hop), the key of
 * the pre-auth rate limits. Never derived from anything the token claims.
 */
const requestAddress = async (): Promise<string> => {
  try {
    // Loaded here, not at the top: the module is also imported outside a request (tests).
    const { headers } = await import('next/headers');
    return clientAddress(await headers(), trustedProxyHopsFromEnv(process.env.HOMEHUB_TRUSTED_PROXY_HOPS));
  } catch {
    return UNKNOWN_CLIENT;
  }
};

/**
 * Verifies a PIN typed on the tablet for the selected member and opens a PIN session
 * (2 idle minutes). Online only: the tablet never queues a verification.
 */
export async function verifyDevicePinAction(input: { idToken: string; householdId: string; actorUid: string; pin: string }): Promise<TabletActionResult<{ pinSessionId: string; expiresAt: string }>> {
  try {
    const result = await verifyDevicePin(input, { clientAddress: await requestAddress() });
    return { ok: true, data: { pinSessionId: result.pinSessionId, expiresAt: result.expiresAt } };
  } catch (error) {
    return refusal(error, 'PIN verification');
  }
}

/** "Done" or the tablet's own idle timer ends the PIN session now (best effort). */
export async function endPinSessionAction(input: { idToken: string; householdId: string; pinSessionId: string }): Promise<TabletActionResult<{ ended: boolean }>> {
  try {
    return { ok: true, data: await endPinSession(input, new Date(), { clientAddress: await requestAddress() }) };
  } catch (error) {
    return refusal(error, 'Ending a PIN session');
  }
}

/** Comfort settings from the tablet (anyone at it): theme, text size, motion, sound. */
export async function updateDeviceComfortAction(input: { idToken: string; householdId: string; comfort: Record<string, unknown> }): Promise<TabletActionResult<{ changed: string[]; settings: DeviceSettings }>> {
  try {
    return { ok: true, data: await updateDeviceComfort(input, { clientAddress: await requestAddress() }) };
  } catch (error) {
    return refusal(error, 'Tablet comfort settings');
  }
}

/** The tablet's heartbeat: truthful last seen (server time) and its running build. */
export async function deviceHeartbeatAction(input: { idToken: string; householdId: string; appVersion: string }): Promise<TabletActionResult<{ written: boolean }>> {
  try {
    return { ok: true, data: await recordDeviceHeartbeat(input) };
  } catch (error) {
    return refusal(error, 'Tablet heartbeat');
  }
}
