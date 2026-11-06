/**
 * Firestore field updates for completing a chore and undoing it. Every client
 * that marks a chore done must use `completionUpdate`: the rules require a newly
 * completed chore to carry `completedAtServer == request.time`, which is what
 * makes points and streaks (H06) impossible to backdate.
 */
import { deleteField, serverTimestamp, type DocumentData } from 'firebase/firestore';
import type { Chore } from '../types';

export type CompletionSnapshot = {
  completedAt: Chore['completedAt'];
  completedSubTasks: Chore['completedSubTasks'];
};

/** What Undo must restore. Taken before the completion is written. */
export function completionSnapshot(chore: Pick<Chore, 'completedAt' | 'completedSubTasks'>): CompletionSnapshot {
  return {
    completedAt: chore.completedAt,
    completedSubTasks: chore.completedSubTasks ? [...chore.completedSubTasks] : chore.completedSubTasks,
  };
}

/** Marks a chore done. `completeSubTasks` ticks every sub-task too. */
export function completionUpdate(chore: Pick<Chore, 'subTasks'>, completeSubTasks: boolean, now = new Date()) {
  const completedAt = now.toISOString();
  const update: DocumentData = {
    isCompleted: true,
    completedAt,
    completedAtServer: serverTimestamp(),
  };
  if (completeSubTasks) update.completedSubTasks = [...(chore.subTasks || [])];
  return { update, local: { isCompleted: true, completedAt, ...(completeSubTasks ? { completedSubTasks: [...(chore.subTasks || [])] } : {}) } };
}

/** Restores a chore exactly as it was before it was completed. */
export function undoCompletionUpdate(snapshot: CompletionSnapshot) {
  return {
    update: {
      isCompleted: false,
      completedAt: snapshot.completedAt === undefined ? deleteField() : snapshot.completedAt,
      completedSubTasks: snapshot.completedSubTasks === undefined ? deleteField() : snapshot.completedSubTasks,
      completedAtServer: deleteField(),
    } as DocumentData,
    local: {
      isCompleted: false,
      completedAt: snapshot.completedAt,
      completedSubTasks: snapshot.completedSubTasks,
      completedAtServer: undefined,
    },
  };
}
