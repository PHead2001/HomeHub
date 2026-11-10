'use client';

/**
 * The signed-in dashboard: the living house (H01), the morning brief (H04, with its
 * on-demand AI rewrite), the bento grid (H22) and Home Wrapped. Loaded as its own
 * chunk from `src/app/page.tsx`, so signed-out visitors (the landing page) never
 * download it.
 */
import { Keyboard } from 'lucide-react';
import { openShortcutHelp } from '@/components/command/events';
import { ShortcutHint, ShortcutKeys } from '@/components/ui/shortcut-hint';
import { useAuth } from '@/hooks/use-auth';
import { useDashboardData } from '@/lib/dashboard/use-dashboard-data';
import { isGoldenRoof } from '@/lib/dashboard/ambience';
import { BentoGrid } from './bento-grid';
import { HomeWrapped } from './home-wrapped';
import { LivingHouse } from './living-house';
import { MorningBrief } from './morning-brief';

export function Dashboard() {
  const { currentUser, household } = useAuth();
  const { facts, loading, failed, sections, retry, now, today, timeZone, context, houseOutline } = useDashboardData();
  // HP-11b: counted from the completions listener that is already running (streaks), so a
  // page that never reloads turns gold at the 100th chore. Unknown is never gold.
  const golden = facts.completedChores !== undefined && isGoldenRoof(facts.completedChores);
  // The household's date (D-6), the same day every tile counts from.
  const dateLine = now.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', timeZone });

  return (
    <div className="container mx-auto px-4 py-6 md:py-8">
      <div className="mb-4 min-w-0">
        <h1 className="font-headline text-3xl font-bold tracking-tight">Welcome Home</h1>
        <p className="truncate text-muted-foreground" data-testid="dashboard-household-line">
          {household?.name ? <span className="font-medium text-foreground">{household.name}</span> : null}
          {household?.name ? ' · ' : null}
          {dateLine}
        </p>
      </div>

      <LivingHouse facts={facts} title={household?.name || 'Your home'} golden={golden} now={now} rooms={sections.chores} outline={houseOutline} timeZone={timeZone} onRetry={retry} />
      {/* Keyed by the context: a household or member change resets the brief and its AI
          rewrite; the household day rolling over does not (HP-4b). */}
      <MorningBrief key={context} facts={facts} name={currentUser?.firstName || currentUser?.displayName} now={now} today={today} timeZone={timeZone} ready={!loading} />
      <BentoGrid facts={facts} loading={loading} failed={failed} sections={sections} timeZone={timeZone} onRetry={retry} />

      <div className="flex flex-wrap items-center gap-3">
        <HomeWrapped />
        <ShortcutHint shortcut="help">
          <button
            type="button"
            onClick={openShortcutHelp}
            className="hidden items-center gap-1.5 rounded-md px-2 py-1 text-sm text-muted-foreground hover:text-foreground md:inline-flex"
          >
            <Keyboard aria-hidden className="h-4 w-4" />
            Keyboard shortcuts <ShortcutKeys shortcut="help" />
          </button>
        </ShortcutHint>
      </div>
    </div>
  );
}

