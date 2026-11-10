/**
 * Household streaks tile (H22, from H06). Built only from Chores' own
 * `computeChoreStats`, so the tile always agrees with the Chores leaderboard.
 */
import { statsMemberFrom, type ChoreStats, type StatsMember } from '../chores/stats';
import { approvedPeople } from '../member-directory';

export type StreakEntry = { uid: string; name: string; streak: number; activeToday: boolean };

export type StreakTileModel = {
  /** Members with a streak of at least one day, longest first (at most three). */
  top: StreakEntry[];
  /** Members with a running streak (any length). */
  running: number;
  /** Longest running streak in the household, in days (0 when nobody has one). */
  longest: number;
  /** Chores the household completed this week (Monday to Sunday). */
  weekCompleted: number;
};

const TOP = 3;

/**
 * Members for `computeChoreStats`, as the Chores page builds them: approved
 * (`status` active, not `newuser`) membership records, named by their public
 * display name (never an email; src/lib/member-directory.ts) via `statsMemberFrom`.
 * A record's email, while it still has one, only matches older chores.
 */
export function streakMembersFrom(records: ReadonlyArray<Record<string, unknown>>): StatsMember[] {
  return approvedPeople(records.map((record) => ({ id: typeof record.id === 'string' ? record.id : '', data: record })))
    .map(statsMemberFrom);
}

export function streakTileModel(stats: ChoreStats): StreakTileModel {
  const withStreak = stats.members
    .filter((member) => member.streak > 0)
    .map((member) => ({ uid: member.uid, name: member.name, streak: member.streak, activeToday: member.streakActiveToday }))
    .sort((a, b) => b.streak - a.streak || Number(b.activeToday) - Number(a.activeToday) || a.name.localeCompare(b.name));
  return {
    top: withStreak.slice(0, TOP),
    running: withStreak.length,
    longest: withStreak[0]?.streak ?? 0,
    weekCompleted: stats.members.reduce((sum, member) => sum + member.weekCompleted, 0),
  };
}

export const streakDaysLabel = (days: number) => `${days} ${days === 1 ? 'day' : 'days'}`;

/**
 * The tile's full sentence for screen readers (the visual number ticks in):
 * "Best streak: 3 days, Alex and 1 more on a streak. 5 chores done this week."
 */
export function streakSummary(model: StreakTileModel): string {
  const week = `${model.weekCompleted} ${model.weekCompleted === 1 ? 'chore' : 'chores'} done this week.`;
  if (model.longest <= 0 || model.top.length === 0) return `No streaks yet. ${week}`;
  const others = model.running > 1 ? ` and ${model.running - 1} more on a streak` : '';
  return `Best streak: ${streakDaysLabel(model.longest)}, ${model.top[0].name}${others}. ${week}`;
}

/**
 * The household's "Show leaderboard" setting from
 * `households/{id}/chore-settings/preferences`, read exactly as the Chores page
 * does (`useChoreSettings`): a missing document or a non-boolean field means on.
 * Pass `undefined` for a document that does not exist.
 */
export function leaderboardEnabledFrom(data: unknown): boolean {
  const value = data && typeof data === 'object' ? (data as Record<string, unknown>).leaderboardEnabled : undefined;
  return typeof value === 'boolean' ? value : true;
}

/**
 * Whether comparative chore stats (who is ahead: streak leader, top three, Wrapped's
 * champion) may be shown: only when the setting is known to be on. Unknown
 * (still loading) or unreadable stays hidden, so a household that turned the
 * leaderboard off never sees a ranking flash or leak.
 */
export const mayShowRanking = (leaderboard: 'on' | 'off' | 'unknown') => leaderboard === 'on';
