/**
 * HP-32a: the household's work for today in one line, per person:
 * "Sam: Dishes (overdue) · Alex: Trash (today)". Pure, so it is unit tested.
 *
 * - Built from `ChoreFacts.todayWork` (every open chore that is overdue or due today,
 *   folded like the Chores To Do list), so it never hides overdue work: a person with
 *   anything overdue leads with it and says how much more is overdue, and folded
 *   missed instances are counted ("2 earlier missed").
 * - Names only: the member's display name, the reader is "You", nobody known is
 *   "Unassigned". An email is never shown (`memberName` drops one).
 */
import type { ChoreEntry } from './facts';

export type SummaryPart = {
  /** Grouping key (member uid or lower-cased email; '' for unassigned). Never shown. */
  key: string;
  /** "You", the member's name, "Unassigned" or "Someone" (a name we cannot show). */
  name: string;
  mine: boolean;
  /** The most urgent chore: overdue first, then today's. */
  first: { id: string; task: string; overdue: boolean };
  /** Their other chores today, and how many of those are overdue. */
  more: number;
  moreOverdue: number;
  /** Folded missed instances across their chores. */
  missed: number;
  overdue: number;
};

export type HouseholdSummary = { parts: SummaryPart[]; text: string };

const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

/** One person's phrase: "Sam: Dishes (overdue) and 2 more (1 overdue), 1 earlier missed". */
export function summaryPhrase(part: SummaryPart): string {
  let phrase = `${part.name}: ${part.first.task} (${part.first.overdue ? 'overdue' : 'today'})`;
  if (part.more > 0) phrase += ` and ${part.more} more${part.moreOverdue > 0 ? ` (${part.moreOverdue} overdue)` : ''}`;
  if (part.missed > 0) phrase += `, ${plural(part.missed, 'earlier missed', 'earlier missed')}`;
  return phrase;
}

/**
 * Groups today's work by assignee. People with overdue work come first (most
 * overdue first), then the reader, then by name; unassigned work comes last.
 */
export function householdSummary(work: readonly ChoreEntry[]): HouseholdSummary {
  const byKey = new Map<string, SummaryPart>();
  for (const chore of work) {
    if (chore.due !== undefined && chore.due !== 'overdue' && chore.due !== 'today') continue;
    const key = chore.mine ? `mine:${chore.assigneeKey ?? ''}` : chore.assigneeKey ?? '';
    const name = chore.mine ? 'You' : !key ? 'Unassigned' : chore.assignee || 'Someone';
    const part = byKey.get(key);
    if (!part) {
      byKey.set(key, {
        key,
        name,
        mine: chore.mine,
        first: { id: chore.id, task: chore.task, overdue: chore.overdue },
        more: 0,
        moreOverdue: 0,
        missed: chore.missed ?? 0,
        overdue: chore.overdue ? 1 : 0,
      });
      continue;
    }
    part.missed += chore.missed ?? 0;
    if (chore.overdue) part.overdue += 1;
    // An overdue chore after a today one (unsorted input) becomes the person's lead.
    if (chore.overdue && !part.first.overdue) {
      part.more += 1;
      part.first = { id: chore.id, task: chore.task, overdue: true };
      continue;
    }
    part.more += 1;
    if (chore.overdue) part.moreOverdue += 1;
  }
  const parts = [...byKey.values()].sort((a, b) =>
    Number(a.key === '') - Number(b.key === '')
    || b.overdue - a.overdue
    || Number(b.mine) - Number(a.mine)
    || a.name.localeCompare(b.name));
  return { parts, text: parts.map(summaryPhrase).join(' · ') };
}
