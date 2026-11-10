import 'server-only';

import { randomUUID } from 'node:crypto';
import { FieldValue, type DocumentReference, type Firestore, type Transaction } from 'firebase-admin/firestore';
import {
  COMPLETION_FIELDS,
  isChoreDocId,
  MAX_COMPLETION_BATCH,
  planCompletion,
  planReopen,
  planUndo,
  stringList,
  type ChoreCompletionOutcome,
  type ReopenOutcome,
  type SubTaskRestore,
  type UndoOutcome,
} from '@/lib/chores/completion';
import { safeTimeZone } from '@functions/shared/calendar';
import { isDocId } from '@functions/shared/push-media';
import { publicDisplayName } from '@/lib/member-directory';

/**
 * Chore completion through the Admin SDK (H3). The caller is whoever the ID token
 * proved (`authorizeHouseholdAction` in the server action, with `chores.complete`);
 * nothing about who completed a chore, or when, comes from the client. Each call
 * is one transaction, so two people completing the same chore at once yield one
 * completion: the second sees it done and learns who did it.
 */

export type CompletionCaller = { uid: string; email: string; displayName?: string };

export class ChoreCompletionError extends Error {
  constructor(readonly code: 'invalid' | 'not-found') {
    super(code);
    this.name = 'ChoreCompletionError';
  }
}

const householdRef = (db: Firestore, householdId: string) => {
  if (!isDocId(householdId)) throw new ChoreCompletionError('invalid');
  return db.collection('households').doc(householdId);
};

// Chore IDs use Firestore's own limits (`isChoreDocId`): upkeep's recurring IDs
// can exceed the 200 characters `isDocId` allows.
const choreIdOf = (value: unknown): string => {
  if (!isChoreDocId(value)) throw new ChoreCompletionError('invalid');
  return value;
};

const clearCompletion = () => Object.fromEntries(COMPLETION_FIELDS.map(field => [field, FieldValue.delete()]));

/** The household (must exist and not be deleting) and its timezone. */
const readHousehold = async (tx: Transaction, ref: DocumentReference) => {
  const snap = await tx.get(ref);
  if (!snap.exists || snap.get('deletingAt')) throw new ChoreCompletionError('not-found');
  return safeTimeZone(snap.get('timeZone'));
};

/**
 * Completes chores as the caller. Per chore: already completed is a no-op that
 * reports who did it; a chore due after today (household timezone) is refused;
 * otherwise it is completed and attributed to the caller. `completeSubTasks`
 * ticks every step of chores that still have open ones.
 */
export async function completeChoresAs(
  db: Firestore,
  caller: CompletionCaller,
  householdId: string,
  input: { choreIds: unknown; completeSubTasks?: unknown },
  now = new Date(),
): Promise<ChoreCompletionOutcome[]> {
  const house = householdRef(db, householdId);
  if (!Array.isArray(input?.choreIds) || input.choreIds.length === 0 || input.choreIds.length > MAX_COMPLETION_BATCH) {
    throw new ChoreCompletionError('invalid');
  }
  const choreIds = [...new Set(input.choreIds.map(choreIdOf))];
  const completeSubTasks = input.completeSubTasks === true;

  return db.runTransaction(async tx => {
    const [home, member, ...chores] = await tx.getAll(
      house,
      house.collection('members').doc(caller.uid),
      ...choreIds.map(id => house.collection('chores').doc(id)),
    );
    if (!home.exists || home.get('deletingAt')) throw new ChoreCompletionError('not-found');
    const timeZone = safeTimeZone(home.get('timeZone'));
    const memberName = member.get('displayName');
    const completer = {
      uid: caller.uid,
      email: caller.email,
      // Shown to every member ("Done by Sam"): a name, never an email (HO-9).
      name: publicDisplayName(memberName, '') || publicDisplayName(caller.displayName),
    };
    return chores.map((snap, index): ChoreCompletionOutcome => {
      const choreId = choreIds[index];
      if (!snap.exists) return { choreId, status: 'refused', refused: 'missing' };
      const plan = planCompletion(snap.data()!, { completer, now, timeZone, completeSubTasks, completionId: randomUUID() });
      if (plan.kind === 'early') return { choreId, status: 'refused', refused: 'early', dueDay: plan.dueDay };
      if (plan.kind === 'already') return { choreId, status: 'already', completion: plan.completion };
      tx.update(snap.ref, { ...plan.fields, completedAtServer: FieldValue.serverTimestamp() });
      return { choreId, status: 'completed', completion: plan.completion, previousCompletedSubTasks: plan.previousCompletedSubTasks };
    });
  });
}

const restoreOf = (value: unknown): SubTaskRestore | null => {
  if (!value || typeof value !== 'object') return null;
  const { from, to } = value as Record<string, unknown>;
  const fromList = stringList(from);
  const toList = stringList(to);
  return fromList && toList ? { from: fromList, to: toList } : null;
};

/**
 * Undoes one completion, only while `completionId` is still the chore's current
 * completion. Clears only completion fields; puts steps back only when they are
 * unchanged since the completion ticked them. Never restores a whole document.
 * An `undone` result carries the chore's stored `completedSubTasks` afterwards.
 */
export async function undoChoreCompletionAs(
  db: Firestore,
  householdId: string,
  input: { choreId: unknown; completionId: unknown; restoreSubTasks?: unknown },
): Promise<UndoOutcome> {
  const house = householdRef(db, householdId);
  const choreId = choreIdOf(input?.choreId);
  if (typeof input.completionId !== 'string' || !input.completionId || input.completionId.length > 100) {
    throw new ChoreCompletionError('invalid');
  }
  const completionId = input.completionId;
  const restore = restoreOf(input.restoreSubTasks);
  const ref = house.collection('chores').doc(choreId);
  return db.runTransaction(async tx => {
    await readHousehold(tx, house);
    const snap = await tx.get(ref);
    if (!snap.exists) return { choreId, status: 'missing' };
    const plan = planUndo(snap.data()!, completionId, restore);
    if (plan.kind === 'noop') return { choreId, status: plan.reason };
    tx.update(ref, {
      isCompleted: false,
      ...clearCompletion(),
      ...(plan.completedSubTasks ? { completedSubTasks: plan.completedSubTasks } : {}),
    });
    // Always the steps as stored after this Undo (restored, or kept because someone
    // changed them since), so the page shows them and a later step toggle starts from them.
    const completedSubTasks = plan.completedSubTasks ?? stringList(snap.get('completedSubTasks')) ?? [];
    return { choreId, status: 'undone', completedSubTasks };
  });
}

/** Reopens a completed chore (its points go away). Steps stay ticked. */
export async function reopenChoreAs(db: Firestore, householdId: string, input: { choreId: unknown }): Promise<ReopenOutcome> {
  const house = householdRef(db, householdId);
  const choreId = choreIdOf(input?.choreId);
  const ref = house.collection('chores').doc(choreId);
  return db.runTransaction(async tx => {
    await readHousehold(tx, house);
    const snap = await tx.get(ref);
    if (!snap.exists) return { choreId, status: 'missing' };
    if (planReopen(snap.data()!).kind === 'noop') return { choreId, status: 'open' };
    tx.update(ref, { isCompleted: false, ...clearCompletion() });
    return { choreId, status: 'reopened' };
  });
}
