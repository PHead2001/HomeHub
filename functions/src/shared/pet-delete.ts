// Deleting a pet (D-P12, PE-21f, PE-30d): the pet document and everything
// under it, its photos, and its open reminders, run with the Admin SDK. Shared
// by the web app's server action (src/lib/server/pet-delete.ts binds the
// Timestamp) and the hourly upkeep (../index.ts), which resumes a delete that
// stopped part-way (`resumePetDeletions`). Types come from the
// "firebase-admin/firestore" entry point both packages provide (as in
// ../reminders.ts); the caller checks the permission
// (`PET_ACTION_PERMISSIONS['pets.profile.delete']` in the web app).
//
// Order, so a crash at any point can be resumed by running it again:
// 1. One transaction reads the pet and, when it exists, writes a tombstone
//    (`households/{h}/pet-deletions/{petId}`: the photo URL, the name, who
//    and when), the activity-log entry (`pet.deleted`), and deletes the pet
//    document. From then on the rules refuse new logs under it (they require
//    the pet) and the pet is gone from every list and reminder.
// 2. Every subcollection under the pet is deleted in pages of at most
//    `PET_DELETE_PAGE_SIZE`, re-checked until nothing is left
//    (`PET_DELETE_MAX_PASSES`).
// 3. Photos: every object in the pet's own folder, and the stored photo URL
//    when it is the pet's own (a legacy photo in the household's pets folder
//    that no other pet references); never a placeholder or another pet's.
// 4. Open medication reminders of the pet are resolved (`resolvedAt`).
// 5. The tombstone is removed. Running it again after any step repeats only
//    what is left. A tombstone left behind (the server failed after step 1)
//    is finished by a retry of the action or, without one, by the next hourly
//    upkeep (`resumePetDeletions`).
import type {DocumentReference, Firestore} from "firebase-admin/firestore";
import {ownedPhotoPath, petPhotoFolder} from "./pet-photo-path";

export const PET_DELETE_PAGE_SIZE = 300;
export const PET_DELETE_MAX_PASSES = 5;
/** Upkeep leaves a tombstone this young alone: its delete may still run. */
export const PET_DELETE_RESUME_AFTER_MS = 10 * 60 * 1000;
const MEDICATION_SOURCE_TYPE = "pet_medication";

export type PetDeleteActor = {
  uid: string; email?: string | null; name?: string | null;
};
export type PetDeleteOutcome = {
  /**
   * `deleted`: the pet existed and is now gone with everything under it;
   * `already`: there was no pet to delete (a retry or a race), and anything
   * left under it was swept.
   */
  status: "deleted" | "already";
  documents: number;
  photos: number;
  reminders: number;
};

/** The sweep still found documents under the pet after every pass. */
export class PetDeleteIncomplete extends Error {
  /**
   * @param {number} left Documents still found after the last pass.
   */
  constructor(readonly left: number) {
    super(`Deleting a pet left ${left} document(s) behind`);
    this.name = "PetDeleteIncomplete";
  }
}

type StorageObject = {
  name: string;
  delete(options?: {ignoreNotFound?: boolean}): Promise<unknown>;
};
/** The bucket operations used here (the Admin SDK bucket, or a double). */
export type PetPhotoBucket = {
  name: string;
  getFiles(options: {prefix: string}):
    Promise<[StorageObject[], ...unknown[]]>;
  file(path: string): {
    delete(options?: {ignoreNotFound?: boolean}): Promise<unknown>;
  };
};

export type PetDeleteHooks = {
  /**
   * Runs after the pet document is gone (step 1), before the sweep. Tests
   * use it to simulate a crash or a late write.
   */
  afterBarrier?: () => Promise<void>;
};

export type PetDeleteInput = {
  householdId: string;
  petId: string;
  actor: PetDeleteActor;
  now: Date;
  /** Converts a Date to a Firestore Timestamp (the caller's SDK copy). */
  ts: (d: Date) => unknown;
  /**
   * Upkeep's resume: never delete a pet document. A pet that exists again
   * under a tombstone's id is left alone and the stale tombstone removed.
   */
  resumeOnly?: boolean;
};

