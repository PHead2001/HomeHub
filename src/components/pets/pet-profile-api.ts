'use client';

import { collection, deleteDoc, deleteField, doc, setDoc, updateDoc } from 'firebase/firestore';
import { getDownloadURL, getStorage, ref, uploadBytes } from 'firebase/storage';
import { v4 as uuidv4 } from 'uuid';
import { db } from '@/lib/firebase';
import { slugify } from '@/lib/utils';
import type { PetFields } from './pet-form';

/** Legacy "no photo" value; readers treat it (and empty) as no photo. */
export const NO_PHOTO_URL = 'https://placehold.co/300x300.png';

async function uploadPetPhoto(householdId: string, photoFile: File): Promise<string> {
  const extension = photoFile.name.split('.').pop();
  const storageRef = ref(getStorage(), `households/${householdId}/pets/${uuidv4()}.${extension}`);
  await uploadBytes(storageRef, photoFile);
  return getDownloadURL(storageRef);
}

/** Creates a pet. Optional numbers are omitted when blank. Returns the new id. */
export async function createPet(householdId: string, fields: PetFields, photoFile: File | null): Promise<string> {
  const petsCollection = collection(db, 'households', householdId, 'pets');
  const petId = slugify(fields.name);
  const photoUrl = photoFile ? await uploadPetPhoto(householdId, photoFile) : NO_PHOTO_URL;
  const data: Record<string, unknown> = {
    name: fields.name,
    type: fields.type,
    dataAiHint: fields.dataAiHint,
    foodSchedule: fields.foodSchedule,
    photoUrl,
  };
  if (fields.feedingsPerDay) data.feedingsPerDay = fields.feedingsPerDay;
  if (fields.portionAmount) {
    data.portionAmount = fields.portionAmount;
    data.portionUnit = fields.portionUnit;
  }
  await setDoc(doc(petsCollection, petId), data);
  return petId;
}

/** Updates a pet; cleared optional numbers are removed from the document. */
export async function updatePet(
  householdId: string,
  petId: string,
  fields: PetFields,
  photo: { file: File | null; removed: boolean; currentUrl: string },
): Promise<void> {
  let photoUrl = photo.currentUrl || NO_PHOTO_URL;
  if (photo.file) photoUrl = await uploadPetPhoto(householdId, photo.file);
  else if (photo.removed) photoUrl = NO_PHOTO_URL;
  await updateDoc(doc(db, 'households', householdId, 'pets', petId), {
    type: fields.type,
    dataAiHint: fields.dataAiHint,
    foodSchedule: fields.foodSchedule,
    photoUrl,
    feedingsPerDay: fields.feedingsPerDay ?? deleteField(),
    portionAmount: fields.portionAmount ?? deleteField(),
    portionUnit: fields.portionAmount ? fields.portionUnit : deleteField(),
  });
}

export async function deletePet(householdId: string, petId: string): Promise<void> {
  await deleteDoc(doc(db, 'households', householdId, 'pets', petId));
}
