/**
 * Targeted optimistic rollback. When one write fails, only the fields that write
 * changed are put back on only its chores, so changes made meanwhile (another
 * completion that succeeded, a reassignment, a reload) are kept.
 */
import type { ChoreRecord } from './dates';

export type CompletionFields = Pick<ChoreRecord,
  'isCompleted' | 'completedAt' | 'completedSubTasks' | 'completedAtServer' |
  'completedByUid' | 'completedByEmail' | 'completedByName' | 'completionId'>;

export function completionFields(chore: ChoreRecord): CompletionFields {
  return {
    isCompleted: chore.isCompleted,
    completedAt: chore.completedAt,
    completedSubTasks: chore.completedSubTasks,
    completedAtServer: chore.completedAtServer,
    completedByUid: chore.completedByUid,
    completedByEmail: chore.completedByEmail,
    completedByName: chore.completedByName,
    completionId: chore.completionId,
  };
}

/** Applies saved fields to the matching chores and leaves every other chore as it is now. */
export function restoreChoreFields<T extends ChoreRecord>(chores: readonly T[], saved: ReadonlyMap<string, Partial<ChoreRecord>>): T[] {
  return chores.map(chore => (saved.has(chore.id) ? { ...chore, ...saved.get(chore.id) } as T : chore));
}

/** How each Undo request ended, as the Chores page reconciles it. */
export type UndoSettlement = {
  /** The request never ran (offline, failed): put back the completion it hid. */
  restore: string[];
  /** The chore changed since (completed again: `stale`; deleted: `missing`): re-read it. */
  refresh: string[];
  /** Undone, with these steps put back. */
  steps: Map<string, string[]>;
};

type UndoResult =
  | { ok: true; data: { choreId: string; status: 'undone' | 'stale' | 'open' | 'missing'; completedSubTasks?: string[] } }
  | { ok: false };

/**
 * Sorts Undo results. `undone` and `open` (someone else reopened it first) both
 * leave the chore open, as the optimistic patch already shows it. Only a request
 * that never reached the server restores the completion the client saved; for
 * `stale` and `missing` that snapshot is outdated, so the chore is re-read.
 */
export function settleUndo(choreIds: readonly string[], results: readonly UndoResult[]): UndoSettlement {
  const settlement: UndoSettlement = { restore: [], refresh: [], steps: new Map() };
  choreIds.forEach((choreId, index) => {
    const result = results[index];
    if (!result || !result.ok) settlement.restore.push(choreId);
    else if (result.data.status === 'stale' || result.data.status === 'missing') settlement.refresh.push(choreId);
    else if (result.data.status === 'undone' && result.data.completedSubTasks) settlement.steps.set(choreId, result.data.completedSubTasks);
  });
  return settlement;
}

/**
 * Applies re-read chores: `null` means the chore no longer exists (removed);
 * otherwise its stored fields replace the local ones (local-only fields such as
 * the assignee's display name are kept). Chores not in `fresh` are unchanged.
 */
export function applyRefreshedChores<T extends ChoreRecord>(chores: readonly T[], fresh: ReadonlyMap<string, Record<string, unknown> | null>): T[] {
  return chores.flatMap(chore => {
    if (!fresh.has(chore.id)) return [chore];
    const stored = fresh.get(chore.id);
    if (stored === null || stored === undefined) return [];
    const next = { ...chore } as Record<string, unknown>;
    // Completion fields absent from the stored chore are absent here too.
    for (const field of ['completedAt', 'completedAtServer', 'completedByUid', 'completedByEmail', 'completedByName', 'completionId'] as const) delete next[field];
    return [{ ...next, ...stored, id: chore.id } as T];
  });
}
