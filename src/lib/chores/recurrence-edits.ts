import { storedOccurrenceKey } from '../../../functions/src/shared/ids';
import { occurrenceKeyDay } from '../../../functions/src/shared/skips';

/** The stored fields these helpers read. */
export type EditableChore = {
  id: string;
  templateId?: string | null;
  sourceType?: string | null;
  occurrenceKey?: string | null;
  roomIds?: string[];
  isCompleted?: boolean;
};

/**
 * A chore server upkeep generated from a repeating template. One-time chores
 * (Add Chore's "One time", a library assignment, quick add) carry a
 * `sourceType` and are never part of a series, even when they name a library
 * template (CH-4). Older one-time assignments have no `sourceType` either, so a
 * generated chore must also carry an occurrence (its stored key, or an id upkeep
 * would have generated).
 */
export function isGeneratedInstance(chore: Pick<EditableChore, 'id' | 'templateId' | 'sourceType' | 'occurrenceKey' | 'roomIds'>): boolean {
  return typeof chore.templateId === 'string' && chore.templateId !== ''
    && (chore.sourceType === undefined || chore.sourceType === null)
    && storedOccurrenceKey(chore.id, chore) !== null;
}

/**
 * The skips to record when `chores` are deleted: for each template, the
 * occurrence keys of its generated chores due today or later (CH-3). A past day
 * needs none: upkeep never generates a day before today.
 */
export function skipsForDeletion(chores: readonly EditableChore[], today: string): Map<string, string[]> {
  const byTemplate = new Map<string, string[]>();
  for (const chore of chores) {
    if (!isGeneratedInstance(chore)) continue;
    const key = storedOccurrenceKey(chore.id, chore);
    const day = key ? occurrenceKeyDay(key) : null;
    if (!key || !day || day < today) continue;
    const list = byTemplate.get(chore.templateId as string) ?? [];
    list.push(key);
    byTemplate.set(chore.templateId as string, list);
  }
  return byTemplate;
}

/**
 * What deleting a room does to chores in it (CH-4): open generated chores are
 * deleted (upkeep regenerates the series under the template's remaining rooms,
 * or "Around the house"); every other chore in the room (one-time chores,
 * completed history) stays, without the room.
 */
export function roomDeletionPlan(chores: readonly EditableChore[], roomId: string): { remove: string[]; detach: { id: string; roomIds: string[] }[] } {
  const remove: string[] = [];
  const detach: { id: string; roomIds: string[] }[] = [];
  for (const chore of chores) {
    if (!chore.roomIds?.includes(roomId)) continue;
    if (!chore.isCompleted && isGeneratedInstance(chore)) remove.push(chore.id);
    else detach.push({ id: chore.id, roomIds: chore.roomIds.filter(id => id !== roomId) });
  }
  return { remove, detach };
}
