'use client';

import { collection, deleteDoc, deleteField, doc, runTransaction, serverTimestamp, setDoc, updateDoc } from 'firebase/firestore';
import { getDownloadURL, getStorage, ref, uploadBytes } from 'firebase/storage';
import { db } from '@/lib/firebase';
import { householdToday } from '@/lib/household-day';
import { confirmMealPlan } from '@/lib/pets/meal-plan';
import type { PetProfile } from '@/lib/pets/types';
import { slugify } from '@/lib/utils';
import type { PetFields } from './pet-form';

/** Legacy "no photo" value; readers treat it (and empty) as no photo. */
export const NO_PHOTO_URL = 'https://placehold.co/300x300.png';

/** Who confirms a meal plan (the signed-in member, rules: the writer) and the household zone ("today"). */
export type MealConfirmer = { uid: string; name: string; timeZone?: string | null };

async function uploadPetPhoto(householdId: string, photoFile: File): Promise<string> {
  const extension = photoFile.name.split('.').pop();
  const storageRef = ref(getStorage(), `households/${householdId}/pets/${crypto.randomUUID()}.${extension}`);
  await uploadBytes(storageRef, photoFile);
  return getDownloadURL(storageRef);
}

/** The confirmation stamp of a plan: server time and the confirming member (rules check both). */
const confirmation = (by: MealConfirmer) => ({ confirmedAt: serverTimestamp(), confirmedByUid: by.uid, confirmedByName: by.name });

/** Creates a pet. Optional numbers are omitted when blank. With meal times the plan starts today (household day). Returns the new id. */
export async function createPet(householdId: string, fields: PetFields, photoFile: File | null, confirmer?: MealConfirmer): Promise<string> {
  if (fields.slots && !confirmer) throw new Error('meal-plan-confirmer-missing');
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
  if (fields.slots && confirmer) {
    // A new pet has no earlier plan to keep; the count and portion follow the plan for older clients.
    data.mealPlan = { slots: fields.slots, effectiveFrom: householdToday(confirmer.timeZone), ...confirmation(confirmer) };
    data.feedingsPerDay = fields.slots.length;
    data.portionAmount = fields.slots[0].amount;
    data.portionUnit = fields.slots[0].unit;
  } else {
    if (fields.feedingsPerDay) data.feedingsPerDay = fields.feedingsPerDay;
    if (fields.portionAmount) {
      data.portionAmount = fields.portionAmount;
      data.portionUnit = fields.portionUnit;
    }
  }
  await setDoc(doc(petsCollection, petId), data);
  return petId;
}

/**
 * Updates a pet; cleared optional numbers are removed from the document. With
 * meal times (PE-22k) the plan is confirmed in a transaction over the stored
 * pet, so the plan it replaces is kept in `mealPlanHistory` exactly as stored
 * even when someone else edited it meanwhile (`confirmMealPlan`, PE-22g); an
 * unchanged plan is left alone. Online only for a plan change (a transaction).
 */
export async function updatePet(
  householdId: string,
  petId: string,
  fields: PetFields,
  photo: { file: File | null; removed: boolean; currentUrl: string },
  confirmer?: MealConfirmer,
): Promise<void> {
  if (fields.slots && !confirmer) throw new Error('meal-plan-confirmer-missing');
  let photoUrl = photo.currentUrl || NO_PHOTO_URL;
  if (photo.file) photoUrl = await uploadPetPhoto(householdId, photo.file);
  else if (photo.removed) photoUrl = NO_PHOTO_URL;
  const petRef = doc(db, 'households', householdId, 'pets', petId);
  const base = { type: fields.type, dataAiHint: fields.dataAiHint, foodSchedule: fields.foodSchedule, photoUrl };
  if (!fields.slots || !confirmer) {
    await updateDoc(petRef, {
      ...base,
      feedingsPerDay: fields.feedingsPerDay ?? deleteField(),
      portionAmount: fields.portionAmount ?? deleteField(),
      portionUnit: fields.portionAmount ? fields.portionUnit : deleteField(),
    });
    return;
  }
  const slots = fields.slots;
  await runTransaction(db, async (tx) => {
    const snapshot = await tx.get(petRef);
    if (!snapshot.exists()) throw new Error('pet-not-found');
    const confirmed = confirmMealPlan(snapshot.data() as PetProfile, slots, householdToday(confirmer.timeZone));
    tx.update(petRef, {
      ...base,
      ...(confirmed
        ? {
            mealPlan: { ...confirmed.mealPlan, ...confirmation(confirmer) },
            mealPlanHistory: confirmed.mealPlanHistory,
            feedingsPerDay: confirmed.feedingsPerDay,
            portionAmount: confirmed.portionAmount,
            portionUnit: confirmed.portionUnit,
          }
        : {}),
    });
  });
}

export async function deletePet(householdId: string, petId: string): Promise<void> {
  await deleteDoc(doc(db, 'households', householdId, 'pets', petId));
}
