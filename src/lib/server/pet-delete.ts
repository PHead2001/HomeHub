import 'server-only';

import { Timestamp, type DocumentReference, type Firestore } from 'firebase-admin/firestore';
import { ownedPhotoPath, petPhotoFolder } from '@/lib/pets/profile';

/**
 * Deleting a pet (D-P12, PE-21f, PE-30d): the pet document and everything under
 * it, its photos, and its open reminders, run on the server with the Admin SDK.
 * The decisions are reusable by a registered-tablet device action (F4): this
 * function takes the database, the bucket and the verified actor; the caller
 * checks the permission (`PET_ACTION_PERMISSIONS['pets.profile.delete']`).
 *
 * Order, so a crash at any point can be resumed by running it again:
 * 1. One transaction reads the pet and, when it exists, writes a tombstone
 *    (`households/{h}/pet-deletions/{petId}`: the photo URL, the name, who and
 *    when), the activity-log entry (`pet.deleted`), and deletes the pet
 *    document. From then on the rules refuse new notes and weights under it
 *    (they require the pet) and the pet is gone from every list and reminder.
 * 2. Every subcollection under the pet (feedings, feeding state, medication
 *    logs and courses, care logs, notes, weights, and any other) is deleted in
 *    pages of at most `PAGE_SIZE` (a long history never exceeds a batch), and
 *    re-checked until nothing is left (`MAX_PASSES`).
 * 3. Photos: every object in the pet's own folder, and the stored photo URL
 *    when it is the pet's own (a legacy photo in the household's pets folder
 *    that no other pet references); never a placeholder or another pet's photo.
 * 4. Open medication reminders of the pet are resolved (`resolvedAt`), as upkeep
 *    does when a pet is gone, so none stays in the bell until the next run.
 * 5. The tombstone is removed. Running it again after any step repeats only
 *    what is left: a pet that is already gone with no tombstone still has its
 *    subcollections, folder and reminders swept (nothing to do in the end).
 */

export const PET_DELETE_PAGE_SIZE = 300;
export const PET_DELETE_MAX_PASSES = 5;
const MEDICATION_SOURCE_TYPE = 'pet_medication';

export type PetDeleteActor = { uid: string; email?: string | null; name?: string | null };
export type PetDeleteOutcome = {
  /** `deleted`: the pet existed and is now gone with everything under it; `already`: there was no pet to delete (a retry or a race), and anything left under it was swept. */
  status: 'deleted' | 'already';
  documents: number;
  photos: number;
  reminders: number;
};

export class PetDeleteIncomplete extends Error {
  constructor(readonly left: number) {
    super(`Deleting a pet left ${left} document(s) behind`);
    this.name = 'PetDeleteIncomplete';
  }
}

/** The bucket operations used here (the Admin SDK bucket, or a test double). */
export type PetPhotoBucket = {
  name: string;
  getFiles(options: { prefix: string }): Promise<[Array<{ name: string; delete(options?: { ignoreNotFound?: boolean }): Promise<unknown> }>, ...unknown[]]>;
  file(path: string): { delete(options?: { ignoreNotFound?: boolean }): Promise<unknown> };
};

type Hooks = {
  /** Runs after the pet document is gone (step 1), before the sweep. Tests use it to simulate a crash or a late write. */
  afterBarrier?: () => Promise<void>;
};

/**
 * Deletes every document under the pet's path, page by page: each top-level
 * subcollection in pages of `PET_DELETE_PAGE_SIZE` (one batch each, so a long
 * history never exceeds a batch), then anything nested deeper (none today) with
 * the Admin SDK's recursive delete. Returns how many top-level documents went.
 */
async function sweepUnder(db: Firestore, ref: DocumentReference): Promise<number> {
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
  // Nested documents under deleted entries are invisible to the pages above (the pet document itself is never touched here).
  for (const collection of await ref.listCollections()) await db.recursiveDelete(collection);
  return count;
}

async function countUnder(ref: DocumentReference): Promise<number> {
  let left = 0;
  for (const collection of await ref.listCollections()) {
    left += (await collection.limit(1).select().get()).size;
  }
  return left;
}

