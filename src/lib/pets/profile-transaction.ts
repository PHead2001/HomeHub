/**
 * Pet profile writes (create, edit, rename), Firestore side, with the instance
 * passed in so the app (`src/components/pets/pet-profile-api.ts`) and the
 * emulator tests run the same code. Photo uploads stay in the app's API module;
 * these functions take the resulting URL.
 *
 * - **Identity (PE-30b).** A new pet's id is random (`newPetId`), taken once per
 *   Add dialog, so a double submit or a retry writes the same pet and two pets
 *   with the same name never share a document. A rename changes only `name`:
 *   the id, and every history under it (feedings, medication, care, notes,
 *   weights), stays. Everything that shows or matches a pet's name (cards,
 *   dashboard, palette quick add, Calendar, the medication reminders' stored
 *   titles, refreshed by upkeep) reads the `name` field.
 * - **Duplicate names (PE-30c).** Checked against a fresh server read of the
 *   household's pets (case-insensitive, the pet itself excluded) before the
 *   write, besides the form's check against the loaded list. Two sessions
 *   choosing the same new name within the same moment can still both pass:
 *   nothing is overwritten (ids differ), and the list shows both.
 * - **Photo (PE-21f).** An edit that changes the photo runs as a transaction
 *   over the stored pet and returns the URL it really replaced, so the caller
 *   deletes that object (if it is the pet's own) only after the new one is
 *   saved.
 */
import {
  collection,
  deleteField,
  doc,
  getDocs,
  runTransaction,
  serverTimestamp,
  setDoc,
  updateDoc,
  type DocumentData,
  type Firestore,
} from 'firebase/firestore';
import { awaitWriteUnlessOffline, isBrowserOffline } from '../firestore-offline';
import { householdToday } from '../household-day';
import { confirmMealPlan } from './meal-plan';
import { DuplicatePetNameError, duplicatePetName } from './profile';
import type { MealSlot, PetProfile, PortionUnit } from './types';
import type { WeightUnit } from './weights';

/** The profile fields a form produces (see `petFieldsFromForm`). */
export type PetProfileFields = {
  name: string;
  type: string;
  dataAiHint: string;
  foodSchedule: string;
  feedingsPerDay: number | null;
  portionAmount: number | null;
  portionUnit: PortionUnit | null;
  slots: MealSlot[] | null;
  /** Optional vet contact; null removes a field (PE-28a). */
  vetName?: string | null;
  vetClinic?: string | null;
  vetPhone?: string | null;
  /** The unit weights are shown in (PE-28c). */
  weightUnit?: WeightUnit | null;
};

/** Who confirms a meal plan (the signed-in member, rules: the writer) and the household zone ("today"). */
export type MealConfirmer = { uid: string; name: string; timeZone?: string | null };

const petsRef = (db: Firestore, householdId: string) => collection(db, 'households', householdId, 'pets');

/** The confirmation stamp of a plan: server time and the confirming member (rules check both). */
const confirmation = (by: MealConfirmer) => ({ confirmedAt: serverTimestamp(), confirmedByUid: by.uid, confirmedByName: by.name });

/**
 * Refuses a name another pet already uses, from a fresh server read. Offline the
 * loaded list (the form's check) is all there is, so this is skipped.
 */
export async function assertPetNameFree(db: Firestore, householdId: string, name: string, selfId: string): Promise<void> {
  if (isBrowserOffline()) return;
  const snapshot = await getDocs(petsRef(db, householdId));
  const pets = snapshot.docs.map((entry) => ({ id: entry.id, name: entry.get('name') as unknown }));
  if (duplicatePetName(name, pets, selfId)) throw new DuplicatePetNameError(name.trim());
}

const optionalText = (value: string | null | undefined) => (value ? value : undefined);

