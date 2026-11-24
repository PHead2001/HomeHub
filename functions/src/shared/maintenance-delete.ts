// Deleting a maintenance record with its files (MA-22, MA-4c): a home asset,
// a vehicle or a maintenance log, together with the record's OWN attachments
// (Storage objects and metadata), in one confirmed operation. Shared by the
// web app's server action (src/lib/server/maintenance-delete.ts binds the
// Timestamp) and the hourly upkeep (../index.ts), which resumes a delete that
// stopped part-way (`resumeMaintenanceDeletions`). The caller checks the
// permission (`maintenance.delete`).
//
// Order, so a crash at any point can be resumed by running it again:
// 1. One transaction reads the record and, when it exists, writes a tombstone
//    (`households/{h}/maintenance-deletions/{targetType}~{targetId}`: name,
//    who, when) and deletes the record. From then on the rules refuse new
//    attachment metadata for it (they require the target) and it is gone from
//    every list and reminder.
// 2. An asset's or vehicle's logs stay as history: each becomes a general log
//    with `formerTargetType`/`formerTargetName` (pages, re-checked). Their
//    attachments (the logs' evidence) are never touched.
// 3. The record's own attachments: Storage objects first (only paths inside
//    the record's own folder), then their metadata, one by one, so a Storage
//    failure leaves metadata only for files that may still exist. Then any
//    object left in the folder (an upload whose metadata never landed).
// 4. Open reminders of an asset or vehicle are resolved.
// 5. The tombstone goes last. A tombstone left behind is finished by a retry
//    of the action or by the next hourly upkeep.
import type {
  DocumentReference, Firestore, QueryDocumentSnapshot, Transaction,
} from "firebase-admin/firestore";

export type MaintenanceDeleteTargetType =
  "home_asset" | "vehicle" | "maintenance_log";

export const MAINTENANCE_DELETE_PAGE_SIZE = 300;
export const MAINTENANCE_DELETE_MAX_PASSES = 5;
/** Upkeep leaves a tombstone this young alone: its delete may still run. */
export const MAINTENANCE_DELETE_RESUME_AFTER_MS = 10 * 60 * 1000;

const REGISTRY_SOURCE_TYPES: Record<"home_asset" | "vehicle", string[]> = {
  home_asset: ["maintenance_asset_schedule", "maintenance_asset_warranty"],
  vehicle: [
    "maintenance_vehicle_service",
    "maintenance_vehicle_registration",
    "maintenance_vehicle_inspection",
  ],
};

const COLLECTION: Record<MaintenanceDeleteTargetType, string> = {
  home_asset: "home-assets",
  vehicle: "vehicles",
  maintenance_log: "maintenance",
};

/**
 * The tombstone id of a record's delete.
 * @param {MaintenanceDeleteTargetType} targetType The record's kind.
 * @param {string} targetId The record's document id.
 * @return {string} The tombstone document id.
 */
export function maintenanceTombstoneId(
  targetType: MaintenanceDeleteTargetType, targetId: string,
): string {
  return `${targetType}~${targetId}`;
}

/**
 * The Storage folder of one record's attachments, with its trailing slash, so
 * `asset-1` never matches `asset-10` and a log's folder is never an asset's.
 * @param {string} householdId The household.
 * @param {MaintenanceDeleteTargetType} targetType The record's kind.
 * @param {string} targetId The record's document id.
 * @return {string} The folder prefix.
 */
export function maintenanceFileFolder(
  householdId: string, targetType: MaintenanceDeleteTargetType,
  targetId: string,
): string {
  return `households/${householdId}/maintenance/${targetType}/${targetId}/`;
}

/**
 * The Storage objects one attachment owns (the file, its display copy and
 * thumbnail), limited to the record's own folder: a path elsewhere (a forged
 * or legacy value) is never deleted.
 * @param {Record<string, unknown>} attachment The metadata document's data.
 * @param {string} folder The record's folder (`maintenanceFileFolder`).
 * @return {string[]} The paths to delete.
 */
export function attachmentObjectPaths(
  attachment: Record<string, unknown>, folder: string,
): string[] {
  const paths = [attachment.filePath, attachment.displayPath,
    attachment.thumbnailPath];
  return [...new Set(paths.filter((path): path is string =>
    typeof path === "string" && path.startsWith(folder) &&
    !path.slice(folder.length).includes("/") &&
    path.length > folder.length))];
}

/**
 * Whether a log belongs to the deleted asset or vehicle (as the page reads
 * it: an older log without `targetType` is linked by its id).
 * @param {Record<string, unknown>} log The log's data.
 * @param {string} targetType The deleted record's kind.
 * @param {string} targetId The deleted record's id.
 * @return {boolean} True when the log is the record's history.
 */
