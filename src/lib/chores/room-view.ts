/**
 * The room layout of the Chores page (CH-13): what its header shows when the page
 * is filtered to one room. Pure, so it is unit-tested.
 */
import { completionInstant, type ChoreRecord } from './dates';
import { completerLabel } from './completion';

export type DoneTodayEntry = { id: string; task: string; byUid: string | null; byName: string | null };

/**
 * Chores completed on the household day `today`, newest first, with who did them
 * (the completer's current name, else the stored name; never an email).
 */
export function doneTodayEntries(
  chores: readonly ChoreRecord[],
  today: string,
  householdDayOf: (instant: Date) => string,
  nameOf: (uid: string) => string | undefined,
): DoneTodayEntry[] {
  return chores
    .flatMap(chore => {
      const instant = chore.isCompleted ? completionInstant(chore) : null;
      return instant && householdDayOf(instant) === today ? [{ chore, at: instant.getTime() }] : [];
    })
    .sort((a, b) => b.at - a.at)
    .map(({ chore }) => ({
      id: chore.id,
      task: chore.task,
      byUid: typeof chore.completedByUid === 'string' && chore.completedByUid ? chore.completedByUid : null,
      byName: completerLabel(chore, nameOf),
    }));
}

/** Whether the page shows the room layout: one room (or "Around the house") is chosen. */
export const isRoomView = (filterRoomId: string): boolean => filterRoomId !== 'all';
