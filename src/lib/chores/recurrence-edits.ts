import { choreOccurrenceKey, storedOccurrenceKey } from '../../../functions/src/shared/ids';
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

/** Whether a generated chore's day is today or later (upkeep never regenerates an earlier day). */
export function isUpcomingInstance(chore: EditableChore, today: string): boolean {
  if (!isGeneratedInstance(chore)) return false;
  const key = storedOccurrenceKey(chore.id, chore);
  const day = key ? occurrenceKeyDay(key) : null;
  return day !== null && day >= today;
}

export type RoomDeletionPlan = {
  /** Open upcoming days of series that go on in their other rooms. */
  remove: string[];
  /** Every other chore in the room: it stays, without the room. */
  detach: { id: string; roomIds: string[] }[];
  /**
   * Per template left with no rooms: the "around the house" keys of the days kept by
   * detaching, so upkeep never generates a second chore for those days.
   */
  skips: Map<string, string[]>;
};

/**
 * What deleting a room does to chores in it (CH-4). An open generated day from
 * today on whose template still repeats in other rooms is deleted: the room is
 * gone and the series goes on there. Every other chore stays without the room:
 * overdue days (upkeep never regenerates them), one-time chores, completed
 * history, days whose template is gone, and days of a template left with no rooms
 * (it then repeats around the house, so the kept day's around-the-house key is
 * recorded as skipped and upkeep never duplicates it). Nothing is lost when a
 * series has no assignee (upkeep generates nothing for it).
 * `templateRooms` maps template ids to their rooms before the deletion.
 */
export function roomDeletionPlan(
  chores: readonly EditableChore[],
  roomId: string,
  today: string,
  templateRooms: ReadonlyMap<string, readonly string[]>,
): RoomDeletionPlan {
  const remove: string[] = [];
  const detach: { id: string; roomIds: string[] }[] = [];
  const skips = new Map<string, string[]>();
  for (const chore of chores) {
    if (!chore.roomIds?.includes(roomId)) continue;
    const rooms = chore.templateId ? templateRooms.get(chore.templateId) : undefined;
    const upcoming = !chore.isCompleted && isUpcomingInstance(chore, today) && rooms !== undefined;
    const remaining = rooms?.filter(id => id !== roomId) ?? [];
    if (upcoming && remaining.length > 0) {
      remove.push(chore.id);
      continue;
    }
    detach.push({ id: chore.id, roomIds: chore.roomIds.filter(id => id !== roomId) });
    if (upcoming) {
      const day = occurrenceKeyDay(storedOccurrenceKey(chore.id, chore) as string) as string;
      const templateId = chore.templateId as string;
      skips.set(templateId, [...(skips.get(templateId) ?? []), choreOccurrenceKey(templateId, 'general', day)]);
    }
  }
  return { remove, detach, skips };
}
