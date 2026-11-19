'use server';

import { Timestamp } from 'firebase-admin/firestore';
import { authorizeHouseholdAction } from '@/ai/action-auth';
import { HomeHubAiError } from '@/ai/errors';
import { adminDb } from '@/lib/server/firebase-admin';
import { runHouseholdReminders } from '@functions/reminders';
import { ChoreCompletionError, completeChoresAs, reopenChoreAs, undoChoreCompletionAs } from '@/lib/server/chore-completion';
import type { SubTaskRestore } from '@/lib/chores/completion';
import { personalOperationContext } from '@/lib/server/operation-context';

// functions/ pins its own firebase-admin version; the Firestore calls used are
// identical across versions, so the instance is passed through untyped.
// Runs the same idempotent upkeep the hourly Cloud Function runs (recurring
// chores, retention, reminders), on demand for the caller's household, so a
// newly assigned recurring chore appears immediately.
// End-to-end tests pin the browser clock; the server follows the same pinned instant,
// but only against the emulator, so production always uses the real time.
const upkeepNow = () => {
  const configured = process.env.FIRESTORE_EMULATOR_HOST ? process.env.HOMEHUB_TEST_NOW : undefined;
  const parsed = configured ? new Date(configured) : new Date();
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
};

export async function syncHouseholdUpkeep(context: { idToken: string; householdId: string }) {
  try {
    const user = await authorizeHouseholdAction(context, 'chores.view');
    const result = await runHouseholdReminders(adminDb as never, user.householdId, upkeepNow(), d => Timestamp.fromDate(d) as never);
    return { ok: true as const, generatedChores: result.generatedChores };
  } catch (error) {
    if (!(error instanceof HomeHubAiError)) console.error('Household upkeep failed', error);
    return { ok: false as const };
  }
}

/* -------------------------------------------------------------------------- */
/* Completion (H3: CH-2, CH-12, D-7)                                           */
/* -------------------------------------------------------------------------- */

// Completing, undoing and reopening run here, never as client writes: the server
// decides whether a chore may be completed today (household timezone) and records
// who completed it from the verified ID token, so points cannot be farmed or
// credited to someone else. Logic: src/lib/server/chore-completion.ts.

export type ChoreActionFailure = { ok: false; code: 'unauthenticated' | 'forbidden' | 'invalid' | 'not-found' | 'failed' };
export type ChoreActionResult<T> = { ok: true; data: T } | ChoreActionFailure;

type ChoreActionContext = { idToken: string; householdId: string };

const runChoreAction = async <T>(
  context: ChoreActionContext,
  task: (user: { uid: string; email: string; householdId: string; displayName?: string }) => Promise<T>,
): Promise<ChoreActionResult<T>> => {
  try {
    const user = await authorizeHouseholdAction({ idToken: context?.idToken, householdId: context?.householdId }, 'chores.complete');
    return { ok: true, data: JSON.parse(JSON.stringify(await task(user))) as T };
  } catch (error) {
    if (error instanceof HomeHubAiError) {
      return { ok: false, code: error.code === 'forbidden' ? 'forbidden' : error.code === 'unauthenticated' ? 'unauthenticated' : 'failed' };
    }
    if (error instanceof ChoreCompletionError) return { ok: false, code: error.code };
    console.error('Chore completion action failed', error);
    return { ok: false, code: 'failed' };
  }
};

/** Completes chores as the signed-in member (refusing any due after today). */
export async function completeChores(input: ChoreActionContext & { choreIds: string[]; completeSubTasks?: boolean }) {
  // The personal path: the verified caller as the operation's actor, no device hooks.
  return runChoreAction(input, user => completeChoresAs(adminDb, user.householdId, input,
    personalOperationContext({ uid: user.uid, name: user.displayName ?? '' }, upkeepNow())));
}

/** Undoes one completion, only while `completionId` is still its current completion. */
export async function undoChoreCompletion(input: ChoreActionContext & { choreId: string; completionId: string; restoreSubTasks?: SubTaskRestore | null }) {
  return runChoreAction(input, user => undoChoreCompletionAs(adminDb, user.householdId, input));
}

/** Reopens a completed chore (it changes points, so it runs on the server). */
export async function reopenChore(input: ChoreActionContext & { choreId: string }) {
  return runChoreAction(input, user => reopenChoreAs(adminDb, user.householdId, input));
}
