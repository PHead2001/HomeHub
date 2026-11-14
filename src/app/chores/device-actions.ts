'use server';

import { DeviceActionError } from '@/lib/server/device-errors';
import {
  completeChoreFromTablet,
  takeChoreFromTablet,
  undoChoreCompletionFromTablet,
  undoTakeChoreFromTablet,
  type DeviceChoreRequest,
} from '@/lib/server/device-chores';
import { clientAddress, trustedProxyHopsFromEnv, UNKNOWN_CLIENT } from '@/lib/devices/client-address';
import type { DeviceRefusal } from '@/lib/devices/action-policy';

// Chore actions a registered wall tablet calls with its own ID token and the selected
// person (docs/modules/devices/README.md, "Device actions"). Each passes the device action
// gate; results carry a refusal code from section 8.5 that the tablet turns into copy.

export type ChoreDeviceResult<T> = { ok: true; data: T } | { ok: false; code: DeviceRefusal; retryAfterSec?: number };

const requestAddress = async (): Promise<string> => {
  try {
    // Loaded here: the module is also imported outside a request (tests).
    const { headers } = await import('next/headers');
    return clientAddress(await headers(), trustedProxyHopsFromEnv(process.env.HOMEHUB_TRUSTED_PROXY_HOPS));
  } catch {
    return UNKNOWN_CLIENT;
  }
};

const run = async <T>(label: string, work: (address: string) => Promise<T>): Promise<ChoreDeviceResult<T>> => {
  try {
    return { ok: true, data: JSON.parse(JSON.stringify(await work(await requestAddress()))) as T };
  } catch (error) {
    if (error instanceof DeviceActionError) {
      return { ok: false, code: error.code, ...(error.retryAfterSec !== undefined ? { retryAfterSec: error.retryAfterSec } : {}) };
    }
    console.error(`${label} failed`, error instanceof Error ? error.message : String(error));
    return { ok: false, code: 'failed' };
  }
};

type Request = { idToken: string; householdId: string; actorUid: string; pinSessionId?: string; opId: string; queued?: { createdAt: string } };

export async function completeChoreFromTabletAction(input: Request & { choreId: string }) {
  return run('Tablet chore completion', clientAddressValue => completeChoreFromTablet(input as DeviceChoreRequest & { choreId: unknown }, { clientAddress: clientAddressValue }));
}

export async function undoChoreCompletionFromTabletAction(input: Request) {
  return run('Tablet chore completion Undo', clientAddressValue => undoChoreCompletionFromTablet(input, { clientAddress: clientAddressValue }));
}

export async function takeChoreFromTabletAction(input: Request & { choreId: string }) {
  return run('Tablet chore take', clientAddressValue => takeChoreFromTablet(input as DeviceChoreRequest & { choreId: unknown }, { clientAddress: clientAddressValue }));
}

export async function undoTakeChoreFromTabletAction(input: Request) {
  return run('Tablet chore take Undo', clientAddressValue => undoTakeChoreFromTablet(input, { clientAddress: clientAddressValue }));
}
