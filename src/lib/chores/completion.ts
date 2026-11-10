/**
 * Completing, undoing and reopening chores (H3: CH-2, CH-12, D-7). The server
 * actions in `src/app/chores/actions.ts` apply these plans inside Admin SDK
 * transactions (`src/lib/server/chore-completion.ts`); clients never write
 * completion fields themselves. Pure (no Firebase), so eligibility and undo are
 * unit-tested.
 *
 * - A chore due after today, in the household's timezone, cannot be completed
 *   (no farming points from future occurrences).
 * - The person who completes a chore is recorded (`completedByUid`, `...Email`,
 *   `...Name`) and gets the points.
 * - Every completion carries a random `completionId`; Undo reverts only while it
 *   still matches, so an Undo can never revert someone else's later completion.
 */
import { UNDO_WINDOW_MS } from '../undo-window';
import { publicDisplayName } from '../member-directory';
import { addDays, isDayString, localDay, safeTimeZone, toDay, zonedMidnightIso } from '../../../functions/src/shared/calendar';

/** Undo is offered this long after completing. */
export const CHORE_UNDO_MS = UNDO_WINDOW_MS;

/** At most this many chores per completion request (one transaction). */
export const MAX_COMPLETION_BATCH = 50;

export type StoredChore = {
  isCompleted?: unknown;
  completedAt?: unknown;
  completedSubTasks?: unknown;
  subTasks?: unknown;
  originalDueDate?: unknown;
  dueDate?: unknown;
  completionId?: unknown;
  completedByUid?: unknown;
  completedByEmail?: unknown;
  completedByName?: unknown;
};

/** Who completed a chore and when, as the client shows it. */
export type CompletionRecord = {
  completionId: string | null;
  completedAt: string | null;
  completedByUid: string | null;
  completedByEmail: string | null;
  completedByName: string | null;
  completedSubTasks: string[];
};

export type Completer = { uid: string; email: string; name: string };

/** The completion fields a server completion writes (plus `completedAtServer`). */
export type CompletionWrite = {
  isCompleted: true;
  completedAt: string;
  completedByUid: string;
  completedByEmail: string;
  completedByName: string;
  completionId: string;
  completedSubTasks?: string[];
};

/** Fields every un-completion removes. `completedSubTasks` is handled separately. */
export const COMPLETION_FIELDS = [
  'completedAt', 'completedAtServer', 'completedByUid', 'completedByEmail', 'completedByName', 'completionId',
] as const;

/** Firestore's limit on a document ID, in UTF-8 bytes. */
export const MAX_DOC_ID_BYTES = 1500;

/**
 * A chore document ID as Firestore allows it: one non-empty path segment (no
 * '/'), at most 1500 UTF-8 bytes, not '.' or '..', not reserved (`__…__`).
 * Upkeep's recurring IDs (`recurringChoreId`: template ID, room ID, day and
 * assignee email) can be well over 200 characters, so the generic 200-character
 * `isDocId` would refuse legitimate chores.
 */
export function isChoreDocId(id: unknown): id is string {
  if (typeof id !== 'string' || id === '' || id.includes('/')) return false;
  if (id === '.' || id === '..' || /^__.*__$/.test(id)) return false;
  return new TextEncoder().encode(id).length <= MAX_DOC_ID_BYTES;
}

const str = (value: unknown): string | null => (typeof value === 'string' && value ? value : null);

/** A list of strings (at most 100, each at most 500 characters), or null. */
export function stringList(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > 100) return null;
  if (!value.every(item => typeof item === 'string' && item.length <= 500)) return null;
  return [...value] as string[];
}

const sameList = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((item, index) => item === b[index]);

/**
 * The day a chore is due in the household's timezone: `originalDueDate` when it
 * is a day, else `dueDate` read in that zone. Null when the chore has no due date.
 */
export function householdDueDay(chore: Pick<StoredChore, 'originalDueDate' | 'dueDate'>, timeZone: string): string | null {
  const zone = safeTimeZone(timeZone);
  if (isDayString(chore.originalDueDate)) return chore.originalDueDate;
  return toDay(chore.dueDate, zone) ?? toDay(chore.originalDueDate, zone);
}

/** Today (`YYYY-MM-DD`) in the household's timezone: the day completion eligibility is judged on. */
export function householdToday(now: Date, timeZone: unknown): string {
  return localDay(now, safeTimeZone(timeZone));
}

/** Milliseconds until the next midnight in the household's timezone (at least one second). */
export function msUntilHouseholdMidnight(now: Date, timeZone: unknown): number {
  const zone = safeTimeZone(timeZone);
  const next = Date.parse(zonedMidnightIso(addDays(localDay(now, zone), 1), zone));
  return Math.max(1000, next - now.getTime());
}

/**
 * True when the chore is due after `today`, a household-local day
 * (`householdToday`). The client disables completion with this and the server
 * refuses with it (`completionEligibility`), so both judge the same day.
 */
export function isDueAfterHouseholdDay(chore: Pick<StoredChore, 'originalDueDate' | 'dueDate'>, today: string, timeZone: unknown): boolean {
  const due = householdDueDay(chore, safeTimeZone(timeZone));
  return due !== null && due > today;
}

/** 'early' when the chore is due after today in the household's timezone (CH-2). */
export function completionEligibility(chore: Pick<StoredChore, 'originalDueDate' | 'dueDate'>, now: Date, timeZone: string): 'ok' | 'early' {
  return isDueAfterHouseholdDay(chore, householdToday(now, timeZone), timeZone) ? 'early' : 'ok';
}

