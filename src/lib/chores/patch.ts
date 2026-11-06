/**
 * Targeted optimistic rollback. When one write fails, only the fields that write
 * changed are put back on only its chores, so changes made meanwhile (another
 * completion that succeeded, a reassignment, a reload) are kept.
 */
import type { ChoreRecord } from './dates';

export type CompletionFields = Pick<ChoreRecord, 'isCompleted' | 'completedAt' | 'completedSubTasks' | 'completedAtServer'>;

export function completionFields(chore: ChoreRecord): CompletionFields {
  return {
    isCompleted: chore.isCompleted,
    completedAt: chore.completedAt,
    completedSubTasks: chore.completedSubTasks,
    completedAtServer: chore.completedAtServer,
  };
}

/** Applies saved fields to the matching chores and leaves every other chore as it is now. */
export function restoreChoreFields<T extends ChoreRecord>(chores: readonly T[], saved: ReadonlyMap<string, Partial<ChoreRecord>>): T[] {
  return chores.map(chore => (saved.has(chore.id) ? { ...chore, ...saved.get(chore.id) } as T : chore));
}
