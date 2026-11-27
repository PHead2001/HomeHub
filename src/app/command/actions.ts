'use server';

import { authorizeHouseholdAction } from '@/ai/action-auth';
import { HomeHubAiError } from '@/ai/errors';
import { adminDb } from '@/lib/server/firebase-admin';
import { undoQuickAddChoreOnServer, undoQuickAddItemsOnServer } from '@/lib/server/quick-add-undo';
import { isDocId, parseItemUndos } from '@/lib/dashboard/quick-add-undo';

export type QuickAddUndoResult =
  | { ok: true; undone: number; kept: number }
  | { ok: false; code: 'unauthenticated' | 'forbidden' | 'invalid_input' | 'unavailable'; message: string };

const MESSAGES = {
  unauthenticated: 'Your sign-in could not be verified. Please sign in again.',
  forbidden: 'You do not have permission to undo that.',
  invalid_input: 'That could not be undone.',
  unavailable: 'That could not be undone right now. Please try again in a moment.',
} as const;
const failure = (code: keyof typeof MESSAGES): QuickAddUndoResult => ({ ok: false, code, message: MESSAGES[code] });
const caught = (error: unknown, what: string): QuickAddUndoResult => {
  if (error instanceof HomeHubAiError) return failure(error.code === 'unauthenticated' ? 'unauthenticated' : 'forbidden');
  console.error(what, error);
  return failure('unavailable');
};

/**
 * Undo of a quick-add shopping save (QA-9). Needs `shopping.edit`; a created item
 * is removed only for the member who added it, within a minute, while still needed
 * (`itemUndoPlan`), so this is no general delete. The path comes from the verified
 * household.
 */
export async function undoQuickAddItems(input: { idToken: string; householdId: string; listId: string; items: unknown }): Promise<QuickAddUndoResult> {
  try {
    const user = await authorizeHouseholdAction({ idToken: input?.idToken, householdId: input?.householdId }, 'shopping.edit');
    const items = parseItemUndos(input?.items);
    if (!isDocId(input?.listId) || !items) return failure('invalid_input');
    const result = await undoQuickAddItemsOnServer(adminDb, { householdId: user.householdId, uid: user.uid, listId: input.listId, items });
    return { ok: true, undone: result.undone, kept: result.kept.length };
  } catch (error) {
    return caught(error, 'Undoing a quick-add shopping save failed');
  }
}

/** Undo of a quick-add one-time chore (QA-9). Needs `chores.create`; see `choreUndoPlan`. */
export async function undoQuickAddChore(input: { idToken: string; householdId: string; choreId: string }): Promise<QuickAddUndoResult> {
  try {
    const user = await authorizeHouseholdAction({ idToken: input?.idToken, householdId: input?.householdId }, 'chores.create');
    if (!isDocId(input?.choreId)) return failure('invalid_input');
    const done = await undoQuickAddChoreOnServer(adminDb, { householdId: user.householdId, uid: user.uid, choreId: input.choreId });
    return { ok: true, undone: done ? 1 : 0, kept: done ? 0 : 1 };
  } catch (error) {
    return caught(error, 'Undoing a quick-add chore failed');
  }
}
