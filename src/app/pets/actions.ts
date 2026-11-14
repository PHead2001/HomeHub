'use server';

import { authorizeHouseholdAction } from '@/ai/action-auth';
import { HomeHubAiError } from '@/ai/errors';
import { adminDb, adminStorageBucket } from '@/lib/server/firebase-admin';
import { deletePetCascade, PetDeleteIncomplete, type PetPhotoBucket } from '@/lib/server/pet-delete';
import { PET_ACTION_PERMISSIONS } from '@/lib/pets/pet-actions';
import { isPetId } from '@/lib/pets/profile';

export type DeletePetResult =
  | { ok: true; status: 'deleted' | 'already' }
  | { ok: false; code: 'unauthenticated' | 'forbidden' | 'invalid_input' | 'unavailable'; message: string };

const MESSAGES = {
  unauthenticated: 'Your sign-in could not be verified. Please sign in again.',
  forbidden: 'You do not have permission to delete pets.',
  invalid_input: 'That pet could not be found.',
  unavailable: 'The pet could not be fully deleted right now. Please try again in a moment; trying again finishes the job.',
} as const;

/**
 * Deletes a pet and everything that belongs to it (D-P12): its document, every
 * log, note, weight, feeding state and course under it, its photos, and its
 * open reminders, with an activity-log entry (`deletePetCascade`). The caller
 * must be an approved member of `householdId` holding the permission in
 * `PET_ACTION_PERMISSIONS['pets.profile.delete']` (`pets.editProfiles`); the
 * path is built from the verified household, so another household's pets are
 * out of reach. Idempotent and resumable: a retry after a failure or a lost
 * response finishes what is left and reports `already` once nothing was there.
 */
export async function deletePetAction(input: { idToken: string; householdId: string; petId: string }): Promise<DeletePetResult> {
  const failure = (code: keyof typeof MESSAGES): DeletePetResult => ({ ok: false, code, message: MESSAGES[code] });
  try {
    const user = await authorizeHouseholdAction({ idToken: input?.idToken, householdId: input?.householdId }, PET_ACTION_PERMISSIONS['pets.profile.delete']);
    if (!isPetId(input?.petId)) return failure('invalid_input');
    const member = await adminDb.collection('households').doc(user.householdId).collection('members').doc(user.uid).get();
    const name = typeof member.get('displayName') === 'string' ? (member.get('displayName') as string) : null;
    const outcome = await deletePetCascade(adminDb, adminStorageBucket() as unknown as PetPhotoBucket | null, {
      householdId: user.householdId,
      petId: input.petId,
      // The activity log names the actor; the email only when there is no name.
      actor: { uid: user.uid, email: name ? null : user.email, name },
    });
    return { ok: true, status: outcome.status };
  } catch (error) {
    if (error instanceof HomeHubAiError) return failure(error.code === 'unauthenticated' ? 'unauthenticated' : 'forbidden');
    if (error instanceof PetDeleteIncomplete) console.error('Deleting a pet left documents behind after every pass');
    else console.error('Deleting a pet failed', error);
    return failure('unavailable');
  }
}