const sweepUnder = async (
  db: Firestore, ref: DocumentReference,
): Promise<number> => {
  let count = 0;
  for (const collection of await ref.listCollections()) {
    for (;;) {
      const page = await collection.limit(PET_DELETE_PAGE_SIZE).select().get();
      if (page.empty) break;
      const batch = db.batch();
      for (const entry of page.docs) batch.delete(entry.ref);
      await batch.commit();
      count += page.size;
    }
  }
  // Nested documents under deleted entries are invisible to the pages above
  // (the pet document itself is never touched here).
  for (const collection of await ref.listCollections()) {
    await db.recursiveDelete(collection);
  }
  return count;
};

const countUnder = async (ref: DocumentReference): Promise<number> => {
  let left = 0;
  for (const collection of await ref.listCollections()) {
    left += (await collection.limit(1).select().get()).size;
  }
  return left;
};

const resolveReminders = async (
  db: Firestore, household: DocumentReference, petId: string, stamp: unknown,
): Promise<number> => {
  const open = (await household.collection("notifications")
    .where("sourceType", "==", MEDICATION_SOURCE_TYPE).get()).docs
    .filter((note) => !note.get("resolvedAt") &&
      typeof note.get("sourceId") === "string" &&
      (note.get("sourceId") as string).startsWith(`${petId}:`));
  let resolved = 0;
  for (let start = 0; start < open.length; start += PET_DELETE_PAGE_SIZE) {
    const batch = db.batch();
    for (const note of open.slice(start, start + PET_DELETE_PAGE_SIZE)) {
      batch.update(note.ref, {resolvedAt: stamp});
      resolved += 1;
    }
    await batch.commit();
  }
  return resolved;
};

const deletePhotos = async (
  bucket: PetPhotoBucket | null, household: DocumentReference,
  householdId: string, petId: string, photoUrl: unknown,
): Promise<number> => {
  if (!bucket) return 0;
  let deleted = 0;
  const folder = petPhotoFolder(householdId, petId);
  const [files] = await bucket.getFiles({prefix: folder});
  for (const file of files) {
    await file.delete({ignoreNotFound: true});
    deleted += 1;
  }
  // A legacy photo directly in the household's pets folder: only when no
  // other pet uses it.
  const others = (await household.collection("pets").select("photoUrl").get())
    .docs.filter((pet) => pet.id !== petId)
    .map((pet) => pet.get("photoUrl"));
  const legacy = ownedPhotoPath(photoUrl,
    {householdId, petId, bucket: bucket.name, otherPetPhotoUrls: others});
  if (legacy && !legacy.startsWith(folder)) {
    await bucket.file(legacy).delete({ignoreNotFound: true});
    deleted += 1;
  }
  return deleted;
};

/**
 * Deletes a pet and everything that belongs to it (see the file comment).
 * Idempotent and resumable.
 * @param {Firestore} db Admin Firestore.
 * @param {PetPhotoBucket | null} bucket The Storage bucket, when configured.
 * @param {PetDeleteInput} input The household, pet, verified actor and clock.
 * @param {PetDeleteHooks} hooks Test hooks.
 * @return {Promise<PetDeleteOutcome>} What was removed.
 */
