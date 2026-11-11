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
import { useCallback, useEffect, useState } from 'react';
import { Keyboard } from 'lucide-react';
import { HouseCleanMoment } from '@/components/chores/house-clean-moment';
import { openShortcutHelp } from '@/components/command/events';
import { ShortcutHint, ShortcutKeys } from '@/components/ui/shortcut-hint';
import { useAuth } from '@/hooks/use-auth';
import { useDashboardData } from '@/lib/dashboard/use-dashboard-data';
import { isGoldenRoof } from '@/lib/dashboard/ambience';
import { houseCleanReady } from '@/lib/dashboard/celebration';
import { cleanHouseRooms, houseCleanShown, houseCleanStorageKey, markHouseCleanShown, type CleanRoom } from '@/lib/chores/house-clean';
import { playFeedback } from '@/lib/feedback';
import { GENERAL_ROOM_ID, UNKNOWN_ROOM_ID, type DashboardFacts } from '@/lib/dashboard/facts';
import type { SectionState } from '@/lib/dashboard/dashboard-store';
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
  const houseClean = useHouseClean(facts, sections.chores, currentUser?.householdId ?? null, today);

  return (
    <div className={cn('container mx-auto px-4', styles.page)} data-testid="dashboard-page">
      <HouseCleanMoment open={houseClean.rooms !== null} rooms={houseClean.rooms ?? []} onDone={houseClean.close} />
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


/**
 * HP-34: "House is clean" once per household per day (the key the Chores page uses too),
 * only on live chores data with today's work all done, nothing overdue and nothing missed
 * (`houseCleanReady`). The moment itself is Chores' `HouseCleanMoment` (rooms sparkle one
 * by one; reduced motion shows the finished house).
 */
function useHouseClean(facts: DashboardFacts, state: SectionState | undefined, householdId: string | null, today: string) {
  const [moment, setMoment] = useState<{ key: string; rooms: CleanRoom[] } | null>(null);
  const [checked, setChecked] = useState<string | null>(null);
  const chores = facts.chores;
  const key = householdId ? houseCleanStorageKey(householdId, today) : null;
  // Decided during render (once per key) when the gate opens; recorded and voiced in the effect.
  if (key && chores && checked !== key && houseCleanReady(state, chores)) {
    setChecked(key);
    if (!houseCleanShown(key)) {
      const real = chores.rooms.filter((room) => room.id !== GENERAL_ROOM_ID && room.id !== UNKNOWN_ROOM_ID);
      const worked = new Set(real.filter((room) => room.doneToday > 0).map((room) => room.id));
      setMoment({ key, rooms: cleanHouseRooms(real.map((room) => ({ id: room.id, name: room.name, icon: room.icon })), worked) });
    }
  }
  const shownKey = moment?.key ?? null;
  useEffect(() => {
    if (!shownKey) return;
    markHouseCleanShown(shownKey);
    playFeedback('celebrate');
  }, [shownKey]);
  const close = useCallback(() => setMoment((current) => (current ? { ...current, rooms: [] } : current)), []);
  return { rooms: moment && moment.rooms.length > 0 ? moment.rooms : null, close };
}
