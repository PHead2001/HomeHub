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
import type { OperationContext } from '@/lib/server/operation-context';
import { DeviceActionError } from '@/lib/server/device-errors';
import { assertActorRule, type DeviceAuthority } from '@/lib/server/device-gate';
import { assertUndoable, type DeviceOp } from '@/lib/server/device-ops';

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

type CompleteInput = { choreIds: unknown; completeSubTasks?: unknown };

/**
 * Completes chores as the operation's actor (design section 9). Per chore: already
 * completed is a no-op that reports who did it; a chore due after today (household
 * timezone) is refused; otherwise it is completed and attributed to the actor.
 * `completeSubTasks` ticks every step of chores that still have open ones.
 *
 * One transaction: the device hooks' `precheck` first (a replay of the same opId returns
 * the stored outcome and writes nothing), then the reads and writes, then `finalize`
 * (only when something was completed). A device completes one chore per call, with
 * `completionId == opId`, and stores `deviceAttribution` with the completion.
 *
 * The older form `(db, caller, householdId, input, now)` is the personal path and behaves
 * exactly as before.
 */
export function completeChoresAs(db: Firestore, householdId: string, input: CompleteInput, ctx: OperationContext): Promise<ChoreCompletionOutcome[]>;
export function completeChoresAs(db: Firestore, caller: CompletionCaller, householdId: string, input: CompleteInput, now?: Date): Promise<ChoreCompletionOutcome[]>;
export async function completeChoresAs(
  db: Firestore,
  first: string | CompletionCaller,
  second: string | CompleteInput,
  third: CompleteInput | OperationContext,
  fourth?: Date,
): Promise<ChoreCompletionOutcome[]> {
  if (typeof first === 'string') return completeWith(db, first, second as CompleteInput, third as OperationContext);
  const caller = first;
  return completeWith(db, second as string, third as CompleteInput, {
    actor: { uid: caller.uid, name: caller.displayName ?? '' },
    now: fourth ?? new Date(),
  });
}

