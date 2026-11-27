/**
 * Points, streaks, stickers and contribution (H06), derived on the client from
 * the household's chore history. Nothing here is stored: every number is
 * recomputed from chore documents, so there is no score field anyone could
 * write. The point rules (base, steps, on time, what earns points, the daily
 * cap) live in `functions/src/shared/chore-points.ts`. Completion times come from
 * the server-stamped `completedAtServer` when present, else `completedAt`.
 * Days are the household's (D-6) when a time zone is given.
 */
import { resolveAssigneeUid } from '../../../functions/src/shared/assignee';
import { localDay, safeTimeZone } from '../../../functions/src/shared/calendar';
import { MAX_MISSED_ENTRIES } from '../../../functions/src/shared/missed';
import {
  DAILY_POINT_CAP, POINTS, cappedDayPoints, choreBasePoints, creditedUid as sharedCreditedUid,
  pointsDueDay, pointsLedger, weekSummary, type DayOf, type WeekSummary,
} from '../../../functions/src/shared/chore-points';
import { addDaysToKey, completionInstant, dayKey, diffDayKeys, weekStartKey, type ChoreRecord } from './dates';
import { publicDisplayName, type HouseholdPerson } from '../member-directory';

export { DAILY_POINT_CAP, POINTS, type WeekSummary };

/** `email` only matches chores written before `assignedToUid` existed; it is never shown. */
export type StatsMember = { uid: string; name: string; role?: string; email?: string };

/**
 * The stats member for a household person, the same on the Chores page and the
 * dashboard streaks tile. The email, while records still carry one, is kept only
 * as a matching key so `creditedUid` and `resolveAssigneeUid` can credit older
 * chores (`completedByEmail` / `assignedToEmail` without a uid); it never reaches
 * `MemberChoreStats` or any label.
 */
export function statsMemberFrom(person: Pick<HouseholdPerson, 'uid' | 'displayName' | 'role' | 'email'>): StatsMember {
  return {
    uid: person.uid,
    name: publicDisplayName(person.displayName),
    role: person.role,
    ...(person.email ? { email: person.email } : {}),
  };
}

export type MemberChoreStats = {
  uid: string;
  name: string;
  /** Child accounts collect stickers instead of points. */
  stickerMode: boolean;
  /** Points this week (Monday to Sunday), each day capped at `DAILY_POINT_CAP`. */
  weekPoints: number;
  /** Points over the whole retained history (completed chores are kept 90 days). */
  totalPoints: number;
  /** Chores this member completed this week (any chore, earning or not). */
  weekCompleted: number;
  /** Stickers: one per chore completed this week that earns points (child accounts). */
  stickers: number;
  /**
   * Fair streak (CH-19): consecutive days this member had chores due and every one
   * of them was done by the end of its day (by anyone). Days with nothing due
   * neither break nor extend it; today counts once everything due today is done.
   */
  streak: number;
  /** False only while this member still has chores due today that are open. */
  streakActiveToday: boolean;
  /** Chores due this week that are assigned to this member. */
  weekAssigned: number;
  /** Of those, how many are done (by anyone). */
  weekAssignedDone: number;
  /** This member's share of the chores current members completed this week (0-1). */
  contributionShare: number;
};

export type ChoreStats = {
  weekStart: string;
  weekEnd: string;
  /** Chores due this week assigned to current members (CH-21: unknown assignees are left out). */
  weekTotal: number;
  /** Chores current members completed this week. */
  weekCompletedTotal: number;
  members: MemberChoreStats[];
};

/**
 * The household's day and zone (D-6, CH-10): completion instants are read as household
 * days, the same days the page and the server use. Without them, the device's own day.
 */
export type StatsOptions = {
  /** The household's time zone (D-6): completion days and today are read in it. */
  timeZone?: string | null;
  /** The household day to treat as today (defaults to the day of `now`). */
  today?: string;
  /**
   * Missed days that upkeep expired out of the chores (CH-7, `stats/missed-recent`,
   * `readMissedEntries`): each one breaks its assignee's fair streak on its day, exactly
   * as the open chore did before it expired. An entry whose occurrence a chore still
   * holds is not counted twice.
   */
  missed?: ReadonlyArray<{ key?: string; day: string; assignedToUid: string | null }>;
};

