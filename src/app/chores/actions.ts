'use server';

import { Timestamp } from 'firebase-admin/firestore';
import { authorizeHouseholdAction } from '@/ai/action-auth';
import { HomeHubAiError } from '@/ai/errors';
import { adminDb } from '@/lib/server/firebase-admin';
import { runHouseholdReminders } from '@functions/reminders';
import { ChoreCompletionError, completeChoresAs, reopenChoreAs, undoChoreCompletionAs } from '@/lib/server/chore-completion';
import type { SubTaskRestore } from '@/lib/chores/completion';
import { personalOperationContext } from '@/lib/server/operation-context';
import { PlannedMoveError, movePlannedOccurrence, undoPlannedMove } from '@/lib/server/planned-chore-move';
import { ChoreSkipError, skipChoreDays, undoSkipChoreDays } from '@/lib/server/chore-day-skips';
import { ChorePauseError, pauseChoresAs, type PauseOutcome } from '@/lib/server/chore-pause';
import { ChoreProofError, reviewChoreProofAs, submitChoreProofAs, type ProofBucket } from '@/lib/server/chore-proof';
import { adminStorageBucket } from '@/lib/server/firebase-admin';
import type { ReviewOutcome, SubmitOutcome } from '@/lib/chores/proof';
import { ChoreSwapError, answerSwapAs, offerSwapAs } from '@/lib/server/chore-swap';
import type { AnswerOutcome, OfferOutcome } from '@/lib/chores/swap';

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
  // The same people who may reopen it (CH-6).
  return runChoreAction(input, user => undoChoreCompletionAs(adminDb, user.householdId, input, undefined, { uid: user.uid, email: user.email }));
}

/** Reopens a completed chore (it changes points, so it runs on the server). */
export async function reopenChore(input: ChoreActionContext & { choreId: string }) {
  // Only the completer, the assignee or a member who may edit chores (CH-6).
  return runChoreAction(input, user => reopenChoreAs(adminDb, user.householdId, input, { uid: user.uid, email: user.email }));
}

/* -------------------------------------------------------------------------- */
/* Planned days of repeating chores (audit CA-15, CA-27)                       */
/* -------------------------------------------------------------------------- */

export type PlannedMoveResult<T> = { ok: true; data: T } | { ok: false; code: 'unauthenticated' | 'forbidden' | 'invalid' | 'not-found' | 'conflict' | 'too-many' | 'failed' };

const runCalendarAction = async <T>(
  context: ChoreActionContext,
  permission: 'chores.edit' | 'chores.delete',
  task: (user: { uid: string; householdId: string }) => Promise<T>,
): Promise<PlannedMoveResult<T>> => {
  try {
    const user = await authorizeHouseholdAction({ idToken: context?.idToken, householdId: context?.householdId }, permission);
    return { ok: true, data: JSON.parse(JSON.stringify(await task(user))) as T };
  } catch (error) {
    if (error instanceof HomeHubAiError) {
      return { ok: false, code: error.code === 'forbidden' ? 'forbidden' : error.code === 'unauthenticated' ? 'unauthenticated' : 'failed' };
    }
    if (error instanceof PlannedMoveError || error instanceof ChoreSkipError) return { ok: false, code: error.code };
    console.error('Calendar chore action failed', error);
    return { ok: false, code: 'failed' };
  }
};

/** Moves a planned (not yet generated) day of a repeating chore to `toDay` (CA-15); needs chores.edit, as moving any chore does. */
export async function movePlannedChore(input: ChoreActionContext & { templateId: string; roomId: string; day: string; toDay: string }) {
  return runCalendarAction(input, 'chores.edit', user => movePlannedOccurrence(adminDb, user.householdId, input, upkeepNow(), user.uid));
}

/** Undo of `movePlannedChore`, by the move's `opId` only (the caller's own move, review finding 1). */
export async function undoPlannedChoreMove(input: ChoreActionContext & { opId: string }) {
  return runCalendarAction(input, 'chores.edit', user => undoPlannedMove(adminDb, user.householdId, { opId: input?.opId }, user.uid, upkeepNow()));
}

/** Skips days of repeating chores (CA-27); needs chores.delete, the rules' skip permission. */
export async function skipChoreDaysAction(input: ChoreActionContext & { items: { templateId: string; key: string; choreId?: string }[] }) {
  return runCalendarAction(input, 'chores.delete', user => skipChoreDays(adminDb, user.householdId, { items: input?.items }, user.uid, upkeepNow()));
}

/** Undo of `skipChoreDaysAction`, by its `opId` only: restores the deleted days while they are free. */
export async function undoSkipChoreDaysAction(input: ChoreActionContext & { opId: string }) {
  return runCalendarAction(input, 'chores.delete', user => undoSkipChoreDays(adminDb, user.householdId, { opId: input?.opId }, user.uid, upkeepNow()));
}