export function logBelongsTo(
  log: Record<string, unknown>, targetType: "home_asset" | "vehicle",
  targetId: string,
): boolean {
  const field = targetType === "home_asset" ? "assetId" : "vehicleId";
  if (log[field] !== targetId) return false;
  if (log.targetType === targetType) return true;
  if (log.targetType !== undefined && log.targetType !== null) return false;
  // Legacy: no targetType; a vehicle id wins over an asset id.
  return targetType === "vehicle" || typeof log.vehicleId !== "string";
}

/**
 * Whether a reminder notification belongs to the deleted asset or vehicle.
 * @param {Record<string, unknown>} note The notification's data.
 * @param {string} targetType The deleted record's kind.
 * @param {string} targetId The deleted record's id.
 * @return {boolean} True for an open reminder of that record.
 */
export function reminderBelongsTo(
  note: Record<string, unknown>, targetType: "home_asset" | "vehicle",
  targetId: string,
): boolean {
  const sourceId = note.sourceId;
  return !note.resolvedAt &&
    REGISTRY_SOURCE_TYPES[targetType].includes(String(note.sourceType)) &&
    typeof sourceId === "string" &&
    (sourceId === targetId || sourceId.startsWith(`${targetId}:`));
}

type StorageObject = {
  name: string;
  delete(options?: {ignoreNotFound?: boolean}): Promise<unknown>;
};
/** The bucket operations used here (the Admin SDK bucket, or a double). */
export type MaintenanceFileBucket = {
  getFiles(options: {prefix: string}):
    Promise<[StorageObject[], ...unknown[]]>;
  file(path: string): {
    delete(options?: {ignoreNotFound?: boolean}): Promise<unknown>;
  };
};

export type MaintenanceDeleteActor = {uid: string; name?: string | null};

export type MaintenanceDeleteInput = {
  householdId: string;
  targetType: MaintenanceDeleteTargetType;
  targetId: string;
  actor: MaintenanceDeleteActor;
  now: Date;
  /** Converts a Date to a Firestore Timestamp (the caller's SDK copy). */
  ts: (d: Date) => unknown;
  /** The caller's FieldValue.delete() (each package has its own SDK copy). */
  fieldDelete: unknown;
  /**
   * Upkeep's resume: never delete a record. A record that exists again under
   * a tombstone's id is left alone and the stale tombstone removed.
   */
  resumeOnly?: boolean;
};

export type MaintenanceDeleteOutcome = {
  /**
   * `deleted`: the record existed and is now gone with its files;
   * `already`: there was no record (a retry or a race); what was left of its
   * delete was finished.
   */
  status: "deleted" | "already";
  /** Attachments (metadata documents) removed. */
  attachments: number;
  /** Storage objects removed. */
  files: number;
  /** Logs kept as general history. */
  logs: number;
  reminders: number;
  skipped?: true;
};

/** Files are kept while Storage cannot be reached: nothing is orphaned. */
export class MaintenanceStorageUnavailable extends Error {
  /** A delete needs Storage to remove the record's files. */
  constructor() {
    super("Storage is not configured; files cannot be deleted");
    this.name = "MaintenanceStorageUnavailable";
  }
}

export type MaintenanceDeleteHooks = {
  /** Runs after the record is gone (step 1). Tests simulate a crash. */
  afterBarrier?: () => Promise<void>;
  /**
   * A registered wall tablet's gate hooks (M8a, `maintenance.log.delete`,
   * `maintenance.record.delete`; as the pet delete): `precheck` is the
   * barrier transaction's first statement (a replay of the same opId writes
   * nothing there; the rest still finishes what is left, and a record that
   * exists again under that id is left alone), `finalize` its last (op
   * ledger entry and the `device.action` activity entry).
   */
  device?: {
    precheck(tx: Transaction): Promise<{replay?: unknown}>;
    finalize(tx: Transaction, existed: boolean, name: string | null): void;
  };
};

