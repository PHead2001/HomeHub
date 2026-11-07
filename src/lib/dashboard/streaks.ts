/**
 * Household streaks tile (H22, from H06). Built only from Chores' own
 * `computeChoreStats`, so the tile always agrees with the Chores leaderboard.
 */
import type { ChoreStats, StatsMember } from '../chores/stats';

export type StreakEntry = { email: string; name: string; streak: number; activeToday: boolean };

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
 * (`status` active, not `newuser`) membership records, named by display name or email.
 */
export function streakMembersFrom(records: ReadonlyArray<Record<string, unknown>>): StatsMember[] {
  return records.flatMap((record) => {
    const email = typeof record.email === 'string' ? record.email : '';
    const status = typeof record.status === 'string' ? record.status : 'active';
    if (!email || record.role === 'newuser' || status !== 'active') return [];
    const name = typeof record.displayName === 'string' && record.displayName.trim() ? record.displayName.trim() : email;
    const uid = typeof record.uid === 'string' && record.uid ? record.uid : email;
    return [{ email, uid, name, role: typeof record.role === 'string' ? record.role : undefined }];
  });
}

export function streakTileModel(stats: ChoreStats): StreakTileModel {
  const withStreak = stats.members
    .filter((member) => member.streak > 0)
    .map((member) => ({ email: member.email, name: member.name, streak: member.streak, activeToday: member.streakActiveToday }))
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
