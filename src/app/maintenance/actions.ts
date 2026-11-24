'use server';

import type { HouseholdPermission } from '@/lib/types';
import { authorizeHouseholdAction, exceedsPayloadBudget, type AuthorizedHouseholdUser } from '@/ai/action-auth';
import { HomeHubAiError } from '@/ai/errors';
import { adminDb } from '@/lib/server/firebase-admin';
import { adminStorageBucket } from '@/lib/server/firebase-admin';
import { cleanupOrphanUploadsAs, type CleanupBucket, type CleanupResult } from '@/lib/server/maintenance-files';
import {
  MaintenanceStorageUnavailable,
  deleteMaintenanceRecordCascade,
  type MaintenanceDeleteTargetType,
  type MaintenanceFileBucket,
} from '@/lib/server/maintenance-delete';
import { personalOperationContext } from '@/lib/server/operation-context';
import { publicDisplayName } from '@/lib/member-directory';
import {
  MaintenanceOperationError,
  completeMaintenanceScheduleAs,
  saveHomeAssetAs,
  saveMaintenanceLogAs,
  saveVehicleAs,
  snoozeMaintenanceScheduleAs,
  undoMaintenanceCompletionAs,
  undoMaintenanceSnoozeAs,
  undoVehicleMileageAs,
  updateVehicleMileageAs,
  type CompleteInput,
  type MileageInput,
  type MileageResult,
  type CompleteResult,
  type SaveInput,
  type SaveResult,
  type SnoozeInput,
  type SnoozeResult,
  type UndoResult,
} from '@/lib/server/maintenance-operations';

// Maintenance writes (M1) run here, never as client writes: the server reads the
// authoritative records, patches by stable schedule id and records who did it from
// the verified ID token. Logic: src/lib/server/maintenance-operations.ts.

export type MaintenanceFailureCode = 'unauthenticated' | 'forbidden' | 'invalid' | 'not_found' | 'conflict' | 'too_many_schedules' | 'failed';
export type MaintenanceActionResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: MaintenanceFailureCode; message: string };

type Context = { idToken: string; householdId: string };

const MESSAGES: Record<MaintenanceFailureCode, string> = {
  unauthenticated: 'Your sign-in could not be verified. Sign in again.',
  forbidden: "You don't have permission to do that.",
  invalid: "That wasn't saved: some values aren't valid.",
  not_found: 'That item no longer exists.',
  conflict: 'That request was already used for something else. Try again.',
  too_many_schedules: "That wasn't saved: a record can have at most 100 maintenance items, counting ones someone else added meanwhile. Remove one and save again.",
  failed: "Couldn't save. Try again.",
};

/** Requests are a few KB; anything far larger is refused before any work. */
const MAX_PAYLOAD = 96 * 1024;

// End-to-end tests pin the browser clock; the server follows the same pinned
// instant, but only against the emulator, so production always uses the real time.
const operationNow = () => {
  const configured = process.env.FIRESTORE_EMULATOR_HOST ? process.env.HOMEHUB_TEST_NOW : undefined;
  const parsed = configured ? new Date(configured) : new Date();
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
};

const failure = (code: MaintenanceFailureCode): { ok: false; code: MaintenanceFailureCode; message: string } =>
  ({ ok: false, code, message: MESSAGES[code] });

/**
 * Verifies the caller, requires every permission in `required` (all of them),
 * and runs the operation with the caller as the actor. Fails closed: anything
 * unexpected is `failed` with a user-safe message.
 */