/** What the stored chore says about its current completion. */
export function completionRecord(chore: StoredChore): CompletionRecord {
  return {
    completionId: str(chore.completionId),
    completedAt: str(chore.completedAt),
    completedByUid: str(chore.completedByUid),
    completedByEmail: str(chore.completedByEmail),
    completedByName: str(chore.completedByName),
    completedSubTasks: stringList(chore.completedSubTasks) ?? [],
  };
}

export type CompletionPlan =
  | { kind: 'early'; dueDay: string }
  | { kind: 'already'; completion: CompletionRecord }
  | { kind: 'complete'; fields: CompletionWrite; completion: CompletionRecord; previousCompletedSubTasks: string[] | null };

/**
 * How to complete one chore. Already completed: nothing to write, and the result
 * says who did it (idempotent). Due after today: refused. Otherwise the completion
 * fields, with every step ticked when `completeSubTasks` and some are open
 * (`previousCompletedSubTasks` is then what Undo puts back).
 */
export function planCompletion(
  chore: StoredChore,
  options: { completer: Completer; now: Date; timeZone: string; completeSubTasks: boolean; completionId: string },
): CompletionPlan {
  if (chore.isCompleted === true) return { kind: 'already', completion: completionRecord(chore) };
  if (completionEligibility(chore, options.now, options.timeZone) === 'early') {
    return { kind: 'early', dueDay: householdDueDay(chore, options.timeZone) ?? '' };
  }
  const fields: CompletionWrite = {
    isCompleted: true,
    completedAt: options.now.toISOString(),
    completedByUid: options.completer.uid,
    completedByEmail: options.completer.email,
    completedByName: options.completer.name,
    completionId: options.completionId,
  };
  const subTasks = stringList(chore.subTasks) ?? [];
  const before = stringList(chore.completedSubTasks) ?? [];
  let previousCompletedSubTasks: string[] | null = null;
  if (options.completeSubTasks && subTasks.some(step => !before.includes(step))) {
    fields.completedSubTasks = [...subTasks];
    previousCompletedSubTasks = before;
  }
  return {
    kind: 'complete',
    fields,
    previousCompletedSubTasks,
    completion: {
      completionId: fields.completionId,
      completedAt: fields.completedAt,
      completedByUid: fields.completedByUid,
      completedByEmail: fields.completedByEmail,
      completedByName: fields.completedByName,
      completedSubTasks: fields.completedSubTasks ?? before,
    },
  };
}

/** Per-chore result of a completion request (server action → client). */
export type ChoreCompletionOutcome =
  | { choreId: string; status: 'completed'; completion: CompletionRecord; previousCompletedSubTasks: string[] | null }
  | { choreId: string; status: 'already'; completion: CompletionRecord }
  | { choreId: string; status: 'refused'; refused: 'early'; dueDay: string }
  | { choreId: string; status: 'refused'; refused: 'missing' };

/** `undone` carries the stored steps after the Undo (restored or preserved), which the page applies. */
export type UndoOutcome =
  | { choreId: string; status: 'undone'; completedSubTasks: string[] }
  | { choreId: string; status: 'stale' | 'open' | 'missing' };
export type ReopenOutcome = { choreId: string; status: 'reopened' | 'open' | 'missing' };

/** Steps Undo may put back: only if they are still exactly what the completion ticked. */
export type SubTaskRestore = { from: string[]; to: string[] };

export type UndoPlan =
  | { kind: 'noop'; reason: 'open' | 'stale' }
  | { kind: 'undo'; completedSubTasks: string[] | null };

/**
 * How to undo one completion. Only the completion named by `completionId` is
 * reverted (a reopen and a new completion in between give a new id, so a late
 * Undo is a no-op). Only completion fields are cleared; steps are restored only
 * when they are unchanged since the completion ticked them, and only to steps
 * the chore still has.
 */
export function planUndo(chore: StoredChore, completionId: string, restore?: SubTaskRestore | null): UndoPlan {
  if (chore.isCompleted !== true) return { kind: 'noop', reason: 'open' };
  if (!completionId || str(chore.completionId) !== completionId) return { kind: 'noop', reason: 'stale' };
  const current = stringList(chore.completedSubTasks);
  const from = restore ? stringList(restore.from) : null;
  const to = restore ? stringList(restore.to) : null;
  if (!current || !from || !to || !sameList(current, from)) return { kind: 'undo', completedSubTasks: null };
  const steps = new Set(stringList(chore.subTasks) ?? []);
  return { kind: 'undo', completedSubTasks: to.filter(step => steps.has(step)) };
}

/** Reopening: nothing to do for an open chore; otherwise clear the completion fields (steps stay ticked). */
export function planReopen(chore: StoredChore): { kind: 'noop' } | { kind: 'reopen' } {
  return chore.isCompleted === true ? { kind: 'reopen' } : { kind: 'noop' };
}

/**
 * Plain-language name for who completed a chore ("Done by Sam"), or null when not
 * recorded: the current member name for `completedByUid`, else the stored name.
 * Never an email address (HO-9): housemates never see each other's emails.
 */
export function completerLabel(
  chore: Pick<StoredChore, 'completedByUid' | 'completedByName'>,
  nameForUid?: (uid: string) => string | undefined,
): string | null {
  const uid = str(chore.completedByUid);
  const known = uid && nameForUid ? nameForUid(uid) : undefined;
  return known || publicDisplayName(chore.completedByName, '') || null;
}
