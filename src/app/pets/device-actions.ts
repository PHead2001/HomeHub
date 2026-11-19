'use server';

import { DeviceActionError } from '@/lib/server/device-errors';
import {
  addCareFromTablet,
  feedPetFromTablet,
  undoCareFromTablet,
  undoFeedFromTablet,
  type DeviceFeedRequest,
  type DevicePetsRequest,
} from '@/lib/server/device-pets';
import { clientAddress, trustedProxyHopsFromEnv, UNKNOWN_CLIENT } from '@/lib/devices/client-address';
import type { DeviceRefusal } from '@/lib/devices/action-policy';

// Pets actions a registered wall tablet calls with its own ID token and the selected person
// (docs/modules/devices/README.md, "Device actions: pets"). Each passes the device action
// gate; results carry a refusal code from section 8.5 that the tablet turns into copy.

export type PetsDeviceResult<T> = { ok: true; data: T } | { ok: false; code: DeviceRefusal; retryAfterSec?: number };

const requestAddress = async (): Promise<string> => {
  try {
    // Loaded here: the module is also imported outside a request (tests).
    const { headers } = await import('next/headers');
    return clientAddress(await headers(), trustedProxyHopsFromEnv(process.env.HOMEHUB_TRUSTED_PROXY_HOPS));
  } catch {
    return UNKNOWN_CLIENT;
  }
};

const run = async <T>(label: string, work: (address: string) => Promise<T>): Promise<PetsDeviceResult<T>> => {
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

type Request = { idToken: string; householdId: string; actorUid: string; pinSessionId?: string; opId: string; queued?: { createdAt: string; generation: number } };

export type FeedIntent = {
  petId: string;
  portion: { amount: number; unit: string };
  portionFromSlot?: boolean;
  food: string;
  comments?: string;
  /** The answer to "Feed again?" (the state it was shown for). */
  confirm?: { lastLogId: string | null; countToday: number; slotId?: string | null } | null;
  /** ISO; a chosen earlier time (the detailed form). */
  backdatedAt?: string | null;
};

export async function feedPetFromTabletAction(input: Request & FeedIntent) {
  return run('Tablet feeding', (address) => feedPetFromTablet(input as DeviceFeedRequest, { clientAddress: address }));
}

export async function undoFeedFromTabletAction(input: Request & { petId?: string }) {
  return run('Tablet feeding Undo', (address) => undoFeedFromTablet(input as DevicePetsRequest, { clientAddress: address }));
}

export async function addCareFromTabletAction(input: Request & { petId: string; activity: string; notes?: string }) {
  return run('Tablet care entry', (address) => addCareFromTablet(input, { clientAddress: address }));
}

export async function undoCareFromTabletAction(input: Request & { petId?: string }) {
  return run('Tablet care entry Undo', (address) => undoCareFromTablet(input as DevicePetsRequest, { clientAddress: address }));
}
