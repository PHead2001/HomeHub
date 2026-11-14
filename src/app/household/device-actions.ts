'use server';

import { MembershipError, verifyCaller } from '@/lib/server/household-membership';
import {
  DeviceError,
  createDeviceCode,
  createDeviceRepairCode,
  reconcileDeviceSessions,
  redeemDeviceCodeGuarded,
  removeDevice,
  revokeDeviceCode,
  updateDeviceSettings,
  type DeviceCodeResult,
  type RedeemResult,
  type RemoveResult,
} from '@/lib/server/device-management';
import { clientAddress, trustedProxyHopsFromEnv } from '@/lib/devices/client-address';
import { REDEEM_REFUSAL_COPY } from '@/lib/devices/device-codes';
import type { DeviceManagementRefusal, DeviceSettings, RedeemRefusal } from '@/lib/devices/types';

// Server actions for registered wall tablets (docs/modules/devices/README.md).
// Management actions authenticate a personal caller (`verifyCaller`: a verified ID
// token with an email, so a device token is refused) and the server checks the
// owner/admin role inside each transaction. Redemption is the one unauthenticated
// device endpoint. Actions a tablet calls with its own token (heartbeat, PIN
// verification, comfort) live in src/app/devices/actions.ts.

export type DeviceActionResult<T> = { ok: true; data: T } | { ok: false; code: DeviceManagementRefusal; message: string };
export type RedeemActionResult = { ok: true; data: RedeemResult } | { ok: false; code: RedeemRefusal; message: string };

const FAILED = 'Something went wrong on our side. Please try again in a moment.';

const failure = (error: unknown): { ok: false; code: DeviceManagementRefusal; message: string } => {
  if (error instanceof DeviceError) return { ok: false, code: error.code as DeviceManagementRefusal, message: error.message };
  if (error instanceof MembershipError && error.code === 'unauthenticated') return { ok: false, code: 'unauthenticated', message: error.userMessage };
  console.error('Device action failed', error instanceof Error ? error.message : String(error));
  return { ok: false, code: 'failed', message: FAILED };
};

const manage = async <T>(idToken: unknown, run: (caller: Awaited<ReturnType<typeof verifyCaller>>) => Promise<T>): Promise<DeviceActionResult<T>> => {
  try {
    const caller = await verifyCaller(typeof idToken === 'string' ? idToken : '');
    return { ok: true, data: await run(caller) };
  } catch (error) {
    return failure(error);
  }
};

export async function createDeviceCodeAction(input: {
  idToken: string; householdId: string; name: string; room: string; sections?: Partial<Record<string, boolean>>;
}): Promise<DeviceActionResult<DeviceCodeResult>> {
  return manage(input?.idToken, caller => createDeviceCode(caller, input));
}

export async function createDeviceRepairCodeAction(input: { idToken: string; householdId: string; deviceId: string }): Promise<DeviceActionResult<DeviceCodeResult>> {
  return manage(input?.idToken, caller => createDeviceRepairCode(caller, input));
}

export async function revokeDeviceCodeAction(input: { idToken: string; householdId: string; code: string }): Promise<DeviceActionResult<{ code: string }>> {
  return manage(input?.idToken, caller => revokeDeviceCode(caller, input));
}

export async function updateDeviceSettingsAction(input: {
  idToken: string; householdId: string; deviceId: string; patch: Record<string, unknown>;
}): Promise<DeviceActionResult<{ changed: string[]; settings: DeviceSettings }>> {
  return manage(input?.idToken, caller => updateDeviceSettings(caller, input));
}

export async function removeDeviceAction(input: { idToken: string; householdId: string; deviceId: string }): Promise<DeviceActionResult<RemoveResult>> {
  return manage(input?.idToken, caller => removeDevice(caller, input));
}

/** Run when the Devices list opens: finishes the sign-out of tablets that are no longer active. */
export async function reconcileDeviceSessionsAction(input: { idToken: string; householdId: string }): Promise<DeviceActionResult<{ pending: number; serverNow: string }>> {
  return manage(input?.idToken, caller => reconcileDeviceSessions(caller, input?.householdId));
}

/**
 * Redeems a device code from the setup screen. Unauthenticated; guarded by the server
 * flag, rate limits per client address and per instance, and a consumed limited-use
 * App Check token. The code arrives in the request body, never in a URL.
 */
export async function redeemDeviceCodeAction(input: { code: string; nonce: string; appCheckToken?: string | null }): Promise<RedeemActionResult> {
  try {
    // Loaded here, not at the top: the module is also imported outside a request (tests).
    const { headers } = await import('next/headers');
    const requestHeaders = await headers();
    const address = clientAddress(requestHeaders, trustedProxyHopsFromEnv(process.env.HOMEHUB_TRUSTED_PROXY_HOPS));
    if (process.env.HOMEHUB_LOG_FORWARDED_SHAPE === 'true') {
      // For confirming the trusted hop count on a deployment: the entry count only, no addresses.
      console.info('Device redemption X-Forwarded-For entries', (requestHeaders.get('x-forwarded-for') ?? '').split(',').filter(Boolean).length);
    }
    const data = await redeemDeviceCodeGuarded({
      code: input?.code,
      nonce: input?.nonce,
      appCheckToken: input?.appCheckToken ?? null,
      address,
    });
    return { ok: true, data };
  } catch (error) {
    const code: RedeemRefusal = error instanceof DeviceError ? error.code as RedeemRefusal : 'failed';
    if (code === 'failed') console.error('Device code redemption failed', error instanceof Error ? error.message : String(error));
    return { ok: false, code, message: REDEEM_REFUSAL_COPY[code] ?? REDEEM_REFUSAL_COPY.failed };
  }
}
