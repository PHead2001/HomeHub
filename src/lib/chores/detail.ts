/**
 * The chore detail sheet (CH-15): its history and what may be edited. Pure, so it is
 * unit-tested.
 */
import { completionInstant, type ChoreRecord } from './dates';
import { completerLabel } from './completion';
import { isGeneratedInstance } from './recurrence-edits';

export const HISTORY_LIMIT = 10;

export type HistoryEntry = { id: string; at: Date; by: string | null; current: boolean };

/**
 * Completions of this chore and the other days of its series (the same library
 * chore), newest first, at most `HISTORY_LIMIT`. Completed chores are kept 90 days.
 */
export function choreHistory(
  chore: Pick<ChoreRecord, 'id' | 'templateId'>,
  chores: readonly ChoreRecord[],
  nameOf: (uid: string) => string | undefined,
): HistoryEntry[] {
  const series = (other: ChoreRecord) => other.id === chore.id || (typeof chore.templateId === 'string' && chore.templateId !== '' && other.templateId === chore.templateId);
  return chores
    .flatMap(other => {
      const at = other.isCompleted && series(other) ? completionInstant(other) : null;
      return at ? [{ id: other.id, at, by: completerLabel(other, nameOf), current: other.id === chore.id }] : [];
    })
    .sort((a, b) => b.at.getTime() - a.at.getTime())
    .slice(0, HISTORY_LIMIT);
}

export type DetailEdit = { task: string; notes: string; dueDay?: string };

/** What the sheet's Edit may change: name and notes always; the day only for a chore that is not a generated day of a repeat (those move on the calendar). */
export function editableFields(chore: Pick<ChoreRecord, 'id' | 'templateId' | 'sourceType' | 'occurrenceKey' | 'roomIds' | 'isCompleted'>): { day: boolean } {
  return { day: !chore.isCompleted && !isGeneratedInstance(chore) };
}

export type DetailEditErrors = { task?: string; dueDay?: string };

/** Validates an edit like the rules do (a name of 1-500 characters, notes up to 5,000). */
export function validateDetailEdit(edit: DetailEdit): DetailEditErrors {
  const errors: DetailEditErrors = {};
  const task = edit.task.trim();
  if (!task) errors.task = 'Name the chore.';
  else if (task.length > 500) errors.task = 'Use at most 500 characters.';
  if (edit.dueDay !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(edit.dueDay)) errors.dueDay = 'Pick a day.';
  return errors;
}