const repointLogs = async (
  db: Firestore, household: DocumentReference,
  targetType: "home_asset" | "vehicle", targetId: string, name: string,
  now: Date, fieldDelete: unknown,
): Promise<number> => {
  const field = targetType === "home_asset" ? "assetId" : "vehicleId";
  let count = 0;
  for (let pass = 1; ; pass += 1) {
    const linked = (await household.collection("maintenance")
      .where(field, "==", targetId).get()).docs
      .filter((log) => logBelongsTo(log.data(), targetType, targetId));
    if (linked.length === 0) return count;
    if (pass > MAINTENANCE_DELETE_MAX_PASSES) {
      throw new Error(`Keeping ${linked.length} log(s) as history failed`);
    }
    for (let start = 0; start < linked.length;
      start += MAINTENANCE_DELETE_PAGE_SIZE) {
      const batch = db.batch();
      for (const log of linked.slice(start,
        start + MAINTENANCE_DELETE_PAGE_SIZE)) {
        batch.update(log.ref, {
          targetType: "general",
          [field]: fieldDelete,
          formerTargetType: targetType,
          formerTargetName: name,
          updatedAt: now.toISOString(),
        });
      }
      await batch.commit();
      count += Math.min(MAINTENANCE_DELETE_PAGE_SIZE, linked.length - start);
    }
  }
};

const deleteFiles = async (
  bucket: MaintenanceFileBucket | null, household: DocumentReference,
  input: MaintenanceDeleteInput,
): Promise<{attachments: number; files: number}> => {
  const folder = maintenanceFileFolder(input.householdId, input.targetType,
    input.targetId);
  const own: QueryDocumentSnapshot[] =
    (await household.collection("maintenance-attachments")
      .where("targetType", "==", input.targetType)
      .where("targetId", "==", input.targetId).get()).docs;
  if (!bucket) {
    if (own.length > 0) throw new MaintenanceStorageUnavailable();
    return {attachments: 0, files: 0};
  }
  let files = 0;
  for (const attachment of own) {
    // Objects first: a failure leaves this metadata (and the record's
    // tombstone), so a retry or upkeep finishes it.
    for (const path of attachmentObjectPaths(attachment.data(), folder)) {
      await bucket.file(path).delete({ignoreNotFound: true});
      files += 1;
    }
    await attachment.ref.delete();
  }
  // Anything else in the record's own folder (an upload whose metadata
  // never landed). Never another record's folder: the prefix ends in "/".
  const [left] = await bucket.getFiles({prefix: folder});
  for (const object of left) {
    await object.delete({ignoreNotFound: true});
    files += 1;
  }
  return {attachments: own.length, files};
};

const resolveReminders = async (
  db: Firestore, household: DocumentReference,
  targetType: "home_asset" | "vehicle", targetId: string,
  actor: MaintenanceDeleteActor, stamp: unknown,
): Promise<number> => {
  const open = (await household.collection("notifications")
    .where("sourceType", "in", REGISTRY_SOURCE_TYPES[targetType]).get()).docs
    .filter((note) => reminderBelongsTo(note.data(), targetType, targetId));
  const resolvedBy = {at: stamp, uid: actor.uid,
    displayName: actor.name || "Member"};
  for (let start = 0; start < open.length;
    start += MAINTENANCE_DELETE_PAGE_SIZE) {
    const batch = db.batch();
    for (const note of open.slice(start,
      start + MAINTENANCE_DELETE_PAGE_SIZE)) {
      batch.update(note.ref, {resolvedAt: stamp, resolvedBy});
    }
    await batch.commit();
  }
  return open.length;
};

/**
 * Deletes a maintenance record and its own files (see the file comment).
 * Idempotent and resumable.
 * @param {Firestore} db Admin Firestore.
 * @param {MaintenanceFileBucket | null} bucket The Storage bucket.
 * @param {MaintenanceDeleteInput} input The record, actor and clock.
 * @param {MaintenanceDeleteHooks} hooks Test hooks.
 * @return {Promise<MaintenanceDeleteOutcome>} What was removed.
 */