/** Resolves the pet's open medication reminders (their source id starts with `<petId>:`). */
async function resolveReminders(db: Firestore, household: DocumentReference, petId: string, now: Date): Promise<number> {
  const open = (await household.collection('notifications').where('sourceType', '==', MEDICATION_SOURCE_TYPE).get()).docs
    .filter((note) => !note.get('resolvedAt') && typeof note.get('sourceId') === 'string' && (note.get('sourceId') as string).startsWith(`${petId}:`));
  let resolved = 0;
  for (let start = 0; start < open.length; start += PET_DELETE_PAGE_SIZE) {
    const batch = db.batch();
    for (const note of open.slice(start, start + PET_DELETE_PAGE_SIZE)) {
      batch.update(note.ref, { resolvedAt: Timestamp.fromDate(now) });
      resolved += 1;
    }
    await batch.commit();
  }
  return resolved;
}

async function deletePhotos(bucket: PetPhotoBucket | null, db: Firestore, household: DocumentReference, householdId: string, petId: string, photoUrl: unknown): Promise<number> {
  if (!bucket) return 0;
  let deleted = 0;
  const [files] = await bucket.getFiles({ prefix: petPhotoFolder(householdId, petId) });
  for (const file of files) {
    await file.delete({ ignoreNotFound: true });
    deleted += 1;
  }
  // A legacy photo directly in the household's pets folder: only when no other pet uses it.
  const others = (await household.collection('pets').select('photoUrl').get()).docs
    .filter((pet) => pet.id !== petId)
    .map((pet) => pet.get('photoUrl'));
  const legacy = ownedPhotoPath(photoUrl, { householdId, petId, bucket: bucket.name, otherPetPhotoUrls: others });
  if (legacy && !legacy.startsWith(petPhotoFolder(householdId, petId))) {
    await bucket.file(legacy).delete({ ignoreNotFound: true });
    deleted += 1;
  }
  return deleted;
}

export async function deletePetCascade(
  db: Firestore,
  bucket: PetPhotoBucket | null,
  input: { householdId: string; petId: string; actor: PetDeleteActor; now?: Date },
  hooks: Hooks = {},
): Promise<PetDeleteOutcome> {
  const now = input.now ?? new Date();
  const household = db.collection('households').doc(input.householdId);
  const petRef = household.collection('pets').doc(input.petId);
  const tombstoneRef = household.collection('pet-deletions').doc(input.petId);

  // 1. Barrier: tombstone + activity entry + pet document, in one transaction.
  const started = await db.runTransaction(async (transaction) => {
    const [pet, tombstone] = await Promise.all([transaction.get(petRef), transaction.get(tombstoneRef)]);
    if (!pet.exists) return tombstone.exists ? { photoUrl: tombstone.get('photoUrl') as unknown, existed: true } : { photoUrl: null, existed: false };
    const name = typeof pet.get('name') === 'string' ? (pet.get('name') as string) : 'Pet';
    transaction.set(tombstoneRef, {
      petId: input.petId,
      name,
      photoUrl: pet.get('photoUrl') ?? null,
      byUid: input.actor.uid,
      startedAt: now.toISOString(),
    });
    transaction.set(household.collection('auditLogs').doc(), {
      actorUid: input.actor.uid,
      actorEmail: input.actor.email ?? null,
      actorName: input.actor.name ?? null,
      action: 'pet.deleted',
      createdAt: now.toISOString(),
      details: { petId: input.petId, petName: name },
    });
    transaction.delete(petRef);
    return { photoUrl: pet.get('photoUrl') as unknown, existed: true };
  });
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
  const photos = await deletePhotos(bucket, db, household, input.householdId, input.petId, started.photoUrl);
  const reminders = await resolveReminders(db, household, input.petId, now);

  // 5. Done: the tombstone goes last, so an interrupted run is resumed with the photo it recorded.
  await tombstoneRef.delete();
  return { status: started.existed ? 'deleted' : 'already', documents, photos, reminders };
}
