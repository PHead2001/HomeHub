'use client';

import { MemberAvatar } from '@/components/member-avatar';
import type { MemberColor } from '@/lib/member-colors';
import type { ChoreStats } from '@/lib/chores/stats';

// Fair share this week (audit CA-26): per member, how many of this week's chores are
// theirs and how many of those are done, and their share of what the household completed
// this week (CH-21's contribution), from the Chores leaderboard's own stats
// (`computeChoreStats`, the household's week, CA-16), so the two never disagree.

export function FairShareStrip({ stats, colors, photos }: { stats: ChoreStats; colors: Map<string, MemberColor>; photos: Map<string, string | null | undefined> }) {
  const shown = stats.members.filter(member => member.weekAssigned > 0 || member.weekCompleted > 0);
  if ((stats.weekTotal === 0 && stats.weekCompletedTotal === 0) || shown.length === 0) return null;
  return (
    <section aria-labelledby="fair-share-title" className="rounded-xl border bg-card p-3 shadow-raised" data-testid="calendar-fair-share">
      <h2 id="fair-share-title" className="mb-2 text-sm font-semibold text-foreground">Fair share this week</h2>
      <ul className="flex flex-wrap gap-x-4 gap-y-2">
        {shown.map(member => {
          const share = Math.round(member.contributionShare * 100);
          return (
            <li key={member.uid} className="flex min-w-[9rem] items-center gap-2 text-sm text-foreground">
              <MemberAvatar uid={member.uid} name={member.name} photoUrl={photos.get(member.uid)} color={colors.get(member.uid)} size="sm" decorative />
              <span className="min-w-0">
                <span className="block font-medium">{member.name}</span>
                <span className="block text-xs text-muted-foreground">{member.weekAssignedDone} of {member.weekAssigned} done · {share}% of the house&apos;s</span>
              </span>
              <span aria-hidden className="h-2 w-16 overflow-hidden rounded-full bg-muted">
                <span className={`block h-full ${colors.get(member.uid)?.classes.bg ?? 'bg-primary'}`} style={{ width: `${share}%` }} />
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
