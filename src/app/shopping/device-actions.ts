'use server';

import { DeviceActionError } from '@/lib/server/device-errors';
import {
  addShoppingItemsFromTablet,
  tickShoppingItemFromTablet,
  undoShoppingAddFromTablet,
  undoShoppingTickFromTablet,
} from '@/lib/server/device-shopping';
import { clientAddress, trustedProxyHopsFromEnv, UNKNOWN_CLIENT } from '@/lib/devices/client-address';
import type { DeviceRefusal } from '@/lib/devices/action-policy';

// Shopping actions a registered wall tablet calls with its own ID token and the selected
// person (docs/modules/devices/README.md, "Device actions: shopping"). Each passes the device
// action gate; results carry a refusal code from section 8.5 that the tablet turns into copy
// (`deviceRefusalResponse`). Logic: src/lib/server/device-shopping.ts.

export type ShoppingDeviceResult<T> = { ok: true; data: T } | { ok: false; code: DeviceRefusal; retryAfterSec?: number };

const requestAddress = async (): Promise<string> => {
  try {
    // Loaded here: the module is also imported outside a request (tests).
    const { headers } = await import('next/headers');
    return clientAddress(await headers(), trustedProxyHopsFromEnv(process.env.HOMEHUB_TRUSTED_PROXY_HOPS));
  } catch {
    return UNKNOWN_CLIENT;
  }
};

const run = async <T>(label: string, work: (address: string) => Promise<T>): Promise<ShoppingDeviceResult<T>> => {
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

export async function addShoppingItemsFromTabletAction(input: Request & { listId: string; entries: Array<{ name: string; quantity: number }> }) {
  return run('Tablet shopping add', (address) => addShoppingItemsFromTablet(input, { clientAddress: address }));
}

export async function undoShoppingAddFromTabletAction(input: Request) {
  return run('Tablet shopping add Undo', (address) => undoShoppingAddFromTablet(input, { clientAddress: address }));
}

export async function tickShoppingItemFromTabletAction(input: Request & { listId: string; itemId: string }) {
  return run('Tablet shopping tick', (address) => tickShoppingItemFromTablet(input, { clientAddress: address }));
}

export async function undoShoppingTickFromTabletAction(input: Request) {
  return run('Tablet shopping tick Undo', (address) => undoShoppingTickFromTablet(input, { clientAddress: address }));
}
