'use client';

import { motion } from 'motion/react';
import { Crown, Flame, Star } from 'lucide-react';
import { format } from 'date-fns';
import { MemberAvatar } from '@/components/member-avatar';
import { NumberTicker } from '@/components/motion/number-ticker';
import { useReducedMotion } from '@/hooks/use-reduced-motion';
import { dayFromKey } from '@/lib/chores/dates';
import { POINTS, weeklyPodium, type ChoreStats, type MemberChoreStats } from '@/lib/chores/stats';
import type { MemberColor } from '@/lib/member-colors';
import { cn } from '@/lib/utils';

type LeaderboardProps = {
  stats: ChoreStats;
  colors: Map<string, MemberColor>;
  photos: Map<string, string | null | undefined>;
  showPodium: boolean;
};

function FairShareRing({ member, color, total }: { member: MemberChoreStats; color?: MemberColor; total: number }) {
  const radius = 15;
  const circumference = 2 * Math.PI * radius;
  const percent = Math.round(member.fairShare * 100);
  const label = `${member.name} has ${member.weekAssigned} of ${total} chores this week (${percent}%)`;
  return (
    <span role="img" aria-label={label} title={label} className="relative grid h-10 w-10 shrink-0 place-items-center">
      <svg viewBox="0 0 40 40" className="absolute inset-0 -rotate-90" aria-hidden>
        <circle cx="20" cy="20" r={radius} fill="none" className="stroke-muted" strokeWidth={4} />
        <circle
          cx="20" cy="20" r={radius} fill="none" strokeWidth={4} strokeLinecap="round"
          style={{ stroke: color?.color ?? 'hsl(var(--primary))' }}
          strokeDasharray={`${circumference * member.fairShare} ${circumference}`}
        />
      </svg>
      <span aria-hidden className="text-[10px] font-semibold tabular-nums text-foreground">{percent}%</span>
    </span>
  );
}

function Stickers({ count }: { count: number }) {
  const shown = Math.min(count, 5);
  return (
    <span className="flex items-center gap-0.5" aria-label={`${count} sticker${count === 1 ? '' : 's'} this week`} role="img">
      {Array.from({ length: shown }, (_, i) => (
        <Star key={i} aria-hidden className="h-4 w-4 fill-warning text-warning" />
      ))}
      {count > shown && <span aria-hidden className="ml-0.5 text-xs font-semibold text-foreground">+{count - shown}</span>}
      {count === 0 && <span aria-hidden className="text-xs text-muted-foreground">No stickers yet</span>}
    </span>
  );
}

function Podium({ podium, colors, photos }: { podium: MemberChoreStats[]; colors: LeaderboardProps['colors']; photos: LeaderboardProps['photos'] }) {
  const reduced = useReducedMotion();
  // Visual order: 2nd, 1st, 3rd. Heights are fixed so nothing shifts.
  const slots = [podium[1], podium[0], podium[2]];
  const heights = ['h-16', 'h-24', 'h-12'];
  const places = [2, 1, 3];
  return (
    <div className="mb-4 rounded-xl border bg-background/60 p-4">
      <p className="mb-3 text-center text-sm font-semibold text-foreground">This week&apos;s podium</p>
      <ol className="grid grid-cols-3 items-end gap-3" aria-label="Weekly podium">
        {slots.map((member, i) => (
          <li key={member?.uid ?? `empty-${i}`} className="flex flex-col items-center gap-1" style={{ order: i }}>
            {member ? (
              <>
                <span className="relative">
                  {places[i] === 1 && (
                    <motion.span
                      aria-hidden
                      className="absolute -top-5 left-1/2 -translate-x-1/2 text-warning"
                      initial={reduced ? false : { y: -20, opacity: 0 }}
                      animate={{ y: 0, opacity: 1 }}
                      transition={{ delay: 0.65, type: 'spring', visualDuration: 0.3, bounce: 0.4 }}
                    >
                      <Crown className="h-5 w-5 fill-warning" />
                    </motion.span>
                  )}
                  <MemberAvatar uid={member.uid} name={member.name} photoUrl={photos.get(member.uid)} color={colors.get(member.uid)} size="md" ring decorative />
                </span>
                <span className="max-w-full truncate text-xs font-medium text-foreground">{member.name}</span>
                <span className="sr-only">{`Place ${places[i]}${places[i] === 1 ? ', MVP' : ''}: ${member.weekPoints} points`}</span>
                <motion.div
                  aria-hidden
                  className={cn('flex w-full items-start justify-center rounded-t-lg pt-1 text-sm font-bold', heights[i], colors.get(member.uid)?.classes.chip ?? 'bg-primary text-primary-foreground')}
                  style={{ originY: 1 }}
                  initial={reduced ? false : { scaleY: 0 }}
                  animate={{ scaleY: 1 }}
                  transition={{ delay: i === 1 ? 0.15 : 0, duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
                >
                  {places[i]}
                </motion.div>
              </>
            ) : <div aria-hidden className={cn('w-full rounded-t-lg bg-muted/40', heights[i])} />}
          </li>
        ))}
      </ol>
    </div>
  );
}

/**
 * Household leaderboard (H06): points (stickers for child accounts), a daily
 * streak flame and a fair-share ring per member, for the current Monday-Sunday
 * week. On Sundays the weekly podium rises with a crown for the MVP.
 */
export function ChoreLeaderboard({ stats, colors, photos, showPodium }: LeaderboardProps) {
  const podium = weeklyPodium(stats);
  const range = `${format(dayFromKey(stats.weekStart), 'MMM d')} - ${format(dayFromKey(stats.weekEnd), 'MMM d')}`;
  return (
    <section aria-labelledby="chore-leaderboard-title" className="rounded-xl border bg-card p-4 shadow-raised">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="chore-leaderboard-title" className="font-headline text-lg font-semibold text-foreground">This week</h2>
        <p className="text-xs text-muted-foreground">{range} · {POINTS.base} points a chore, +{POINTS.onTime} on time</p>
      </div>
      {showPodium && podium.length > 0 && <Podium podium={podium} colors={colors} photos={photos} />}
      <ul className="space-y-2">
        {stats.members.map(member => (
          <li key={member.uid} className="flex items-center gap-3">
            <MemberAvatar uid={member.uid} name={member.name} photoUrl={photos.get(member.uid)} color={colors.get(member.uid)} size="sm" decorative />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium text-foreground">{member.name}</span>
              <span className="flex items-center gap-1 text-xs text-muted-foreground">
                <Flame aria-hidden className={cn('h-3.5 w-3.5', member.streak > 0 ? 'text-warning' : 'text-muted-foreground')} />
                {member.streak > 0
                  ? `${member.streak}-day streak${member.streakActiveToday ? '' : ' (keep it going today)'}`
                  : 'No streak yet'}
              </span>
            </span>
            {member.stickerMode ? (
              <Stickers count={member.stickers} />
            ) : (
              <span className="text-right">
                <NumberTicker value={member.weekPoints} className="block text-base font-bold tabular-nums text-foreground" animateOnMount={false} />
                <span className="text-xs text-muted-foreground">points</span>
              </span>
            )}
            <FairShareRing member={member} color={colors.get(member.uid)} total={stats.weekTotal} />
          </li>
        ))}
      </ul>
    </section>
  );
}
