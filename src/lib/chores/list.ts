/**
 * Pure list logic for the Chores page: which chores show in To Do, how missed
 * recurring instances collapse, and what the signed-in member may do.
 */
import type { HouseholdPermission } from '../types';
import { choreDueKey, type ChoreRecord } from './dates';

export type ChoreCapabilities = {
  /** Mark chores done, tick sub-tasks, undo a completion. */
  canComplete: boolean;
  /** Add chores, temporary tasks and templates. */
  canCreate: boolean;
  /** Rename, reschedule, reassign, edit templates and rooms. */
  canEdit: boolean;
  /** Delete chores, templates and rooms. */
  canDelete: boolean;
  /** Pick someone other than yourself as the assignee. */
  canAssign: boolean;
};

/** Mirrors the Firestore rules for chores, chore-templates and rooms. */
export function choreCapabilities(permissions: Partial<Record<HouseholdPermission, boolean>> | null | undefined): ChoreCapabilities {
  const has = (permission: HouseholdPermission) => Boolean(permissions?.[permission]);
  return {
    canComplete: has('chores.complete'),
    canCreate: has('chores.create'),
    canEdit: has('chores.edit'),
    canDelete: has('chores.delete'),
    canAssign: has('chores.assign'),
  };
}

/** A To Do entry: the chore to show, plus older missed instances folded into it. */
export type ToDoEntry<T extends ChoreRecord = ChoreRecord> = {
  chore: T;
  /** Earlier incomplete instances of the same recurring chore, oldest first. */
  missed: T[];
};

const seriesKey = (chore: ChoreRecord) =>
  chore.templateId && chore.sourceType !== 'temporary'
    ? `${chore.templateId}|${(chore.roomIds || []).join(',')}|${chore.assignedToEmail}`
    : null;

/**
 * Collapses missed recurring instances. For each recurring series (same template,
 * rooms and assignee) only the latest instance due on or before today is listed;
 * the older incomplete ones are returned as `missed` so the page can say
 * "2 earlier missed" instead of piling up Aug 1, Aug 2, Aug 3 next to today.
 * One-time and temporary chores are never collapsed.
 */
export function collapseMissedRecurring<T extends ChoreRecord>(dueChores: readonly T[]): ToDoEntry<T>[] {
  const latest = new Map<string, ToDoEntry<T>>();
  const entries: ToDoEntry<T>[] = [];
  const sorted = [...dueChores].sort((a, b) => choreDueKey(a).localeCompare(choreDueKey(b)));
  for (const chore of sorted) {
    const key = seriesKey(chore);
    if (!key) {
      entries.push({ chore, missed: [] });
      continue;
    }
    const existing = latest.get(key);
    if (existing) {
      existing.missed.push(existing.chore);
      existing.chore = chore;
    } else {
      const entry = { chore, missed: [] as T[] };
      latest.set(key, entry);
      entries.push(entry);
    }
  }
  return entries.sort((a, b) => choreDueKey(a.chore).localeCompare(choreDueKey(b.chore)));
}

/** True when nothing due today or earlier is left (the "house is clean" moment). */
export function isToDoClear(chores: readonly ChoreRecord[], today: string): boolean {
  return !chores.some(chore => !chore.isCompleted && choreDueKey(chore) !== '' && choreDueKey(chore) <= today);
}

/** Sub-tasks that are still open on a chore. */
export function openSubTasks(chore: Pick<ChoreRecord, 'subTasks' | 'completedSubTasks'>): string[] {
  const done = new Set(chore.completedSubTasks || []);
  return (chore.subTasks || []).filter(subTask => !done.has(subTask));
}

/** Confetti size for a completion: bigger chores get a bigger burst. */
export function confettiCount(chore: Pick<ChoreRecord, 'subTasks'>): number {
  const subTasks = Array.isArray(chore.subTasks) ? chore.subTasks.length : 0;
  return Math.min(40, 10 + subTasks * 6);
}

/** A unique template id for a new chore name, avoiding existing ids. */
export function uniqueTemplateId(base: string, existing: ReadonlySet<string>): string {
  const root = base || 'chore';
  if (!existing.has(root)) return root;
  let n = 2;
  while (existing.has(`${root}-${n}`)) n += 1;
  return `${root}-${n}`;
}
