/**
 * Points, streaks, stickers and fair share (H06), derived on the client from the
 * household's chore completion history. Nothing here is stored: every number is
 * recomputed from chore documents, so there is no score field anyone could write.
 * Completion times come from the server-stamped `completedAtServer` when present
 * (the rules pin it to the request time), else the older `completedAt` string.
 */
import { addDaysToKey, choreDueKey, completionInstant, dayKey, weekStartKey, type ChoreRecord } from './dates';

export const POINTS = {
  /** Every completed chore. */
  base: 10,
  /** Each sub-task on the chore (bigger chores are worth more). */
  perSubTask: 2,
  /** Completed on or before the day it was due. */
  onTime: 5,
} as const;

export type StatsMember = { email: string; uid: string; name: string; role?: string };

export type MemberChoreStats = {
  email: string;
  uid: string;
  name: string;
  /** Child accounts collect stickers instead of points. */
  stickerMode: boolean;
  /** Points this week (Monday to Sunday). */
  weekPoints: number;
  /** Points over the whole retained history (completed chores are kept 90 days). */
  totalPoints: number;
  weekCompleted: number;
  /** Stickers: one per chore completed this week (child accounts). */
  stickers: number;
  /** Consecutive days with at least one completed chore, ending today or yesterday. */
  streak: number;
  /** True when today already counts toward the streak. */
  streakActiveToday: boolean;
  /** Chores due this week that are assigned to this member. */
  weekAssigned: number;
  /** This member's slice of this week's chores (0-1). */
  fairShare: number;
};

export type ChoreStats = {
  weekStart: string;
  weekEnd: string;
  /** All chores due this week, any assignee. */
  weekTotal: number;
  members: MemberChoreStats[];
};

export function chorePoints(chore: Pick<ChoreRecord, 'subTasks' | 'isCompleted' | 'completedAt' | 'completedAtServer' | 'originalDueDate' | 'dueDate'>): number {
  const completed = completionInstant(chore);
  if (!completed) return 0;
  const subTasks = Array.isArray(chore.subTasks) ? chore.subTasks.length : 0;
  const due = choreDueKey(chore);
  const onTime = due !== '' && dayKey(completed) <= due;
  return POINTS.base + subTasks * POINTS.perSubTask + (onTime ? POINTS.onTime : 0);
}

function streakFor(days: Set<string>, today: string): { streak: number; activeToday: boolean } {
  const activeToday = days.has(today);
  let cursor = activeToday ? today : addDaysToKey(today, -1);
  let streak = 0;
  while (days.has(cursor)) {
    streak += 1;
    cursor = addDaysToKey(cursor, -1);
  }
  return { streak, activeToday };
}

const byStanding = (a: MemberChoreStats, b: MemberChoreStats) =>
  b.weekPoints - a.weekPoints ||
  b.weekCompleted - a.weekCompleted ||
  b.streak - a.streak ||
  a.name.localeCompare(b.name);

/**
 * Who a completed chore's points go to (D-7, CH-12): the member who completed it
 * (`completedByUid`, else `completedByEmail`, written by the server), else its
 * assignee for completions recorded before attribution existed. Returns the
 * member's email, or the raw email when it matches no member.
 */
export function creditedEmail(
  chore: Pick<ChoreRecord, 'assignedToEmail' | 'completedByUid' | 'completedByEmail'>,
  members: readonly Pick<StatsMember, 'email' | 'uid'>[],
): string {
  if (chore.completedByUid) {
    const member = members.find(candidate => candidate.uid === chore.completedByUid);
    if (member) return member.email;
  }
  return chore.completedByEmail || chore.assignedToEmail;
}

/**
 * Stats for each member, best this week first. Points go to whoever completed the
 * chore (`creditedEmail`); fair share counts the chores assigned to each member.
 * Completions credited to someone who is no longer a member are ignored.
 */
export function computeChoreStats(chores: readonly ChoreRecord[], members: readonly StatsMember[], now: Date): ChoreStats {
  const today = dayKey(now);
  const weekStart = weekStartKey(today);
  const weekEnd = addDaysToKey(weekStart, 6);
  const inWeek = (key: string) => key >= weekStart && key <= weekEnd;

  const known = new Map(members.map(member => [member.email, member]));
  const acc = new Map(members.map(member => [member.email, {
    weekPoints: 0, totalPoints: 0, weekCompleted: 0, weekAssigned: 0, days: new Set<string>(),
  }]));

  let weekTotal = 0;
  for (const chore of chores) {
    const due = choreDueKey(chore);
    const entry = acc.get(chore.assignedToEmail);
    if (due && inWeek(due)) {
      weekTotal += 1;
      if (entry) entry.weekAssigned += 1;
    }
    const completed = completionInstant(chore);
    if (!completed) continue;
    const creditedTo = creditedEmail(chore, members);
    const credited = acc.get(creditedTo);
    if (!credited || !known.has(creditedTo)) continue;
    const completedDay = dayKey(completed);
    if (completedDay > today) continue; // clock skew: never count the future
    const points = chorePoints(chore);
    credited.totalPoints += points;
    credited.days.add(completedDay);
    if (inWeek(completedDay)) {
      credited.weekPoints += points;
      credited.weekCompleted += 1;
    }
  }

  const result: MemberChoreStats[] = members.map(member => {
    const entry = acc.get(member.email)!;
    const { streak, activeToday } = streakFor(entry.days, today);
    return {
      email: member.email,
      uid: member.uid,
      name: member.name,
      stickerMode: member.role === 'child',
      weekPoints: entry.weekPoints,
      totalPoints: entry.totalPoints,
      weekCompleted: entry.weekCompleted,
      stickers: entry.weekCompleted,
      streak,
      streakActiveToday: activeToday,
      weekAssigned: entry.weekAssigned,
      fairShare: weekTotal > 0 ? entry.weekAssigned / weekTotal : 0,
    };
  });

  return { weekStart, weekEnd, weekTotal, members: result.sort(byStanding) };
}

/** Up to three members with points this week, best first (index 0 is the MVP). */
export function weeklyPodium(stats: ChoreStats): MemberChoreStats[] {
  return stats.members.filter(member => member.weekPoints > 0).slice(0, 3);
}

/** The podium shows on Sundays, when the week's results are in. */
export function isPodiumDay(now: Date): boolean {
  return now.getDay() === 0;
}
