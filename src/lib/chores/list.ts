/**
 * Pure list logic for the Chores page: which chores show in To Do, how missed
 * recurring instances collapse, and what the signed-in member may do.
 */
import type { HouseholdPermission } from '../types';
import { choreDueKey, type ChoreRecord } from './dates';
import { stableSlugify } from '../../../functions/src/shared/ids';
import { resolveAssigneeUid, type AssigneePerson } from '../../../functions/src/shared/assignee';

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

/**
 * Generated recurring instances carry a `templateId` and no `sourceType`. One-time
 * library assignments are written with `sourceType: 'template'` and temporary
 * chores with `'temporary'`, so neither ever folds. Older one-time assignments
 * have no `sourceType` either; they fold only while their template currently has
 * a repeating schedule (`recurringTemplateIds`).
 */
const seriesKey = (chore: ChoreRecord, recurringTemplateIds: ReadonlySet<string>, people?: readonly AssigneePerson[]) =>
  chore.templateId && !chore.sourceType && recurringTemplateIds.has(chore.templateId)
    ? `${chore.templateId}|${(chore.roomIds || []).join(',')}|${seriesAssignee(chore, people)}`
    : null;

/**
 * The assignee part of a series key. With the household's people it is the member
 * `resolveAssigneeUid` names (the same rule every reader uses), so a series stays one
 * series whether its instances carry the email and uid (older) or the uid only
 * (generated since member privacy release C), and an older build's reassignment by
 * email (a stale uid left behind) counts for the member the email names. Without
 * people: the email while the record has one (it decides in that case), else the uid.
 */
const seriesAssignee = (chore: ChoreRecord, people?: readonly AssigneePerson[]) => {
  if (people) return resolveAssigneeUid(chore, people) ?? '';
  return chore.assignedToEmail?.toLowerCase() || chore.assignedToUid || '';
};

/**
 * Collapses missed recurring instances. For each recurring series (same template,
 * rooms and assignee) only the latest instance due on or before today is listed;
 * the older incomplete ones are returned as `missed` so the page can say
 * "2 earlier missed" instead of piling up Aug 1, Aug 2, Aug 3 next to today.
 * Instances due on the same day are never folded into each other, and one-time
 * and temporary chores are never collapsed.
 */
export function collapseMissedRecurring<T extends ChoreRecord>(
  dueChores: readonly T[],
  recurringTemplateIds: ReadonlySet<string>,
  /** The household's people (uid, email where known): assignees are resolved with `resolveAssigneeUid`. */
  people?: readonly AssigneePerson[],
): ToDoEntry<T>[] {
  const latest = new Map<string, ToDoEntry<T>>();
  const entries: ToDoEntry<T>[] = [];
  const sorted = [...dueChores].sort((a, b) => choreDueKey(a).localeCompare(choreDueKey(b)));
  for (const chore of sorted) {
    const key = seriesKey(chore, recurringTemplateIds, people);
    if (!key) {
      entries.push({ chore, missed: [] });
      continue;
    }
    const existing = latest.get(key);
    if (existing && choreDueKey(existing.chore) < choreDueKey(chore)) {
      // An older instance is a missed one; the newer instance takes its place.
      existing.missed.push(existing.chore);
      existing.chore = chore;
    } else if (existing) {
      // Same day (e.g. a one-time assignment next to a generated instance): not
      // "missed", so it stays its own row.
      entries.push({ chore, missed: [] });
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

/**
 * ID for a new chore template or room: a readable slug of the name plus a
 * Firestore auto-id, so it can never collide with a document this page has not
 * seen (offline cache, or one another member just created). Picking a "free"
 * slug from the loaded list could overwrite or merge into such a document.
 * Mirrors the shell's `quickCreateId`.
 */
export function newChoreDocId(label: string, autoId: string, fallback = 'chore'): string {
  const random = autoId.replace(/[^a-zA-Z0-9]/g, '');
  if (random.length < 16) throw new Error('newChoreDocId needs a Firestore auto-id');
  return `${(stableSlugify(label) || fallback).slice(0, 60)}-${random}`;
}
