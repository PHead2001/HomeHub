import 'server-only';

import { FieldValue, Timestamp, type Firestore } from 'firebase-admin/firestore';
import {
  deleteMaintenanceCascade as runCascade,
  type MaintenanceDeleteHooks,
  type MaintenanceDeleteOutcome,
  type MaintenanceDeleteTargetType,
  type MaintenanceFileBucket,
} from '../../../functions/src/shared/maintenance-delete';

/**
 * Deleting a home asset, vehicle or maintenance log with its own files (MA-22, MA-4c) on the
 * web app's server. The cascade (tombstone barrier, logs kept as history, the record's files
 * and metadata, reminders, tombstone last) lives in functions/src/shared/maintenance-delete.ts
 * so the hourly upkeep can resume a delete that stopped part-way. This binds the web app's
 * Timestamp, FieldValue and clock. The caller checks `maintenance.delete`.
 */
export {
  MaintenanceStorageUnavailable,
  attachmentObjectPaths,
  maintenanceFileFolder,
  maintenanceTombstoneId,
} from '../../../functions/src/shared/maintenance-delete';
export type { MaintenanceDeleteOutcome, MaintenanceDeleteTargetType, MaintenanceFileBucket } from '../../../functions/src/shared/maintenance-delete';

export async function deleteMaintenanceRecordCascade(
  db: Firestore,
  bucket: MaintenanceFileBucket | null,
  input: { householdId: string; targetType: MaintenanceDeleteTargetType; targetId: string; actor: { uid: string; name?: string | null }; now?: Date },
  hooks: MaintenanceDeleteHooks = {},
): Promise<MaintenanceDeleteOutcome> {
  return runCascade(db, bucket, {
    ...input,
    now: input.now ?? new Date(),
    ts: (d) => Timestamp.fromDate(d),
    fieldDelete: FieldValue.delete(),
  }, hooks);
}