export async function deleteMaintenanceCascade(
  db: Firestore,
  bucket: MaintenanceFileBucket | null,
  input: MaintenanceDeleteInput,
  hooks: MaintenanceDeleteHooks = {},
): Promise<MaintenanceDeleteOutcome> {
  const household = db.collection("households").doc(input.householdId);
  const recordRef = household.collection(COLLECTION[input.targetType])
    .doc(input.targetId);
  const tombstoneRef = household.collection("maintenance-deletions")
    .doc(maintenanceTombstoneId(input.targetType, input.targetId));

  // 1. Barrier: tombstone + record, in one transaction.
  type Started = {name: string; existed: boolean; skipped?: true};
  const started = await db.runTransaction(async (tx): Promise<Started> => {
    const replay = hooks.device ?
      Boolean((await hooks.device.precheck(tx)).replay) : false;
    const [record, tombstone] =
      await Promise.all([tx.get(recordRef), tx.get(tombstoneRef)]);
    if (!record.exists) {
      const found = {
        name: tombstone.exists ? String(tombstone.get("name") ?? "") : "",
        existed: tombstone.exists,
      };
      if (!replay) {
        hooks.device?.finalize(tx, found.existed, found.name || null);
      }
      return found;
    }
    // Upkeep's resume, or a tablet's retry of a delete already done, while a
    // record exists again under this id: never delete it (a stale tombstone
    // goes).
    if (input.resumeOnly || replay) {
      if (tombstone.exists) tx.delete(tombstoneRef);
      return {name: "", existed: false, skipped: true};
    }
    const name = String(record.get(input.targetType === "home_asset" ?
      "name" : input.targetType === "vehicle" ? "nickname" : "title") ??
      record.get("item") ?? "");
    tx.set(tombstoneRef, {
      targetType: input.targetType,
      targetId: input.targetId,
      name,
      byUid: input.actor.uid,
      byName: input.actor.name ?? null,
      startedAt: input.now.toISOString(),
    });
    tx.delete(recordRef);
    hooks.device?.finalize(tx, true, name || null);
    return {name, existed: true};
  });
  if (started.skipped) {
    return {status: "already", attachments: 0, files: 0, logs: 0,
      reminders: 0, skipped: true};
  }
  await hooks.afterBarrier?.();

  // 2. History stays (asset, vehicle).
  const registry = input.targetType === "maintenance_log" ?
    null : input.targetType;
  const logs = registry ? await repointLogs(db, household, registry,
    input.targetId, started.name, input.now, input.fieldDelete) : 0;
  // 3. The record's own files.
  const {attachments, files} = await deleteFiles(bucket, household, input);
  // 4. Reminders.
  const reminders = registry ? await resolveReminders(db, household,
    registry, input.targetId, input.actor, input.ts(input.now)) : 0;
  // 5. Done.
  await tombstoneRef.delete();
  return {status: started.existed ? "deleted" : "already", attachments,
    files, logs, reminders};
}

export type MaintenanceDeletionSweep = {
  found: number; resumed: number; skipped: number; failed: number;
};

/**
 * Hourly upkeep: finishes every maintenance delete that stopped after its
 * record was gone (its tombstone is still there). A tombstone younger than
 * `MAINTENANCE_DELETE_RESUME_AFTER_MS` is left to its own run; a household
 * being deleted is left to its own delete. Each tombstone is isolated.
 * @param {Firestore} db Admin Firestore.
 * @param {MaintenanceFileBucket | null} bucket The Storage bucket.
 * @param {Date} now The run's instant.
 * @param {Function} ts Converts a Date to a Firestore Timestamp.
 * @param {unknown} fieldDelete The caller's FieldValue.delete().
 * @param {Function} onError Told about each failed tombstone.
 * @return {Promise<MaintenanceDeletionSweep>} What was found and done.
 */
export async function resumeMaintenanceDeletions(
  db: Firestore,
  bucket: MaintenanceFileBucket | null,
  now: Date,
  ts: (d: Date) => unknown,
  fieldDelete: unknown,
  onError: (path: string, error: unknown) => void = () => undefined,
): Promise<MaintenanceDeletionSweep> {
  const result: MaintenanceDeletionSweep = {found: 0, resumed: 0, skipped: 0,
    failed: 0};
  const tombstones = await db.collectionGroup("maintenance-deletions").get();
  for (const tombstone of tombstones.docs) {
    const household = tombstone.ref.parent.parent;
    if (!household || household.parent.id !== "households") continue;
    result.found += 1;
    const startedAt = Date.parse(String(tombstone.get("startedAt") ?? ""));
    if (Number.isFinite(startedAt) &&
      now.getTime() - startedAt < MAINTENANCE_DELETE_RESUME_AFTER_MS) {
      result.skipped += 1;
      continue;
    }
    const targetType = tombstone.get("targetType");
    const targetId = tombstone.get("targetId");
    if (!(targetType in COLLECTION) || typeof targetId !== "string" ||
      !targetId || targetId.includes("/")) {
      result.failed += 1;
      onError(tombstone.ref.path, new Error("Malformed tombstone"));
      continue;
    }
    try {
      const house = await household.get();
      if (!house.exists || house.get("deletingAt")) {
        result.skipped += 1;
        continue;
      }
      const byUid = tombstone.get("byUid");
      const byName = tombstone.get("byName");
      await deleteMaintenanceCascade(db, bucket, {
        householdId: household.id,
        targetType: targetType as MaintenanceDeleteTargetType,
        targetId,
        actor: {
          uid: typeof byUid === "string" ? byUid : "system",
          name: typeof byName === "string" ? byName : null,
        },
        now,
        ts,
        fieldDelete,
        resumeOnly: true,
      });
      result.resumed += 1;
    } catch (error) {
      result.failed += 1;
      onError(tombstone.ref.path, error);
    }
  }
  return result;
}
