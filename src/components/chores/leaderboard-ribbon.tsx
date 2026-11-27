'use client';

import { Flame, Star, Trophy } from 'lucide-react';
import { MemberAvatar } from '@/components/member-avatar';
import type { ChoreStats } from '@/lib/chores/stats';
import type { MemberColor } from '@/lib/member-colors';
import { cn } from '@/lib/utils';

type RibbonProps = {
  stats: ChoreStats;
  colors: Map<string, MemberColor>;
  photos: Map<string, string | null | undefined>;
  /** Whether the full leaderboard card is open below the ribbon. */
  expanded: boolean;
  onToggle: () => void;
  /** Id of the full card, for `aria-controls`. */
  controls: string;
  className?: string;
};

/**
 * The week's leaderboard as one row at the top of the page (CH-13, CH-18): each
 * member's avatar with points (stickers for kids) and streak, highest first, and a
 * button that opens the full card. Phones and the room view use it, so the
 * leaderboard is never below the whole list.
 */
export function LeaderboardRibbon({ stats, colors, photos, expanded, onToggle, controls, className }: RibbonProps) {
  const members = [...stats.members].sort((a, b) => b.weekPoints - a.weekPoints || a.name.localeCompare(b.name));
  return (
    <section aria-label="This week's leaderboard" data-testid="chores-leaderboard-ribbon" className={cn('flex items-center gap-2 rounded-xl border bg-card p-1.5 shadow-raised', className)}>
      <ul className="flex min-w-0 flex-1 gap-1 overflow-x-auto">
        {members.map(member => (
          <li key={member.uid} className="flex min-h-[var(--target-min)] shrink-0 items-center gap-1.5 rounded-lg px-2">
            <MemberAvatar uid={member.uid} name={member.name} photoUrl={photos.get(member.uid)} color={colors.get(member.uid)} size="sm" decorative />
            <span className="max-w-[6rem] truncate text-sm font-medium text-foreground">{member.name}</span>
            {member.stickerMode ? (
              <span className="flex items-center gap-0.5 text-sm font-semibold tabular-nums text-foreground">
                <Star aria-hidden className="h-4 w-4 fill-warning text-warning" />{member.stickers}
                <span className="sr-only"> {member.stickers === 1 ? 'sticker' : 'stickers'}</span>
              </span>
            ) : (
              <span className="text-sm font-semibold tabular-nums text-foreground">{member.weekPoints}<span className="sr-only"> points</span><span aria-hidden className="ml-0.5 text-xs font-normal text-muted-foreground">pts</span></span>
            )}
            {member.streak > 0 && (
              <span className="flex items-center text-xs tabular-nums text-muted-foreground">
                <Flame aria-hidden className="h-3.5 w-3.5 text-warning" />{member.streak}
                <span className="sr-only">-day streak</span>
              </span>
            )}
          </li>
        ))}
      </ul>
      <button
        type="button"
        className="flex min-h-[var(--target-min)] min-w-[var(--target-min)] shrink-0 items-center justify-center gap-1.5 rounded-lg px-2 text-sm font-medium text-primary hover:bg-accent"
        aria-expanded={expanded}
        aria-controls={controls}
        onClick={onToggle}
      >
        <Trophy aria-hidden className="h-4 w-4" />
        <span className="hidden sm:inline">{expanded ? 'Hide leaderboard' : 'Leaderboard'}</span>
        <span className="sr-only sm:hidden">{expanded ? 'Hide leaderboard' : 'Show leaderboard'}</span>
      </button>
    </section>
  );
}
