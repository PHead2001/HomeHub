'use client';

import { useEffect, useState } from 'react';
import { collection, getCountFromServer, query, where } from 'firebase/firestore';
import { Keyboard } from 'lucide-react';
import { HomeAiOverview } from '@/components/home-ai-overview';
import { BentoGrid } from '@/components/dashboard/bento-grid';
import { DashboardSkeleton } from '@/components/dashboard/dashboard-skeleton';
import { HomeWrapped } from '@/components/dashboard/home-wrapped';
import { Landing } from '@/components/dashboard/landing';
import { LivingHouse } from '@/components/dashboard/living-house';
import { MorningBrief } from '@/components/dashboard/morning-brief';
import { openShortcutHelp } from '@/components/command/events';
import { useAuth } from '@/hooks/use-auth';
import { db } from '@/lib/firebase';
import { useDashboardData } from '@/lib/dashboard/use-dashboard-data';

/** Chores completed before the living house's roof turns gold (H29). */
const GOLDEN_ROOF_CHORES = 100;

function useGoldenRoof(householdId: string | null, canView: boolean) {
  const [result, setResult] = useState<{ householdId: string; golden: boolean } | null>(null);
  useEffect(() => {
    if (!householdId || !canView) return;
    let cancelled = false;
    getCountFromServer(query(collection(db, 'households', householdId, 'chores'), where('isCompleted', '==', true)))
      .then((snapshot) => {
        if (!cancelled) setResult({ householdId, golden: snapshot.data().count >= GOLDEN_ROOF_CHORES });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [householdId, canView]);
  return Boolean(canView && result && result.householdId === householdId && result.golden);
}

function Dashboard() {
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
      <HomeAiOverview />

      <div className="flex flex-wrap items-center gap-3">
        <HomeWrapped />
        <button
          type="button"
          onClick={openShortcutHelp}
          className="hidden items-center gap-1.5 rounded-md px-2 py-1 text-sm text-muted-foreground hover:text-foreground md:inline-flex"
        >
          <Keyboard aria-hidden className="h-4 w-4" />
          Keyboard shortcuts <kbd className="rounded border bg-muted px-1.5 text-xs">?</kbd>
        </button>
      </div>
    </div>
  );
}

export default function Home() {
  const { currentUser, loading } = useAuth();

  if (loading) return <DashboardSkeleton />;
  // Signed-out visitors get the landing page (H03), never an empty dashboard.
  if (!currentUser) return <Landing />;
  return <Dashboard />;
}
