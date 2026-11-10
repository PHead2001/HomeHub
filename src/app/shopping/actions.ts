'use server';

import { authorizeHouseholdAction } from '@/ai/action-auth';
import { HomeHubAiError } from '@/ai/errors';
import { adminDb } from '@/lib/server/firebase-admin';

export type DeleteShoppingListResult =
  | { ok: true }
  | { ok: false; code: 'unauthenticated' | 'forbidden' | 'invalid_input' | 'unavailable'; message: string };

const MESSAGES = {
  unauthenticated: 'Your sign-in could not be verified. Please sign in again.',
  forbidden: 'You do not have permission to delete shopping lists.',
  invalid_input: 'That list could not be found.',
  unavailable: 'The list could not be deleted right now. Please try again in a moment.',
} as const;

/** A Firestore document id the client may name: 1–1500 characters, no `/`, not `.`/`..` or `__…__`. */
const isListId = (value: unknown): value is string => typeof value === 'string'
  && value.length > 0
  && value.length <= 1500
  && !value.includes('/')
  && value !== '.'
  && value !== '..'
  && !/^__.*__$/.test(value);

/**
 * Deletes a shopping list for real (SH-9): the list document and everything under
 * it (`items/*`, `config/categories`), with the Admin SDK's `recursiveDelete`.
 * The caller must be an approved member of `householdId` with `shopping.delete`;
 * the path is built from the verified household, so another household's lists
 * are out of reach. Deleting a list that is already gone also removes anything
 * left under it, so a retry is safe.
 */
export async function deleteShoppingList(input: { idToken: string; householdId: string; listId: string }): Promise<DeleteShoppingListResult> {
  const failure = (code: keyof typeof MESSAGES): DeleteShoppingListResult => ({ ok: false, code, message: MESSAGES[code] });
  try {
    const user = await authorizeHouseholdAction({ idToken: input?.idToken, householdId: input?.householdId }, 'shopping.delete');
    if (!isListId(input?.listId)) return failure('invalid_input');
    const listRef = adminDb.collection('households').doc(user.householdId).collection('shopping-lists').doc(input.listId);
    await adminDb.recursiveDelete(listRef);
    return { ok: true };
  } catch (error) {
    if (error instanceof HomeHubAiError) {
      return failure(error.code === 'unauthenticated' ? 'unauthenticated' : 'forbidden');
    }
    console.error('Deleting a shopping list failed', error);
    return failure('unavailable');
  }
}