/* -------------------------------------------------------------------------- */
/* Away / sick pause (CH-32)                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Skips (or, with `resume`, brings back) a member's repeating chores for a range of
 * days. Needs `chores.edit`; someone else's chores also need `chores.delete`
 * (checked in src/lib/server/chore-pause.ts).
 */
export async function pauseChores(input: ChoreActionContext & { memberUid: string; from: string; to: string; resume?: boolean }): Promise<ChoreActionResult<PauseOutcome>> {
  try {
    const user = await authorizeHouseholdAction({ idToken: input?.idToken, householdId: input?.householdId }, 'chores.edit');
    const outcome = await pauseChoresAs(adminDb, user.householdId, { uid: user.uid }, input, upkeepNow());
    if (outcome.status !== 'refused') {
      // Resumed days come back at once; paused ones are already gone.
      await runHouseholdReminders(adminDb as never, user.householdId, upkeepNow(), d => Timestamp.fromDate(d) as never).catch(() => undefined);
    }
    return { ok: true, data: outcome };
  } catch (error) {
    if (error instanceof HomeHubAiError) {
      return { ok: false, code: error.code === 'forbidden' ? 'forbidden' : error.code === 'unauthenticated' ? 'unauthenticated' : 'failed' };
    }
    if (error instanceof ChorePauseError) return { ok: false, code: error.code };
    console.error('Chore pause failed', error);
    return { ok: false, code: 'failed' };
  }
}

/* -------------------------------------------------------------------------- */
/* Photo proof for kids (CH-30)                                                */
/* -------------------------------------------------------------------------- */

const proofBucket = () => adminStorageBucket() as unknown as ProofBucket | null;

const proofFailure = (error: unknown): ChoreActionFailure => {
  if (error instanceof HomeHubAiError) {
    return { ok: false, code: error.code === 'forbidden' ? 'forbidden' : error.code === 'unauthenticated' ? 'unauthenticated' : 'failed' };
  }
  if (error instanceof ChoreProofError) return { ok: false, code: error.code };
  console.error('Chore photo proof failed', error);
  return { ok: false, code: 'failed' };
};

/** A kid sends the photo they uploaded for a chore that asks for one; it waits for a parent. */
export async function submitChoreProof(input: ChoreActionContext & { choreId: string; photoPath: string }): Promise<ChoreActionResult<SubmitOutcome>> {
  try {
    const user = await authorizeHouseholdAction({ idToken: input?.idToken, householdId: input?.householdId }, 'chores.complete');
    return { ok: true, data: await submitChoreProofAs(adminDb, proofBucket(), user.householdId, { uid: user.uid }, input, upkeepNow()) };
  } catch (error) {
    return proofFailure(error);
  }
}

/** A member who may edit chores approves the photo (the chore is completed for the kid) or sends it back. */
export async function reviewChoreProof(input: ChoreActionContext & { choreId: string; approve: boolean }): Promise<ChoreActionResult<ReviewOutcome>> {
  try {
    const user = await authorizeHouseholdAction({ idToken: input?.idToken, householdId: input?.householdId }, 'chores.edit');
    return { ok: true, data: await reviewChoreProofAs(adminDb, proofBucket(), user.householdId, { uid: user.uid }, input) };
  } catch (error) {
    return proofFailure(error);
  }
}

/* -------------------------------------------------------------------------- */
/* Swaps (CH-31)                                                               */
/* -------------------------------------------------------------------------- */

const swapFailure = (error: unknown): ChoreActionFailure => {
  if (error instanceof HomeHubAiError) {
    return { ok: false, code: error.code === 'forbidden' ? 'forbidden' : error.code === 'unauthenticated' ? 'unauthenticated' : 'failed' };
  }
  if (error instanceof ChoreSwapError) return { ok: false, code: error.code };
  console.error('Chore swap failed', error);
  return { ok: false, code: 'failed' };
};

/** Offers one of your open chores for a housemate's open chore; they are notified. */
export async function offerChoreSwap(input: ChoreActionContext & { myChoreId: string; theirChoreId: string }): Promise<ChoreActionResult<OfferOutcome>> {
  try {
    const user = await authorizeHouseholdAction({ idToken: input?.idToken, householdId: input?.householdId }, 'chores.complete');
    return { ok: true, data: await offerSwapAs(adminDb, user.householdId, { uid: user.uid }, input, upkeepNow()) };
  } catch (error) {
    return swapFailure(error);
  }
}

/** Accepts or declines a swap offered to you, or cancels one you offered. */
export async function answerChoreSwap(input: ChoreActionContext & { offerId: string; answer: 'accept' | 'decline' | 'cancel' }): Promise<ChoreActionResult<AnswerOutcome>> {
  try {
    const user = await authorizeHouseholdAction({ idToken: input?.idToken, householdId: input?.householdId }, 'chores.complete');
    return { ok: true, data: await answerSwapAs(adminDb, user.householdId, { uid: user.uid }, input, upkeepNow()) };
  } catch (error) {
    return swapFailure(error);
  }
}