async function completeWith(db: Firestore, householdId: string, input: CompleteInput, ctx: OperationContext): Promise<ChoreCompletionOutcome[]> {
  const house = householdRef(db, householdId);
  if (!Array.isArray(input?.choreIds) || input.choreIds.length === 0 || input.choreIds.length > MAX_COMPLETION_BATCH) {
    throw new ChoreCompletionError('invalid');
  }
  const choreIds = [...new Set(input.choreIds.map(choreIdOf))];
  // A device action completes one chore, identified by its opId.
  if (ctx.hooks && choreIds.length !== 1) throw new ChoreCompletionError('invalid');
  const completeSubTasks = input.completeSubTasks === true;
  const now = ctx.now;

  return db.runTransaction(async tx => {
    const { replay } = (await ctx.hooks?.precheck(tx)) ?? {};
    if (replay) return replay.summary.outcomes as ChoreCompletionOutcome[];
    const actor = ctx.actor;
    const [home, member, ...chores] = await tx.getAll(
      house,
      house.collection('members').doc(actor.uid),
      ...choreIds.map(id => house.collection('chores').doc(id)),
    );
    if (!home.exists || home.get('deletingAt')) throw new ChoreCompletionError('not-found');
    const timeZone = safeTimeZone(home.get('timeZone'));
    const memberName = member.get('displayName');
    const completer = {
      uid: actor.uid,
      // Shown to every member ("Done by Sam"): a name, never an email (HO-9).
      name: publicDisplayName(memberName, '') || publicDisplayName(actor.name),
    };
    let completedPath: string | null = null;
    const outcomes = chores.map((snap, index): ChoreCompletionOutcome => {
      const choreId = choreIds[index];
      if (!snap.exists) return { choreId, status: 'refused', refused: 'missing' };
      const completionId = ctx.hooks && ctx.opId ? ctx.opId : randomUUID();
      const plan = planCompletion(snap.data()!, { completer, now, timeZone, completeSubTasks, completionId });
      if (plan.kind === 'early') return { choreId, status: 'refused', refused: 'early', dueDay: plan.dueDay };
      if (plan.kind === 'already') return { choreId, status: 'already', completion: plan.completion };
      // A completion reopened by an older client can still carry the previous completer's
      // email: remove it, so the shared chore never pairs someone else's email with this uid
      // (the migration would read that pair as evidence of whose email it is).
      tx.update(snap.ref, {
        ...plan.fields,
        completedByEmail: FieldValue.delete(),
        completedAtServer: FieldValue.serverTimestamp(),
        // A device completion records the tablet, the person and the level; any older
        // attribution goes (it described an earlier completion).
        deviceAttribution: actor.device ?? FieldValue.delete(),
      });
      completedPath = snap.ref.path;
      return { choreId, status: 'completed', completion: plan.completion, previousCompletedSubTasks: plan.previousCompletedSubTasks };
    });
    if (completedPath) {
      ctx.hooks?.finalize(tx, {
        targetPath: completedPath,
        summary: { outcomes: JSON.parse(JSON.stringify(outcomes)) },
        targetName: typeof chores[0]?.get('task') === 'string' ? chores[0]!.get('task') : null,
      });
    }
    return outcomes;
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
 *
 * With device hooks (`chores.complete.undo`, design 10.1) the opId names the original
 * completion: its ledger entry decides. None yet: a tombstone, `not_applied`. Already
 * undone: `already`. Applied: same device generation, the original actor, inside the
 * window, and the chore's completion still that one (`completionId == opId`), else
 * `changed_since`; the steps it ticked come back from the ledger's stored outcome.
 */
export function undoChoreCompletionAs(db: Firestore, householdId: string, input: { choreId: unknown; completionId: unknown; restoreSubTasks?: unknown }): Promise<UndoOutcome>;
export function undoChoreCompletionAs(
  db: Firestore, householdId: string, input: { choreId?: unknown; completionId?: unknown; restoreSubTasks?: unknown },
  ctx: OperationContext & { authority?: DeviceAuthority },
): Promise<UndoOutcome | DeviceUndoOutcome>;
export async function undoChoreCompletionAs(
  db: Firestore,
  householdId: string,
  input: { choreId?: unknown; completionId?: unknown; restoreSubTasks?: unknown },
  ctx?: OperationContext & { authority?: DeviceAuthority },
): Promise<UndoOutcome | DeviceUndoOutcome> {
  const house = householdRef(db, householdId);
  if (ctx?.hooks) return undoDeviceCompletion(db, house, ctx);
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

/** Device Undo answers beyond the personal ones: never applied (a tombstone now holds the opId), or already undone. */
export type DeviceUndoOutcome = { choreId: string | null; status: 'not_applied' | 'already' };

/** The chore a ledger entry points at (`households/h/chores/<id>`). */
const choreOfEntry = (house: DocumentReference, entry: DeviceOp): DocumentReference => {
  const prefix = `${house.path}/chores/`;
  if (!entry.targetPath || !entry.targetPath.startsWith(prefix)) throw new DeviceActionError('not_undoable');
  return house.collection('chores').doc(choreIdOf(entry.targetPath.slice(prefix.length)));
};

const undoContext = (ctx: OperationContext & { authority?: DeviceAuthority }) => {
  const authority = ctx.authority;
  if (!authority || !ctx.opId) throw new DeviceActionError('invalid_input');
  return authority;
};

async function undoDeviceCompletion(db: Firestore, house: DocumentReference, ctx: OperationContext & { authority?: DeviceAuthority }): Promise<UndoOutcome | DeviceUndoOutcome> {
  const authority = undoContext(ctx);
  return db.runTransaction(async tx => {
    const plan = await ctx.hooks!.precheck(tx);
    if (plan.undo === 'already') return { choreId: null, status: 'already' };
    if (plan.undo === 'tombstone' || !plan.original) {
      ctx.hooks!.finalize(tx, { targetPath: '', summary: {}, undo: 'tombstone' });
      return { choreId: null, status: 'not_applied' };
    }
    const original = plan.original;
    const actor = authority.actor!;
    assertActorRule(authority, original.actorUid);
    assertUndoable(original, { generation: authority.generation, actorUid: actor.uid, now: authority.now, actorRuleAllows: false, queuedUndo: authority.queued });
    await readHousehold(tx, house);
    const ref = choreOfEntry(house, original);
    const snap = await tx.get(ref);
    const choreId = ref.id;
    if (!snap.exists) throw new DeviceActionError('changed_since');
    const stored = (original.summary.outcomes as ChoreCompletionOutcome[] | undefined)?.find(outcome => outcome.choreId === choreId);
    const restore = stored && stored.status === 'completed' && stored.previousCompletedSubTasks
      ? { from: stored.completion.completedSubTasks, to: stored.previousCompletedSubTasks }
      : null;
    const undo = planUndo(snap.data()!, ctx.opId!, restore);
    // Someone reopened or completed it again since: never reverted here.
    if (undo.kind === 'noop') throw new DeviceActionError('changed_since');
    tx.update(ref, {
      isCompleted: false,
      ...clearCompletion(),
      ...(undo.completedSubTasks ? { completedSubTasks: undo.completedSubTasks } : {}),
    });
    ctx.hooks!.finalize(tx, { targetPath: ref.path, summary: { choreId }, undo: 'reversed', targetName: typeof snap.get('task') === 'string' ? snap.get('task') : null });
    const completedSubTasks = undo.completedSubTasks ?? stringList(snap.get('completedSubTasks')) ?? [];
    return { choreId, status: 'undone', completedSubTasks };
  });
}

/** What a take or its Undo did. */
export type TakeOutcome =
  | { choreId: string; status: 'taken' | 'already_yours' }
  | { choreId: string | null; status: 'untaken' | 'not_applied' | 'already' };

/**
 * Takes an open chore for the actor (S14): only an unassigned chore (no uid and no
 * legacy email) or one already the actor's (a no-op, R3). Writes only the assignment
 * fields. The previous assignment is kept in the op ledger's summary so the Undo can put
 * it back. Attribution of a take lives in the ledger (and the activity log for PIN-level
 * takes), not on the chore (R4, JC-29).
 */
export async function takeChoreAs(db: Firestore, householdId: string, input: { choreId: unknown }, ctx: OperationContext): Promise<TakeOutcome> {
  const house = householdRef(db, householdId);
  const ref = house.collection('chores').doc(choreIdOf(input?.choreId));
  return db.runTransaction(async tx => {
    const { replay } = (await ctx.hooks?.precheck(tx)) ?? {};
    if (replay) return replay.summary.outcome as TakeOutcome;
    await readHousehold(tx, house);
    const snap = await tx.get(ref);
    if (!snap.exists) throw new ChoreCompletionError('not-found');
    if (snap.get('isCompleted') === true) throw new DeviceActionError('invalid_input');
    const assignedUid = typeof snap.get('assignedToUid') === 'string' ? snap.get('assignedToUid') as string : '';
    const assignedEmail = typeof snap.get('assignedToEmail') === 'string' ? (snap.get('assignedToEmail') as string).trim() : '';
    const actor = ctx.actor;
    const task = typeof snap.get('task') === 'string' ? snap.get('task') as string : null;
    if (assignedUid === actor.uid) {
      // Already theirs: nothing changes; the ledger records a no-op the Undo leaves alone (R3).
      const outcome: TakeOutcome = { choreId: ref.id, status: 'already_yours' };
      ctx.hooks?.finalize(tx, { targetPath: ref.path, summary: { outcome, noop: true }, targetName: task });
      return outcome;
    }
    // Someone else's chore is a reassignment, which tablets don't offer.
    if (assignedUid || assignedEmail) throw new DeviceActionError('not_on_tablets');
    const name = publicDisplayName(actor.name);
    tx.update(ref, { assignedToUid: actor.uid, assignedToDisplayName: name });
    const outcome: TakeOutcome = { choreId: ref.id, status: 'taken' };
    ctx.hooks?.finalize(tx, {
      targetPath: ref.path,
      summary: {
        outcome,
        noop: false,
        // What the Undo puts back: the fields exactly as they were (null: absent).
        previous: {
          assignedToUid: snap.get('assignedToUid') ?? null,
          assignedToDisplayName: snap.get('assignedToDisplayName') ?? null,
        },
      },
      targetName: task,
    });
    return outcome;
  });
}

/**
 * Undoes a take (`chores.take.undo`): a no-op take answers `already` (R3); otherwise, while
 * the chore is still assigned to the actor, the previous assignment comes back exactly;
 * a chore someone reassigned since is left alone (`changed_since`).
 */
export async function undoTakeChoreAs(db: Firestore, householdId: string, ctx: OperationContext & { authority?: DeviceAuthority }): Promise<TakeOutcome> {
  const house = householdRef(db, householdId);
  const authority = undoContext(ctx);
  return db.runTransaction(async tx => {
    const plan = await ctx.hooks!.precheck(tx);
    if (plan.undo === 'already') return { choreId: null, status: 'already' };
    if (plan.undo === 'tombstone' || !plan.original) {
      ctx.hooks!.finalize(tx, { targetPath: '', summary: {}, undo: 'tombstone' });
      return { choreId: null, status: 'not_applied' };
    }
    const original = plan.original;
    const actor = authority.actor!;
    assertActorRule(authority, original.actorUid);
    assertUndoable(original, { generation: authority.generation, actorUid: actor.uid, now: authority.now, actorRuleAllows: false, queuedUndo: authority.queued });
    const ref = choreOfEntry(house, original);
    if (original.summary.noop === true) return { choreId: ref.id, status: 'already' };
    await readHousehold(tx, house);
    const snap = await tx.get(ref);
    if (!snap.exists || snap.get('assignedToUid') !== original.actorUid) throw new DeviceActionError('changed_since');
    const previous = (original.summary.previous ?? {}) as { assignedToUid?: unknown; assignedToDisplayName?: unknown };
    tx.update(ref, {
      assignedToUid: typeof previous.assignedToUid === 'string' ? previous.assignedToUid : FieldValue.delete(),
      assignedToDisplayName: typeof previous.assignedToDisplayName === 'string' ? previous.assignedToDisplayName : FieldValue.delete(),
    });
    ctx.hooks!.finalize(tx, { targetPath: ref.path, summary: { choreId: ref.id }, undo: 'reversed', targetName: typeof snap.get('task') === 'string' ? snap.get('task') : null });
    return { choreId: ref.id, status: 'untaken' };
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
