'use server';

import { DeviceActionError } from '@/lib/server/device-errors';
import {
  completeFromTablet,
  deleteLogFromTablet,
  editSchedulesFromTablet,
  logFromTablet,
  snoozeFromTablet,
  undoCompleteFromTablet,
  undoLogFromTablet,
  undoSnoozeFromTablet,
  type CompleteIntent,
  type EditSchedulesIntent,
  type LogIntent,
  type SnoozeIntent,
} from '@/lib/server/device-maintenance';
import { clientAddress, trustedProxyHopsFromEnv, UNKNOWN_CLIENT } from '@/lib/devices/client-address';
import type { DeviceRefusal } from '@/lib/devices/action-policy';

// Maintenance actions a registered wall tablet calls with its own ID token and the selected
// person (docs/modules/devices/README.md, "Device actions: maintenance (M8a)"). Each passes
// the device action gate; results carry a refusal code from section 8.5 that the tablet
// turns into copy (`deviceRefusalResponse`). Logic: src/lib/server/device-maintenance.ts.

export type MaintenanceDeviceResult<T> = { ok: true; data: T } | { ok: false; code: DeviceRefusal; retryAfterSec?: number };

const requestAddress = async (): Promise<string> => {
  try {
    // Loaded here: the module is also imported outside a request (tests).
    const { headers } = await import('next/headers');
    return clientAddress(await headers(), trustedProxyHopsFromEnv(process.env.HOMEHUB_TRUSTED_PROXY_HOPS));
  } catch {
    return UNKNOWN_CLIENT;
  }
};

const run = async <T>(label: string, work: (address: string) => Promise<T>): Promise<MaintenanceDeviceResult<T>> => {
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

export async function completeFromTabletAction(input: Request & CompleteIntent) {
  return run('Tablet maintenance Done', (address) => completeFromTablet(input, { clientAddress: address }));
}

export async function undoCompleteFromTabletAction(input: Request) {
  return run('Tablet maintenance Done Undo', (address) => undoCompleteFromTablet(input, { clientAddress: address }));
}

export async function logFromTabletAction(input: Request & LogIntent) {
  return run('Tablet maintenance log', (address) => logFromTablet(input, { clientAddress: address }));
}

export async function undoLogFromTabletAction(input: Request) {
  return run('Tablet maintenance log Undo', (address) => undoLogFromTablet(input, { clientAddress: address }));
}

export async function snoozeFromTabletAction(input: Request & SnoozeIntent) {
  return run('Tablet maintenance snooze', (address) => snoozeFromTablet(input, { clientAddress: address }));
}

export async function undoSnoozeFromTabletAction(input: Request) {
  return run('Tablet maintenance snooze Undo', (address) => undoSnoozeFromTablet(input, { clientAddress: address }));
}

export async function editSchedulesFromTabletAction(input: Request & EditSchedulesIntent) {
  return run('Tablet maintenance schedules', (address) => editSchedulesFromTablet(input, { clientAddress: address }));
}

export async function deleteLogFromTabletAction(input: Request & { logId: string }) {
  return run('Tablet maintenance log delete', (address) => deleteLogFromTablet(input, { clientAddress: address }));
}
