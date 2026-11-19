'use server';

import { DeviceActionError } from '@/lib/server/device-errors';
import {
  addCareFromTablet,
  addNoteFromTablet,
  addWeightFromTablet,
  correctFeedTimeFromTablet,
  deleteLogFromTablet,
  deleteNoteFromTablet,
  deletePetFromTablet,
  editNoteFromTablet,
  editPetProfileFromTablet,
  feedPetFromTablet,
  giveDoseFromTablet,
  saveCourseFromTablet,
  saveMealPlanFromTablet,
  setCourseFinishedFromTablet,
  setNotePinnedFromTablet,
  undoCareFromTablet,
  undoDoseFromTablet,
  undoFeedFromTablet,
  undoNoteFromTablet,
  undoWeightFromTablet,
  type DeviceDoseRequest,
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


// --- F4b-2 ---------------------------------------------------------------------------------

export type DoseIntent = {
  petId: string;
  courseId: string;
  occurrenceKey: string;
  /** ISO; a chosen earlier given-at time. */
  givenAt?: string | null;
  notes?: string;
  /** The answer to "Already given?" (the dose it named). */
  confirm?: { lastLogId: string | null } | null;
};

export async function giveDoseFromTabletAction(input: Request & DoseIntent) {
  return run('Tablet dose', (address) => giveDoseFromTablet(input as DeviceDoseRequest, { clientAddress: address }));
}

export async function undoDoseFromTabletAction(input: Request & { petId?: string }) {
  return run('Tablet dose Undo', (address) => undoDoseFromTablet(input as DevicePetsRequest, { clientAddress: address }));
}

export async function addNoteFromTabletAction(input: Request & { petId: string; text: string; tag?: string; day?: string }) {
  return run('Tablet note', (address) => addNoteFromTablet(input, { clientAddress: address }));
}

export async function undoNoteFromTabletAction(input: Request & { petId?: string }) {
  return run('Tablet note Undo', (address) => undoNoteFromTablet(input as DevicePetsRequest, { clientAddress: address }));
}

export async function addWeightFromTabletAction(input: Request & { petId: string; value: number; unit: string; day?: string }) {
  return run('Tablet weight', (address) => addWeightFromTablet(input, { clientAddress: address }));
}

export async function undoWeightFromTabletAction(input: Request & { petId?: string }) {
  return run('Tablet weight Undo', (address) => undoWeightFromTablet(input as DevicePetsRequest, { clientAddress: address }));
}

export async function setNotePinnedFromTabletAction(input: Request & { petId: string; noteId: string; pinned: boolean }) {
  return run('Tablet note pin', (address) => setNotePinnedFromTablet(input, { clientAddress: address }));
}

export async function editNoteFromTabletAction(input: Request & { petId: string; noteId: string; expected: { text: string; tag: string | null }; text: string; tag?: string | null }) {
  return run('Tablet note edit', (address) => editNoteFromTablet(input, { clientAddress: address }));
}

export async function deleteNoteFromTabletAction(input: Request & { petId: string; noteId: string }) {
  return run('Tablet note delete', (address) => deleteNoteFromTablet(input, { clientAddress: address }));
}

export async function deleteLogFromTabletAction(input: Request & { petId: string; kind: string; logId: string }) {
  return run('Tablet log delete', (address) => deleteLogFromTablet(input, { clientAddress: address }));
}

export async function correctFeedTimeFromTabletAction(input: Request & { petId: string; logId: string; date: string }) {
  return run('Tablet feed time', (address) => correctFeedTimeFromTablet(input, { clientAddress: address }));
}

export async function setCourseFinishedFromTabletAction(input: Request & { petId: string; courseId: string; finished: boolean }) {
  return run('Tablet course finish', (address) => setCourseFinishedFromTablet(input, { clientAddress: address }));
}

export async function saveCourseFromTabletAction(input: Request & { petId: string; courseId?: string; create?: boolean; values: Record<string, unknown>; legacyKey?: string | null }) {
  return run('Tablet course', (address) => saveCourseFromTablet(input, { clientAddress: address }));
}

export async function editPetProfileFromTabletAction(input: Request & { petId: string; name?: string; vetName?: string | null; vetClinic?: string | null; vetPhone?: string | null; weightUnit?: string }) {
  return run('Tablet pet profile', (address) => editPetProfileFromTablet(input, { clientAddress: address }));
}

export async function saveMealPlanFromTabletAction(input: Request & { petId: string; rows: unknown[] }) {
  return run('Tablet meal plan', (address) => saveMealPlanFromTablet(input, { clientAddress: address }));
}

export async function deletePetFromTabletAction(input: Request & { petId: string }) {
  return run('Tablet pet delete', (address) => deletePetFromTablet(input, { clientAddress: address }));
}
