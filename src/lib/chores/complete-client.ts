/**
 * The one client entry point for completing, undoing and reopening chores (H3).
 * Every surface that completes a chore (the Chores page's one tap, bulk completion,
 * Undo and reopen; the dashboard's Done next) calls these, which call the server
 * actions in `src/app/chores/actions.ts` with the signed-in user's ID token.
 *
 * Completion needs a connection: offline nothing is queued, the caller shows
 * `OFFLINE_COMPLETION_MESSAGE` and the row stays open. (A queued client write
 * could not be checked for eligibility or attributed by the server.)
 */
import { completeChores, reopenChore, undoChoreCompletion } from '@/app/chores/actions';
import { auth } from '@/lib/firebase';
import { MAX_COMPLETION_BATCH, type ChoreCompletionOutcome, type CompletionRecord, type ReopenOutcome, type SubTaskRestore, type UndoOutcome } from './completion';
import type { ChoreRecord } from './dates';

export { CHORE_UNDO_MS } from './completion';

export const OFFLINE_COMPLETION_MESSAGE = "You're offline. Not completed.";

export type CompletionFailure = { ok: false; reason: 'offline' | 'signed-out' | 'forbidden' | 'failed' };
type Result<T> = { ok: true; data: T } | CompletionFailure;

const isOffline = () => typeof navigator !== 'undefined' && navigator.onLine === false;

async function call<T>(householdId: string, run: (context: { idToken: string; householdId: string }) => Promise<{ ok: true; data: T } | { ok: false; code: string }>): Promise<Result<T>> {
  if (isOffline()) return { ok: false, reason: 'offline' };
  const user = auth.currentUser;
  if (!user) return { ok: false, reason: 'signed-out' };
  try {
    const result = await run({ idToken: await user.getIdToken(), householdId });
    if (result.ok) return result;
    if (result.code === 'unauthenticated') return { ok: false, reason: 'signed-out' };
    if (result.code === 'forbidden') return { ok: false, reason: 'forbidden' };
    return { ok: false, reason: 'failed' };
  } catch {
    // The request never reached the server (network dropped mid-call).
    return { ok: false, reason: isOffline() ? 'offline' : 'failed' };
  }
}

/** Completes chores on the server, in batches of `MAX_COMPLETION_BATCH`. */
export async function completeChoresOnServer(
  householdId: string,
  choreIds: readonly string[],
  options: { completeSubTasks: boolean },
): Promise<Result<ChoreCompletionOutcome[]>> {
  const outcomes: ChoreCompletionOutcome[] = [];
  for (let index = 0; index < choreIds.length; index += MAX_COMPLETION_BATCH) {
    const chunk = choreIds.slice(index, index + MAX_COMPLETION_BATCH);
    const result = await call(householdId, context => completeChores({ ...context, choreIds: chunk, completeSubTasks: options.completeSubTasks }));
    if (!result.ok) {
      if (outcomes.length === 0) return result;
      break; // Earlier batches are done; the rest stay open and are reported as not completed.
    }
    outcomes.push(...result.data);
  }
  return { ok: true, data: outcomes };
}

export function undoCompletionOnServer(householdId: string, input: { choreId: string; completionId: string; restoreSubTasks?: SubTaskRestore | null }): Promise<Result<UndoOutcome>> {
  return call(householdId, context => undoChoreCompletion({ ...context, ...input }));
}

export function reopenChoreOnServer(householdId: string, choreId: string): Promise<Result<ReopenOutcome>> {
  return call(householdId, context => reopenChore({ ...context, choreId }));
}

/** The local fields of a completed chore, from what the server recorded. */
export function completedChoreFields(completion: CompletionRecord): Partial<ChoreRecord> {
  return {
    isCompleted: true,
    completedAt: completion.completedAt,
    completedSubTasks: completion.completedSubTasks,
    completedByUid: completion.completedByUid,
    completedByEmail: completion.completedByEmail,
    completedByName: completion.completedByName,
    completionId: completion.completionId,
    completedAtServer: undefined,
  };
}

/** The local fields of a chore that is open again. */
export function reopenedChoreFields(): Partial<ChoreRecord> {
  return {
    isCompleted: false,
    completedAt: undefined,
    completedAtServer: undefined,
    completedByUid: undefined,
    completedByEmail: undefined,
    completedByName: undefined,
    completionId: undefined,
  };
}

/** What Undo needs for one completed chore. */
export type UndoTicket = { choreId: string; completionId: string; restoreSubTasks: SubTaskRestore | null };

export function undoTicket(outcome: Extract<ChoreCompletionOutcome, { status: 'completed' }>): UndoTicket | null {
  if (!outcome.completion.completionId) return null;
  return {
    choreId: outcome.choreId,
    completionId: outcome.completion.completionId,
    restoreSubTasks: outcome.previousCompletedSubTasks
      ? { from: outcome.completion.completedSubTasks, to: outcome.previousCompletedSubTasks }
      : null,
  };
}

/** Message for a failed request. */
export function completionFailureMessage(failure: CompletionFailure, verb: 'complete' | 'undo' | 'reopen'): string {
  if (failure.reason === 'offline') {
    return verb === 'complete' ? OFFLINE_COMPLETION_MESSAGE : verb === 'undo' ? "You're offline. Not undone." : "You're offline. Not reopened.";
  }
  if (failure.reason === 'signed-out') return 'Your sign-in has expired. Sign in again and retry.';
  if (failure.reason === 'forbidden') return "You don't have permission to complete chores here.";
  return verb === 'complete' ? "Couldn't complete. Try again." : verb === 'undo' ? "Couldn't undo. Try again." : "Couldn't reopen. Try again.";
}