export const deletePetCascade = async (
  db: Firestore,
  bucket: PetPhotoBucket | null,
  input: PetDeleteInput,
  hooks: PetDeleteHooks = {},
): Promise<PetDeleteOutcome & {skipped?: true}> => {
  const household = db.collection("households").doc(input.householdId);
  const petRef = household.collection("pets").doc(input.petId);
  const tombstoneRef = household.collection("pet-deletions").doc(input.petId);

  // 1. Barrier: tombstone + activity entry + pet document, in one
  // transaction.
  type Started = {photoUrl: unknown; existed: boolean; skipped?: true};
  const started = await db.runTransaction(async (tx): Promise<Started> => {
    const [pet, tombstone] =
      await Promise.all([tx.get(petRef), tx.get(tombstoneRef)]);
    if (!pet.exists) {
      return tombstone.exists ?
        {photoUrl: tombstone.get("photoUrl") as unknown, existed: true} :
        {photoUrl: null, existed: false};
    }
    if (input.resumeOnly) {
      if (tombstone.exists) tx.delete(tombstoneRef);
      return {photoUrl: null, existed: false, skipped: true};
    }
    const name = typeof pet.get("name") === "string" ?
      (pet.get("name") as string) : "Pet";
    tx.set(tombstoneRef, {
      petId: input.petId,
      name,
      photoUrl: pet.get("photoUrl") ?? null,
      byUid: input.actor.uid,
      startedAt: input.now.toISOString(),
    });
    tx.set(household.collection("auditLogs").doc(), {
      actorUid: input.actor.uid,
      actorEmail: input.actor.email ?? null,
      actorName: input.actor.name ?? null,
      action: "pet.deleted",
      createdAt: input.now.toISOString(),
      details: {petId: input.petId, petName: name},
    });
    tx.delete(petRef);
    return {photoUrl: pet.get("photoUrl") as unknown, existed: true};
  });
  if (started.skipped) {
    return {status: "already", documents: 0, photos: 0, reminders: 0,
      skipped: true};
  }
  await hooks.afterBarrier?.();

  // 2. Everything under the pet, page by page, re-checked.
  let documents = 0;
  for (let pass = 1; ; pass += 1) {
    documents += await sweepUnder(db, petRef);
    const left = await countUnder(petRef);
    if (left === 0) break;
    if (pass >= PET_DELETE_MAX_PASSES) throw new PetDeleteIncomplete(left);
  }

  // 3. Photos, 4. reminders.
  const photos = await deletePhotos(bucket, household, input.householdId,
    input.petId, started.photoUrl);
  const reminders = await resolveReminders(db, household, input.petId,
    input.ts(input.now));

  // 5. Done: the tombstone goes last, so an interrupted run is resumed with
  // the photo it recorded.
  await tombstoneRef.delete();
  return {status: started.existed ? "deleted" : "already",
    documents, photos, reminders};
};

export type PetDeletionSweep = {
  found: number; resumed: number; skipped: number; failed: number;
};

/**
 * Hourly upkeep: finishes every pet delete that stopped after its pet
 * document was gone (its tombstone is still there), so histories, photos and
 * reminders never outlive a failed delete nobody retried. A tombstone younger
 * than `PET_DELETE_RESUME_AFTER_MS` is left to its own run; a household being
 * deleted is left to its own delete. Each tombstone is isolated: one failure
 * is counted and the rest still run (the next hour tries it again).
 * @param {Firestore} db Admin Firestore.
 * @param {PetPhotoBucket | null} bucket The Storage bucket, when configured.
 * @param {Date} now The run's instant.
 * @param {Function} ts Converts a Date to a Firestore Timestamp.
 * @param {Function} onError Told about each failed tombstone.
 * @return {Promise<PetDeletionSweep>} What was found and done.
 */
export const resumePetDeletions = async (
  db: Firestore,
  bucket: PetPhotoBucket | null,
  now: Date,
  ts: (d: Date) => unknown,
  onError: (path: string, error: unknown) => void = () => undefined,
): Promise<PetDeletionSweep> => {
  const result: PetDeletionSweep = {found: 0, resumed: 0, skipped: 0,
    failed: 0};
  const tombstones = await db.collectionGroup("pet-deletions").get();
  for (const tombstone of tombstones.docs) {
    const household = tombstone.ref.parent.parent;
    if (!household || household.parent.id !== "households") continue;
    result.found += 1;
    const startedAt = Date.parse(String(tombstone.get("startedAt") ?? ""));
    if (Number.isFinite(startedAt) &&
      now.getTime() - startedAt < PET_DELETE_RESUME_AFTER_MS) {
      result.skipped += 1;
      continue;
    }
    try {
      const house = await household.get();
      if (!house.exists || house.get("deletingAt")) {
        result.skipped += 1;
        continue;
      }
      const byUid = tombstone.get("byUid");
      await deletePetCascade(db, bucket, {
        householdId: household.id,
        petId: tombstone.id,
        actor: {uid: typeof byUid === "string" ? byUid : "system"},
        now,
        ts,
        resumeOnly: true,
      });
      result.resumed += 1;
    } catch (error) {
      result.failed += 1;
      onError(tombstone.ref.path, error);
    }
  }
  return result;
};
