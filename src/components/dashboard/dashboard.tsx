'use client';

/**
 * The signed-in dashboard: the living house (H01), the morning brief (H04, with its
 * on-demand AI rewrite), the bento grid (H22) and Home Wrapped. Loaded as its own
 * chunk from `src/app/page.tsx`, so signed-out visitors (the landing page) never
 * download it.
 */
import { useEffect, useState } from 'react';
import { collection, getCountFromServer, query, where } from 'firebase/firestore';
import { Keyboard } from 'lucide-react';
import { openShortcutHelp } from '@/components/command/events';
import { ShortcutHint, ShortcutKeys } from '@/components/ui/shortcut-hint';
import { useAuth } from '@/hooks/use-auth';
import { db } from '@/lib/firebase';
import { useDashboardData } from '@/lib/dashboard/use-dashboard-data';
import { isGoldenRoof } from '@/lib/dashboard/ambience';
import { BentoGrid } from './bento-grid';
import { HomeWrapped } from './home-wrapped';
import { LivingHouse } from './living-house';
import { MorningBrief } from './morning-brief';

function useGoldenRoof(householdId: string | null, canView: boolean) {
  const [result, setResult] = useState<{ householdId: string; golden: boolean } | null>(null);
  useEffect(() => {
    if (!householdId || !canView) return;
    let cancelled = false;
    getCountFromServer(query(collection(db, 'households', householdId, 'chores'), where('isCompleted', '==', true)))
      .then((snapshot) => {
        if (!cancelled) setResult({ householdId, golden: isGoldenRoof(snapshot.data().count) });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [householdId, canView]);
  return Boolean(canView && result && result.householdId === householdId && result.golden);
}

export function Dashboard() {
  const { currentUser, household, permissions } = useAuth();
  const { facts, loading, failed, now } = useDashboardData();
  const golden = useGoldenRoof(currentUser?.householdId ?? null, Boolean(permissions['chores.view']));
  const dateLine = now.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });

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

      <LivingHouse facts={facts} title={household?.name || 'Your home'} golden={golden} now={now} />
      <MorningBrief facts={facts} name={currentUser?.firstName || currentUser?.displayName} now={now} ready={!loading} />
      <BentoGrid facts={facts} loading={loading} failed={failed} />

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