const run = async <T>(
  context: Context,
  payload: unknown,
  required: (input: unknown) => readonly HouseholdPermission[],
  task: (user: AuthorizedHouseholdUser) => Promise<T>,
): Promise<MaintenanceActionResult<T>> => {
  try {
    if (!payload || typeof payload !== 'object' || exceedsPayloadBudget(payload, MAX_PAYLOAD)) return failure('invalid');
    const permissions = required(payload);
    const user = await authorizeHouseholdAction({ idToken: context?.idToken, householdId: context?.householdId }, permissions[0]);
    if (!permissions.every(permission => user.permissions[permission])) return failure('forbidden');
    return { ok: true, data: JSON.parse(JSON.stringify(await task(user))) as T };
  } catch (error) {
    if (error instanceof HomeHubAiError) return failure(error.code === 'unauthenticated' ? 'unauthenticated' : error.code === 'forbidden' ? 'forbidden' : 'failed');
    if (error instanceof MaintenanceOperationError) return failure(error.code);
    console.error('Maintenance action failed', error);
    return failure('failed');
  }
};

const contextOf = (user: AuthorizedHouseholdUser) =>
  // The member's name is read from the membership record inside the operation.
  personalOperationContext({ uid: user.uid, name: '' }, operationNow());

const COMPLETE: readonly HouseholdPermission[] = ['maintenance.edit', 'maintenance.createLogs'];
const EDIT: readonly HouseholdPermission[] = ['maintenance.edit'];

/** Completes one schedule cycle (needs maintenance.edit and maintenance.createLogs). */
export async function completeMaintenanceSchedule(input: Context & { completion: CompleteInput }): Promise<MaintenanceActionResult<CompleteResult>> {
  return run(input, input?.completion, () => COMPLETE, user => completeMaintenanceScheduleAs(adminDb, user.householdId, input.completion, contextOf(user)));
}

/** Undoes the caller's own completion within the Undo window. */
export async function undoMaintenanceCompletion(input: Context & { opId: string }): Promise<MaintenanceActionResult<UndoResult>> {
  return run(input, { opId: input?.opId }, () => COMPLETE, user => undoMaintenanceCompletionAs(adminDb, user.householdId, { opId: input.opId }, contextOf(user)));
}

/** Snoozes one schedule cycle by a week (needs maintenance.edit). */
export async function snoozeMaintenanceSchedule(input: Context & { snooze: SnoozeInput }): Promise<MaintenanceActionResult<SnoozeResult>> {
  return run(input, input?.snooze, () => EDIT, user => snoozeMaintenanceScheduleAs(adminDb, user.householdId, input.snooze, contextOf(user)));
}

/** Undoes the caller's own snooze within the Undo window. */
export async function undoMaintenanceSnooze(input: Context & { opId: string }): Promise<MaintenanceActionResult<UndoResult>> {
  return run(input, { opId: input?.opId }, () => EDIT, user => undoMaintenanceSnoozeAs(adminDb, user.householdId, { opId: input.opId }, contextOf(user)));
}

/** Creates (maintenance.createLogs) or edits (maintenance.edit) a maintenance log. */
export async function saveMaintenanceLog(input: Context & { save: SaveInput }): Promise<MaintenanceActionResult<SaveResult>> {
  return run(
    input,
    input?.save,
    save => ((save as SaveInput).id ? EDIT : ['maintenance.createLogs']),
    user => saveMaintenanceLogAs(adminDb, user.householdId, input.save, contextOf(user)),
  );
}

/** Creates or edits a home asset (maintenance.edit). */
export async function saveHomeAsset(input: Context & { save: SaveInput }): Promise<MaintenanceActionResult<SaveResult>> {
  return run(input, input?.save, () => EDIT, user => saveHomeAssetAs(adminDb, user.householdId, input.save, contextOf(user)));
}

/** Creates or edits a vehicle (maintenance.edit). */
export async function saveVehicle(input: Context & { save: SaveInput }): Promise<MaintenanceActionResult<SaveResult>> {
  return run(input, input?.save, () => EDIT, user => saveVehicleAs(adminDb, user.householdId, input.save, contextOf(user)));
}

/** "Update mileage": an explicit odometer reading (maintenance.edit; a lower one only as a correction). */
export async function updateVehicleMileage(input: Context & { mileage: MileageInput }): Promise<MaintenanceActionResult<MileageResult>> {
  return run(input, input?.mileage, () => EDIT, user => updateVehicleMileageAs(adminDb, user.householdId, input.mileage, contextOf(user)));
}

