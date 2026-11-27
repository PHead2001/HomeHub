/**
 * Steps (CH-33): ticking the last open step completes the chore. Pure, so it is
 * unit-tested.
 */
import type { ChoreRecord } from './dates';
import { openSubTasks } from './list';

/**
 * Whether ticking `subTask` would leave no open step on an open chore: then the page
 * completes the chore on the server instead of writing the step (the completion ticks
 * every step and its Undo puts the steps back as they were before this tick).
 */
export function tickCompletesChore(chore: Pick<ChoreRecord, 'subTasks' | 'completedSubTasks' | 'isCompleted'>, subTask: string): boolean {
  if (chore.isCompleted) return false;
  const open = openSubTasks(chore);
  return open.length === 1 && open[0] === subTask;
}
