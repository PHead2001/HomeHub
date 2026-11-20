import 'server-only';

import { Timestamp, type Firestore } from 'firebase-admin/firestore';
import {
  deletePetCascade as runCascade,
  type PetDeleteActor,
  type PetDeleteHooks,
  type PetDeleteOutcome,
  type PetPhotoBucket,
} from '../../../functions/src/shared/pet-delete';

/**
 * Deleting a pet (D-P12, PE-21f, PE-30d) on the web app's server. The cascade
 * itself (barrier transaction with a tombstone, paged sweep, photos,
 * reminders, tombstone last) lives in functions/src/shared/pet-delete.ts so
 * the hourly upkeep can resume a delete that stopped part-way
 * (`resumePetDeletions`). This binds the web app's Timestamp and clock. The
 * caller checks the permission (`PET_ACTION_PERMISSIONS['pets.profile.delete']`).
 */
export {
  PET_DELETE_MAX_PASSES,
  PET_DELETE_PAGE_SIZE,
  PET_DELETE_RESUME_AFTER_MS,
  PetDeleteIncomplete,
  resumePetDeletions,
} from '../../../functions/src/shared/pet-delete';
export type { PetDeleteActor, PetDeleteOutcome, PetPhotoBucket } from '../../../functions/src/shared/pet-delete';

export async function deletePetCascade(
  db: Firestore,
  bucket: PetPhotoBucket | null,
  input: { householdId: string; petId: string; actor: PetDeleteActor; now?: Date },
  hooks: PetDeleteHooks = {},
): Promise<PetDeleteOutcome> {
  const { status, documents, photos, reminders } = await runCascade(db, bucket, {
    ...input,
    now: input.now ?? new Date(),
    ts: (d) => Timestamp.fromDate(d),
  }, hooks);
  return { status, documents, photos, reminders };
}

/** Whether a delete of this pet is still unfinished (its tombstone is there). */
export async function petDeletePending(db: Firestore, householdId: string, petId: string): Promise<boolean> {
  return (await db.collection('households').doc(householdId).collection('pet-deletions').doc(petId).get()).exists;
}