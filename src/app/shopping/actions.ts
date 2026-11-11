'use server';

import { authorizeHouseholdAction } from '@/ai/action-auth';
import { HomeHubAiError } from '@/ai/errors';
import { adminDb } from '@/lib/server/firebase-admin';
import { deleteListTree } from '@/lib/server/shopping-list-delete';
import { TripRefused, applyTrip, undoTripOnServer, type TripSummary, type TripUndoSummary } from '@/lib/server/shopping-trips';
import { isTripId, parseTripInput, type TripChoice, type TripMode } from '@/lib/shopping/trip-plan';

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
 * it (`items/*`, `config/categories`), with `deleteListTree`. The list document
 * goes first, so the rules refuse any item or category write while the rest is
 * scanned and deleted (no orphan can slip in after its position was scanned).
 * The caller must be an approved member of `householdId` with `shopping.delete`;
 * the path is built from the verified household, so another household's lists
 * are out of reach. Deleting a list that is already gone also removes anything
 * left under it, so a retry is safe. Reports `unavailable` if anything is still
 * left after the bounded cleanup passes.
 */
export async function deleteShoppingList(input: { idToken: string; householdId: string; listId: string }): Promise<DeleteShoppingListResult> {
  const failure = (code: keyof typeof MESSAGES): DeleteShoppingListResult => ({ ok: false, code, message: MESSAGES[code] });
  try {
    const user = await authorizeHouseholdAction({ idToken: input?.idToken, householdId: input?.householdId }, 'shopping.delete');
    if (!isListId(input?.listId)) return failure('invalid_input');
    const listRef = adminDb.collection('households').doc(user.householdId).collection('shopping-lists').doc(input.listId);
    const outcome = await deleteListTree(adminDb, listRef);
    if (outcome === 'incomplete') {
      console.error('Deleting a shopping list left documents behind after every cleanup pass');
      return failure('unavailable');
    }
    return { ok: true };
  } catch (error) {
    if (error instanceof HomeHubAiError) {
      return failure(error.code === 'unauthenticated' ? 'unauthenticated' : 'forbidden');
    }
    console.error('Deleting a shopping list failed', error);
    return failure('unavailable');
  }
}

// --- Put away and clear, as one trip (S5: SH-2, SH-17, SH-32) ---

export type TripActionFailureCode =
  | 'unauthenticated' | 'forbidden' | 'invalid_input' | 'unavailable'
  | 'list_missing' | 'too_large' | 'not_found' | 'not_latest' | 'expired';

export type TripActionFailure = { ok: false; code: TripActionFailureCode; message: string };
export type PutAwayResult = { ok: true; trip: TripSummary } | TripActionFailure;
export type UndoTripResult = { ok: true; undo: TripUndoSummary } | TripActionFailure;

const TRIP_MESSAGES: Record<TripActionFailureCode, string> = {
  unauthenticated: MESSAGES.unauthenticated,
  forbidden: 'You do not have permission to do that on shopping lists.',
  invalid_input: 'That trip could not be read. Please try again.',
  unavailable: 'That could not be finished right now. Nothing was changed; please try again in a moment.',
  list_missing: 'This list was deleted, so nothing was put away.',
  too_large: 'That is too much to put away at once. Put the purchases away in smaller groups; nothing was changed.',
  not_found: 'That trip could not be found.',
  not_latest: 'Only the most recent trip can be undone.',
  expired: 'A trip can only be undone within 15 minutes.',
};

const tripFailure = (code: TripActionFailureCode): TripActionFailure => ({ ok: false, code, message: TRIP_MESSAGES[code] });

const tripCatch = (error: unknown, what: string): TripActionFailure => {
  if (error instanceof HomeHubAiError) return tripFailure(error.code === 'unauthenticated' ? 'unauthenticated' : 'forbidden');
  if (error instanceof TripRefused) return tripFailure(error.code);
  console.error(what, error);
  return tripFailure('unavailable');
};

/**
 * Puts a finished trip's purchases away (SH-2a–c, SH-30, SH-32a): credits the
 * pantry and, with `putAwayAndClear`, clears the items, in one Admin SDK
 * transaction that is idempotent by the client-generated `tripId`
 * (`applyTrip`). Needs `shopping.edit`; clearing also needs `shopping.delete`
 * (the permission the rules require to delete items). The path is built from
 * the verified household.
 */
export async function putAwayAndClear(input: { idToken: string; householdId: string; listId: string; tripId: string; mode: TripMode; items: TripChoice[] }): Promise<PutAwayResult> {
  try {
    const user = await authorizeHouseholdAction({ idToken: input?.idToken, householdId: input?.householdId }, 'shopping.edit');
    const trip = parseTripInput(input);
    if (!trip) return tripFailure('invalid_input');
    if (trip.mode === 'putAwayAndClear' && !user.permissions['shopping.delete']) return tripFailure('forbidden');
    const summary = await applyTrip(adminDb, { householdId: user.householdId, uid: user.uid, input: trip, nowMs: Date.now() });
    return { ok: true, trip: summary };
  } catch (error) {
    return tripCatch(error, 'Putting a trip away failed');
  }
}

/**
 * Undoes the household's latest trip within 15 minutes of when it was applied
 * (server clock), reversing only that trip's effects (`undoTripOnServer`).
 * Needs `shopping.edit` (Undo puts items back and takes the credit off the
 * pantry; it deletes nothing a member added).
 */
export async function undoTrip(input: { idToken: string; householdId: string; tripId: string }): Promise<UndoTripResult> {
  try {
    const user = await authorizeHouseholdAction({ idToken: input?.idToken, householdId: input?.householdId }, 'shopping.edit');
    if (!isTripId(input?.tripId)) return tripFailure('invalid_input');
    const undo = await undoTripOnServer(adminDb, { householdId: user.householdId, uid: user.uid, tripId: input.tripId, nowMs: Date.now() });
    return { ok: true, undo };
  } catch (error) {
    return tripCatch(error, 'Undoing a trip failed');
  }
}