/** Undoes the caller's own mileage update within the Undo window. */
export async function undoVehicleMileage(input: Context & { opId: string }): Promise<MaintenanceActionResult<UndoResult>> {
  return run(input, { opId: input?.opId }, () => EDIT, user => undoVehicleMileageAs(adminDb, user.householdId, { opId: input.opId }, contextOf(user)));
}

export type DeleteRecordResult = {
  status: 'deleted' | 'already';
  /** Files and logs the delete handled. */
  attachments: number;
  logs: number;
  /**
   * The record is gone but some of its files could not be removed yet; a retry or the hourly
   * upkeep finishes (the database stays consistent meanwhile).
   */
  pending: boolean;
};

const DELETE_TARGETS: readonly MaintenanceDeleteTargetType[] = ['home_asset', 'vehicle', 'maintenance_log'];

/**
 * Deletes a home asset, vehicle or log together with its own attachments (maintenance.delete;
 * MA-22, MA-4c): one confirmed, resumable operation. An asset's or vehicle's logs stay as
 * general history and keep their files. Retrying the same delete finishes what is left.
 */
export async function deleteMaintenanceRecord(
  input: Context & { target: { targetType: MaintenanceDeleteTargetType; targetId: string } },
): Promise<MaintenanceActionResult<DeleteRecordResult>> {
  return run(input, input?.target, () => ['maintenance.delete'], async user => {
    const target = input.target;
    if (!DELETE_TARGETS.includes(target?.targetType) || typeof target.targetId !== 'string'
      || !target.targetId || target.targetId.length > 1500 || target.targetId.includes('/')) {
      throw new MaintenanceOperationError('invalid');
    }
    const member = await adminDb.collection('households').doc(user.householdId).collection('members').doc(user.uid).get();
    const actor = { uid: user.uid, name: publicDisplayName(member.get('displayName')) };
    let afterBarrier = false;
    try {
      const outcome = await deleteMaintenanceRecordCascade(
        adminDb, adminStorageBucket() as unknown as MaintenanceFileBucket | null,
        { householdId: user.householdId, targetType: target.targetType, targetId: target.targetId, actor, now: operationNow() },
        { afterBarrier: async () => { afterBarrier = true; } },
      );
      return { status: outcome.status, attachments: outcome.attachments, logs: outcome.logs, pending: false };
    } catch (error) {
      // Gone from every list already; the tombstone makes a retry or upkeep finish it.
      if (afterBarrier) {
        console.error('Maintenance delete stopped part-way; upkeep will finish it', error instanceof MaintenanceStorageUnavailable ? error.message : error);
        return { status: 'deleted' as const, attachments: 0, logs: 0, pending: true };
      }
      throw error;
    }
  });
}

/**
 * Removes files this member just uploaded whose attachment metadata was refused (MA-11k), for
 * members who may upload but not delete. See src/lib/server/maintenance-files.ts.
 */
export async function cleanupMaintenanceUpload(input: Context & { paths: string[] }): Promise<MaintenanceActionResult<CleanupResult>> {
  try {
    if (!Array.isArray(input?.paths) || exceedsPayloadBudget(input.paths, 8 * 1024)) return failure('invalid');
    const user = await authorizeHouseholdAction({ idToken: input?.idToken, householdId: input?.householdId }, ['maintenance.edit', 'maintenance.createLogs']);
    const result = await cleanupOrphanUploadsAs(adminDb, adminStorageBucket() as unknown as CleanupBucket | null, user.householdId, input.paths, user.uid);
    return { ok: true, data: result };
  } catch (error) {
    if (error instanceof HomeHubAiError) return failure(error.code === 'unauthenticated' ? 'unauthenticated' : error.code === 'forbidden' ? 'forbidden' : 'failed');
    console.error('Maintenance upload cleanup failed', error);
    return failure('failed');
  }
}
