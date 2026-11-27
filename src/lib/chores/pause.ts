/**
 * Away / sick pause (CH-32): skip a member's repeating chores for a range of days
 * with the same mechanism as deleting one day (CH-3): the occurrence keys go on each
 * template's `skippedOccurrences`, so upkeep and the calendar never bring those days
 * back. Resuming removes the keys again and upkeep regenerates the days from today.
 * Pure, shared by the server action and its tests.
 */
import { resolveAssigneeUid, type AssigneePerson } from '../../../functions/src/shared/assignee';
import { normalizeRecurrence, occursOn } from '../../../functions/src/shared/recurrence';
import { choreOccurrenceKey } from '../../../functions/src/shared/ids';
import { occurrenceNumber, rotationAnchor, rotationOf, rotationTurn } from '../../../functions/src/shared/rotation';
import { MAX_SKIPPED_OCCURRENCES, occurrenceKeyDay, skippedOccurrenceKeys } from '../../../functions/src/shared/skips';
import { addDaysToKey } from './dates';

/** The longest pause, in days (first and last day included). */
export const MAX_PAUSE_DAYS = 31;

const DAY = /^\d{4}-\d{2}-\d{2}$/;

export type PauseRange = { from: string; to: string };

export type PauseRangeCheck = { ok: true; range: PauseRange } | { ok: false; reason: 'invalid' | 'past' | 'too-long' };

/** Checks a range on the household day `today`: days before today are left out (they are never generated again anyway). */
export function checkPauseRange(input: { from?: unknown; to?: unknown }, today: string): PauseRangeCheck {
  const { from, to } = input ?? {};
  if (typeof from !== 'string' || typeof to !== 'string' || !DAY.test(from) || !DAY.test(to) || from > to) return { ok: false, reason: 'invalid' };
  if (to < today) return { ok: false, reason: 'past' };
  const start = from < today ? today : from;
  if (addDaysToKey(from, MAX_PAUSE_DAYS - 1) < to) return { ok: false, reason: 'too-long' };
  return { ok: true, range: { from: start, to } };
}

export type PauseTemplate = {
  id: string;
  recurrence?: unknown;
  roomIds?: unknown;
  assignedToUid?: unknown;
  assignedToEmail?: unknown;
  skippedOccurrences?: unknown;
  rotation?: unknown;
  rotationStart?: unknown;
};

/** The days in `range` (inclusive). */
export function rangeDays(range: PauseRange): string[] {
  const days: string[] = [];
  for (let day = range.from; day <= range.to && days.length <= MAX_PAUSE_DAYS; day = addDaysToKey(day, 1)) days.push(day);
  return days;
}

/**
 * The occurrence keys of `memberUid`'s repeating chores that fall in `range`, per
 * template: one per day the schedule has and per room (Around the house: "general").
 * A rotating chore (CH-28) counts only the days that are `memberUid`'s turn, judged
 * like upkeep (`eligible`: who can take a turn now), so pausing one person never
 * skips someone else's turn.
 */
export function pauseKeys(
  templates: readonly PauseTemplate[],
  memberUid: string,
  members: readonly AssigneePerson[],
  range: PauseRange,
  today: string,
  eligible: (uid: string) => boolean = () => true,
): Map<string, string[]> {
  const keys = new Map<string, string[]>();
  const days = rangeDays(range);
  for (const template of templates) {
    const recurrence = normalizeRecurrence(template.recurrence as never, today);
    if (!recurrence) continue;
    const rotation = rotationOf(template);
    if (rotation.length === 0 && resolveAssigneeUid(template as never, members as AssigneePerson[]) !== memberUid) continue;
    if (rotation.length > 0 && !rotation.includes(memberUid)) continue;
    const anchor = rotationAnchor(template);
    const theirs = (day: string) => rotation.length === 0 || rotationTurn(rotation, occurrenceNumber(recurrence, anchor, day), eligible) === memberUid;
    const rooms = Array.isArray(template.roomIds) && template.roomIds.length > 0
      ? template.roomIds.filter((room): room is string => typeof room === 'string')
      : ['general'];
    const found = days.filter(day => occursOn(day, recurrence) && theirs(day)).flatMap(day => rooms.map(room => choreOccurrenceKey(template.id, room, day)));
    if (found.length > 0) keys.set(template.id, found);
  }
  return keys;
}

/**
 * Whether adding `add` keeps every one of them on the template: the list holds at most
 * `MAX_SKIPPED_OCCURRENCES` keys from today on, and a pause that would push some out
 * is refused rather than half applied.
 */
export function pauseFits(existing: unknown, add: readonly string[], today: string): boolean {
  const kept = new Set([...skippedOccurrenceKeys({ skippedOccurrences: existing })].filter(key => (occurrenceKeyDay(key) ?? '') >= today));
  add.forEach(key => kept.add(key));
  return kept.size <= MAX_SKIPPED_OCCURRENCES;
}

/** A template's skipped keys after resuming: the given keys removed, the rest kept. */
export function withoutSkippedOccurrences(existing: unknown, remove: readonly string[]): string[] {
  const drop = new Set(remove);
  return [...skippedOccurrenceKeys({ skippedOccurrences: existing })].filter(key => !drop.has(key));
}

export type PauseOutcome =
  | { status: 'paused'; templates: number; removed: number; days: number }
  | { status: 'resumed'; templates: number; days: number }
  | { status: 'refused'; reason: 'invalid' | 'past' | 'too-long' | 'too-many' | 'forbidden' | 'not-member' };

/** What to tell the person after a pause or resume. */
export function pauseMessage(outcome: PauseOutcome, name: string): { title: string; description?: string; failed?: boolean } {
  if (outcome.status === 'paused') {
    return outcome.templates === 0
      ? { title: 'Nothing to pause', description: `${name} has no repeating chores on those days.` }
      : { title: 'Chores paused', description: `${name}'s repeating chores are skipped on ${outcome.days} ${outcome.days === 1 ? 'day' : 'days'}.` };
  }
  if (outcome.status === 'resumed') {
    return outcome.templates === 0 ? { title: 'Nothing to resume' } : { title: 'Chores resumed', description: `${name}'s repeating chores are back on those days.` };
  }
  const reasons: Record<typeof outcome.reason, string> = {
    invalid: 'Pick a first and a last day.',
    past: 'Those days are over.',
    'too-long': `Pause at most ${MAX_PAUSE_DAYS} days at a time.`,
    'too-many': 'Too many days are already skipped for one of these chores. Pause fewer days.',
    forbidden: 'Only someone who can delete chores can pause another person\'s chores.',
    'not-member': 'That person is no longer in the household.',
  };
  return { title: "Couldn't pause", description: reasons[outcome.reason], failed: true };
}
