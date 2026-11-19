'use client';

import { collection } from 'firebase/firestore';
import { deleteObject, getDownloadURL, getStorage, ref, uploadBytes } from 'firebase/storage';
import { deletePetAction } from '@/app/pets/actions';
import { getAiActionContext } from '@/ai/client';
import { db } from '@/lib/firebase';
import { getDocsOfflineAware } from '@/lib/firestore-offline';
import { ownedPhotoPath, petPhotoFolder } from '@/lib/pets/profile';
import { runCreatePet, runUpdatePet, type MealConfirmer, type PetProfileFields } from '@/lib/pets/profile-transaction';
import type { PetPhotoChoice } from './pet-photo-draft';

export type { MealConfirmer } from '@/lib/pets/profile-transaction';
export { newPetId } from '@/lib/pets/profile';

const EXTENSIONS: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };

/**
 * Uploads an already shrunk photo (`usePetPhotoDraft`, PE-21e) into the pet's own
 * folder (`households/{h}/pets/{petId}/<uuid>.<ext>`), so it can later be
 * deleted as that pet's photo and never as another's.
 */
async function uploadPetPhoto(householdId: string, petId: string, file: File): Promise<{ url: string; path: string }> {
  const extension = EXTENSIONS[file.type] ?? file.name.split('.').pop()?.toLowerCase().replace(/[^a-z0-9]/g, '') ?? 'jpg';
  const path = `${petPhotoFolder(householdId, petId)}${crypto.randomUUID()}.${extension || 'jpg'}`;
  const storageRef = ref(getStorage(), path);
  await uploadBytes(storageRef, file, file.type ? { contentType: file.type } : undefined);
  return { url: await getDownloadURL(storageRef), path };
}

/** Removes a Storage object, ignoring one that is already gone; other failures are logged (the pet is saved either way). */
async function removeObject(path: string): Promise<void> {
  try {
    await deleteObject(ref(getStorage(), path));
  } catch (error) {
    if ((error as { code?: string })?.code !== 'storage/object-not-found') console.warn('Could not remove an unused pet photo', error);
  }
}

/**
 * Deletes the photo a save replaced or removed (PE-21f), only after the pet
 * document no longer references it, and only when it is this pet's own: in its
 * folder, or a legacy photo in the household's pets folder that no other pet
 * references (a fresh read of the pets). Never a placeholder or another pet's.
 */
async function deleteReplacedPhoto(householdId: string, petId: string, url: string): Promise<void> {
  const bucket = getStorage().app.options.storageBucket ?? null;
  const own = ownedPhotoPath(url, { householdId, petId, bucket });
  if (!own) return;
  if (!own.startsWith(petPhotoFolder(householdId, petId))) {
    const pets = await getDocsOfflineAware(collection(db, 'households', householdId, 'pets'));
    const others = pets.docs.filter((pet) => pet.id !== petId).map((pet) => pet.get('photoUrl') as unknown);
    if (!ownedPhotoPath(url, { householdId, petId, bucket, otherPetPhotoUrls: others })) return;
  }
  await removeObject(own);
}

/**
 * Creates a pet under `petId` (`newPetId`, one per Add dialog). A photo is
 * uploaded first; if the pet then cannot be saved the upload is removed again.
 */
export async function createPet(householdId: string, petId: string, fields: PetProfileFields, photoFile: File | null, confirmer?: MealConfirmer): Promise<void> {
  const uploaded = photoFile ? await uploadPetPhoto(householdId, petId, photoFile) : null;
  try {
    await runCreatePet(db, { householdId, petId, fields, photoUrl: uploaded?.url ?? '', confirmer });
  } catch (error) {
    if (uploaded) await removeObject(uploaded.path);
    throw error;
  }
}

/**
 * Updates a pet (rename, vet, weight unit, schedule, photo). A replaced or
 * removed photo is deleted only after the new document is saved; a new upload
 * whose save failed is removed.
 */
export async function updatePet(
  householdId: string,
  petId: string,
  fields: PetProfileFields,
  photo: PetPhotoChoice,
  originalName: string,
  confirmer?: MealConfirmer,
): Promise<void> {
  const uploaded = photo.kind === 'replace' ? await uploadPetPhoto(householdId, petId, photo.file) : null;
  const photoUrl = uploaded ? uploaded.url : photo.kind === 'remove' ? '' : null;
  let replaced: string | null;
  try {
    ({ replacedPhotoUrl: replaced } = await runUpdatePet(db, { householdId, petId, fields, photoUrl, originalName, confirmer }));
  } catch (error) {
    if (uploaded) await removeObject(uploaded.path);
    throw error;
  }
  if (replaced) await deleteReplacedPhoto(householdId, petId, replaced);
}

/** Deletes a pet and everything that belongs to it, on the server (D-P12). */
export async function deletePet(householdId: string, petId: string): Promise<'deleted' | 'already'> {
  const result = await deletePetAction({ ...(await getAiActionContext(householdId)), petId });
  if (!result.ok) throw new Error(result.message);
  return result.status;
}