/** Days back a streak looks (completed chores are kept 90 days). */
export const STREAK_LOOKBACK_DAYS = 90;

const dayReader = (timeZone: string | null | undefined): DayOf =>
  timeZone ? (instant: Date) => localDay(instant, safeTimeZone(timeZone)) : dayKey;

/** Points for one completed chore before the daily cap, on device days (0 when open). */
export function chorePoints(chore: Pick<ChoreRecord, 'subTasks' | 'isCompleted' | 'completedAt' | 'completedAtServer' | 'originalDueDate' | 'dueDate'>): number {
  return choreBasePoints(chore, dayKey);
}

/**
 * Who a completed chore's points go to (D-7, CH-12): the member who completed it,
 * else its assignee for completions recorded before attribution existed; null when
 * that person is not among `members`. Shared with upkeep (chore-points.ts).
 */
export function creditedUid(
  chore: Pick<ChoreRecord, 'assignedToUid' | 'assignedToEmail' | 'completedByUid' | 'completedByEmail'>,
  members: readonly Pick<StatsMember, 'email' | 'uid'>[],
): string | null {
  return sharedCreditedUid(chore, members);
}

type DueDay = { total: number; done: number };

/**
 * A fair streak (CH-19) from a member's due days: walking back from today, each
 * day with chores due counts when all of them were done by the end of that day;
 * the first day with one left undone ends it. Today, while something due today is
 * still open, is not counted and does not break it.
 */
export function fairStreak(dueDays: ReadonlyMap<string, DueDay>, today: string): { streak: number; activeToday: boolean } {
  const days = [...dueDays.keys()].filter(day => day <= today).sort().reverse();
  let streak = 0;
  let activeToday = true;
  for (const day of days) {
    const entry = dueDays.get(day)!;
    const allDone = entry.done >= entry.total;
    if (day === today) {
      if (allDone) streak += 1;
      else activeToday = false;
      continue;
    }
    if (!allDone) break;
    streak += 1;
  }
  return { streak, activeToday };
}

/**
 * The first day a streak may count. `stats/missed-recent` keeps 90 days (as far as
 * streaks look) but at most `MAX_MISSED_ENTRIES`, latest first: once it is at that cap,
 * days up to its oldest entry may have lost entries, so they are unknown and a streak
 * ends there (only the days after the oldest entry are vouched for).
 */
export function missedHorizon(missed: StatsOptions['missed'], from: string): string {
  if (!missed || missed.length < MAX_MISSED_ENTRIES) return from;
  const oldest = missed.reduce((day, entry) => (entry.day < day ? entry.day : day), missed[0].day);
  const vouched = addDaysToKey(oldest, 1);
  return vouched > from ? vouched : from;
}

const byStanding = (a: MemberChoreStats, b: MemberChoreStats) =>
  b.weekPoints - a.weekPoints ||
  b.weekCompleted - a.weekCompleted ||
  b.streak - a.streak ||
  a.name.localeCompare(b.name);

/**
 * Stats for each member, best this week first. Points go to whoever completed the
 * chore (`creditedUid`), only for chores that earn them and at most
 * `DAILY_POINT_CAP` a day (CH-20). Streaks and "assigned" count the chores
 * assigned to each member; completions credited to someone who is no longer a
 * member, and chores assigned to no current member, are left out (CH-21).
 * Pass open chores too: streaks need the days that were missed.
 */