/** The new pet's document (without server stamps besides a plan's confirmation). */
export function newPetData(fields: PetProfileFields, photoUrl: string, confirmer: MealConfirmer | undefined, now: Date): Record<string, unknown> {
  const data: Record<string, unknown> = {
    name: fields.name,
    type: fields.type,
    dataAiHint: fields.dataAiHint,
    foodSchedule: fields.foodSchedule,
    photoUrl,
  };
  for (const key of ['vetName', 'vetClinic', 'vetPhone'] as const) {
    const value = optionalText(fields[key]);
    if (value) data[key] = value;
  }
  if (fields.weightUnit) data.weightUnit = fields.weightUnit;
  if (fields.slots && confirmer) {
    // A new pet has no earlier plan to keep; the count and portion follow the plan for older clients.
    data.mealPlan = { slots: fields.slots, effectiveFrom: householdToday(confirmer.timeZone, now), ...confirmation(confirmer) };
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
  return data;
}

/**
 * Creates a pet under `petId` (one id per Add dialog). Without a photo the
 * document has an empty `photoUrl` (no external placeholder; readers draw the
 * species avatar).
 */
export async function runCreatePet(
  db: Firestore,
  input: { householdId: string; petId: string; fields: PetProfileFields; photoUrl: string; confirmer?: MealConfirmer; now?: Date },
): Promise<'saved' | 'queued'> {
  if (input.fields.slots && !input.confirmer) throw new Error('meal-plan-confirmer-missing');
  await assertPetNameFree(db, input.householdId, input.fields.name, input.petId);
  const data = newPetData(input.fields, input.photoUrl, input.confirmer, input.now ?? new Date());
  return awaitWriteUnlessOffline(setDoc(doc(petsRef(db, input.householdId), input.petId), data));
}

/** Profile fields an edit writes (cleared optional values are removed). */
function editFields(fields: PetProfileFields, photoUrl: string | null) {
  const update: Record<string, unknown> = {
    name: fields.name,
    type: fields.type,
    dataAiHint: fields.dataAiHint,
    foodSchedule: fields.foodSchedule,
  };
  if (photoUrl !== null) update.photoUrl = photoUrl;
  for (const key of ['vetName', 'vetClinic', 'vetPhone'] as const) {
    if (key in fields) update[key] = fields[key] ? fields[key] : deleteField();
  }
  if (fields.weightUnit) update.weightUnit = fields.weightUnit;
  return update;
}

export type UpdatePetInput = {
  householdId: string;
  petId: string;
  fields: PetProfileFields;
  /** The new photo URL (uploaded or '' when removed), or null to keep the stored one. */
  photoUrl: string | null;
  /** The name the form opened with: a changed name is checked for duplicates. */
  originalName: string;
  confirmer?: MealConfirmer;
  now?: Date;
};

/**
 * Updates a pet: rename (PE-30), vet, weight unit, photo, schedule. With meal
 * times (PE-22k) the plan is confirmed in a transaction over the stored pet
 * (`confirmMealPlan`, PE-22g); a photo change also runs as a transaction and
 * returns the URL it replaced. Otherwise a plain update (queued offline).
 */
export async function runUpdatePet(db: Firestore, input: UpdatePetInput): Promise<{ outcome: 'saved' | 'queued'; replacedPhotoUrl: string | null }> {
  const { fields } = input;
  if (fields.slots && !input.confirmer) throw new Error('meal-plan-confirmer-missing');
  if (fields.name.trim().toLocaleLowerCase('en-US') !== input.originalName.trim().toLocaleLowerCase('en-US')) {
    await assertPetNameFree(db, input.householdId, fields.name, input.petId);
  }
  const petRef = doc(petsRef(db, input.householdId), input.petId);
  const base = editFields(fields, input.photoUrl);
  const legacy = {
    feedingsPerDay: fields.feedingsPerDay ?? deleteField(),
    portionAmount: fields.portionAmount ?? deleteField(),
    portionUnit: fields.portionAmount ? fields.portionUnit : deleteField(),
  };
  if (!fields.slots && input.photoUrl === null) {
    const outcome = await awaitWriteUnlessOffline(updateDoc(petRef, { ...base, ...legacy }));
    return { outcome, replacedPhotoUrl: null };
  }
  const slots = fields.slots;
  const confirmer = input.confirmer;
  const replaced = await runTransaction(db, async (transaction) => {
    const snapshot = await transaction.get(petRef);
    if (!snapshot.exists()) throw new Error('pet-not-found');
    const stored = snapshot.data() as PetProfile;
    let plan: Record<string, unknown> = legacy;
    if (slots && confirmer) {
      const confirmed = confirmMealPlan(stored, slots, householdToday(confirmer.timeZone, input.now ?? new Date()));
      plan = confirmed
        ? {
            mealPlan: { ...confirmed.mealPlan, ...confirmation(confirmer) },
            mealPlanHistory: confirmed.mealPlanHistory,
            feedingsPerDay: confirmed.feedingsPerDay,
            portionAmount: confirmed.portionAmount,
            portionUnit: confirmed.portionUnit,
          }
        : {};
    }
    transaction.update(petRef, { ...base, ...plan } as DocumentData);
    return input.photoUrl !== null && stored.photoUrl !== input.photoUrl ? (stored.photoUrl ?? null) : null;
  });
  return { outcome: 'saved', replacedPhotoUrl: replaced };
}
