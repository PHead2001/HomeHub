'use client';

/**
 * The signed-in dashboard: the living house (H01), the morning brief (H04, with its
 * on-demand AI rewrite), the bento grid (H22) and Home Wrapped. Loaded as its own
 * chunk from `src/app/page.tsx`, so signed-out visitors (the landing page) never
 * download it.
 *
 * Layout (HP-12): stacked on phones, portrait and narrow screens (subtitle, house,
 * brief, tiles, footer); on every wide landscape screen two panes, the house on the
 * left and the brief and tiles on the right (dashboard.module.css `.page`). The DOM
 * order is the same in both, so focus order follows the reading order.
 */
import { Keyboard } from 'lucide-react';
import { openShortcutHelp } from '@/components/command/events';
import { ShortcutHint, ShortcutKeys } from '@/components/ui/shortcut-hint';
import { useAuth } from '@/hooks/use-auth';
import { useDashboardData } from '@/lib/dashboard/use-dashboard-data';
import { isGoldenRoof } from '@/lib/dashboard/ambience';
import { cn } from '@/lib/utils';
import { BentoGrid } from './bento-grid';
import { DashboardSubtitle } from './dashboard-subtitle';
import { HomeWrapped } from './home-wrapped';
import { LivingHouse } from './living-house';
import { MorningBrief } from './morning-brief';
import styles from './dashboard.module.css';

export function Dashboard() {
  const { currentUser, household } = useAuth();
  const { facts, loading, failed, sections, retry, now, today, timeZone, context, houseOutline } = useDashboardData();
  // HP-11b: counted from the completions listener that is already running (streaks), so a
  // page that never reloads turns gold at the 100th chore. Unknown is never gold.
  const golden = facts.completedChores !== undefined && isGoldenRoof(facts.completedChores);

  return (
    <div className={cn('container mx-auto px-4', styles.page)} data-testid="dashboard-page">
      <div className="min-w-0">
        <div className={cn(styles.lead, 'mb-4 min-w-0')}>
          {/* HP-12c: visually hidden on wide landscape screens, kept for screen readers. */}
          <h1 className={cn(styles.wideSrOnly, 'font-headline text-3xl font-bold tracking-tight')}>Welcome Home</h1>
          <DashboardSubtitle householdName={household?.name} timeZone={timeZone} />
        </div>
        <LivingHouse facts={facts} title={household?.name || 'Your home'} golden={golden} now={now} rooms={sections.chores} outline={houseOutline} timeZone={timeZone} onRetry={retry} />
      </div>

      <div className="min-w-0">
        {/* Keyed by the context: a household or member change resets the brief and its AI
            rewrite; the household day rolling over does not (HP-4b). */}
        <div className={styles.briefSlot}>
          <MorningBrief key={context} facts={facts} name={currentUser?.firstName || currentUser?.displayName} now={now} today={today} timeZone={timeZone} ready={!loading} />
        </div>
        <BentoGrid facts={facts} loading={loading} failed={failed} sections={sections} timeZone={timeZone} onRetry={retry} />

        <div className="flex flex-wrap items-center gap-3">
          <HomeWrapped />
          {/* HP-19a: only on a keyboard-and-mouse screen (fine, hovering pointer, md and up). */}
          <ShortcutHint shortcut="help">
            <button
              type="button"
              onClick={openShortcutHelp}
              data-testid="dashboard-shortcuts-hint"
              className={cn(styles.fineHoverOnly, styles.target, 'items-center gap-1.5 rounded-md px-2 text-sm text-muted-foreground hover:text-foreground')}
            >
              <Keyboard aria-hidden className="h-4 w-4" />
              Keyboard shortcuts <ShortcutKeys shortcut="help" />
            </button>
          </ShortcutHint>
        </div>
      </div>
    </div>
  );
}