export function computeChoreStats(chores: readonly ChoreRecord[], members: readonly StatsMember[], now: Date, options: StatsOptions = {}): ChoreStats {
  const dayOf = dayReader(options.timeZone);
  const today = options.today ?? dayOf(now);
  const weekStart = weekStartKey(today);
  const weekEnd = addDaysToKey(weekStart, 6);
  const inWeek = (key: string) => key >= weekStart && key <= weekEnd;
  const streakFrom = missedHorizon(options.missed, addDaysToKey(today, -STREAK_LOOKBACK_DAYS));

  const ledger = pointsLedger(chores, members, dayOf, today);
  const assigned = new Map(members.map(member => [member.uid, { weekAssigned: 0, weekAssignedDone: 0, dueDays: new Map<string, DueDay>() }]));
  for (const chore of chores) {
    const due = pointsDueDay(chore, dayOf);
    if (!due) continue;
    const assignee = resolveAssigneeUid(chore, members);
    const entry = assignee ? assigned.get(assignee) : undefined;
    if (!entry) continue;
    const completed = completionInstant(chore);
    if (inWeek(due)) {
      entry.weekAssigned += 1;
      if (completed) entry.weekAssignedDone += 1;
    }
    if (due > today || due < streakFrom) continue;
    const day = entry.dueDays.get(due) ?? { total: 0, done: 0 };
    day.total += 1;
    if (completed && dayOf(completed) <= due) day.done += 1;
    entry.dueDays.set(due, day);
  }
  // CH-19 with CH-7: an expired missed day still counts as a day left undone.
  const heldKeys = new Set(chores.flatMap(chore => (chore.occurrenceKey ? [chore.occurrenceKey] : [])));
  for (const missed of options.missed ?? []) {
    if (missed.key && heldKeys.has(missed.key)) continue;
    const entry = missed.assignedToUid ? assigned.get(missed.assignedToUid) : undefined;
    if (!entry || missed.day > today || missed.day < streakFrom) continue;
    const day = entry.dueDays.get(missed.day) ?? { total: 0, done: 0 };
    day.total += 1;
    entry.dueDays.set(missed.day, day);
  }

  const result: MemberChoreStats[] = members.map(member => {
    const days = ledger.get(member.uid) ?? new Map();
    let totalPoints = 0;
    let weekPoints = 0;
    let weekCompleted = 0;
    let stickers = 0;
    for (const [day, entry] of days) {
      const points = cappedDayPoints(entry);
      totalPoints += points;
      if (!inWeek(day)) continue;
      weekPoints += points;
      weekCompleted += entry.completed;
      stickers += entry.earning;
    }
    const own = assigned.get(member.uid)!;
    const { streak, activeToday } = fairStreak(own.dueDays, today);
    return {
      uid: member.uid,
      name: member.name,
      stickerMode: member.role === 'child',
      weekPoints,
      totalPoints,
      weekCompleted,
      stickers,
      streak,
      streakActiveToday: activeToday,
      weekAssigned: own.weekAssigned,
      weekAssignedDone: own.weekAssignedDone,
      contributionShare: 0,
    };
  });
  const weekTotal = result.reduce((sum, member) => sum + member.weekAssigned, 0);
  const weekCompletedTotal = result.reduce((sum, member) => sum + member.weekCompleted, 0);
  for (const member of result) member.contributionShare = weekCompletedTotal > 0 ? member.weekCompleted / weekCompletedTotal : 0;

  return { weekStart, weekEnd, weekTotal, weekCompletedTotal, members: result.sort(byStanding) };
}

/**
 * How many days into a new week the podium shows the week that just closed
 * (CH-21: never before the week ends): Monday and Tuesday.
 */
export const PODIUM_DAYS = 2;

/** Monday of the closed week the podium shows on `today`, or null when it is not shown. */
export function podiumWeekStart(today: string): string | null {
  const thisWeek = weekStartKey(today);
  return diffDayKeys(thisWeek, today) < PODIUM_DAYS ? addDaysToKey(thisWeek, -7) : null;
}

/** A closed week's results computed from the retained chores (household days). */
export function closedWeekSummary(
  chores: readonly ChoreRecord[],
  members: readonly StatsMember[],
  weekStart: string,
  timeZone?: string | null,
): WeekSummary {
  return weekSummary(chores, members, weekStart, dayReader(timeZone));
}

/** Up to three members with points in a closed week, best first (index 0 is the MVP). */
export function weekPodium(summary: WeekSummary): WeekSummary['members'] {
  return summary.members.filter(member => member.points > 0).slice(0, 3);
}
