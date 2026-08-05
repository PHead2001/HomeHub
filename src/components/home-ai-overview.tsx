'use client';

import * as React from 'react';
import Link from 'next/link';
import { AlertCircle, RefreshCw, Sparkles } from 'lucide-react';
import { generateHomeOverview } from '@/ai/flows/generate-home-overview';
import { getAiActionContext, unwrapAiActionResult } from '@/ai/client';
import type { HomeOverviewResult, OverviewSection } from '@/ai/overview-types';
import { overviewSectionRoutes } from '@/ai/overview-types';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/hooks/use-auth';

type Metric = { section: OverviewSection; label: string; value: number; detail?: string };

const getMetrics = (result: HomeOverviewResult): Metric[] => {
  const { facts } = result;
  return [
    ...(facts.chores ? [{ section: 'chores' as const, label: 'Your open chores', value: facts.chores.assignedIncomplete, detail: `${facts.chores.overdue} overdue` }] : []),
    ...(facts.shopping ? [{ section: 'shopping' as const, label: 'Needed items', value: facts.shopping.neededItems, detail: `${facts.shopping.activeLists} lists` }] : []),
    ...(facts.pantry ? [{ section: 'pantry' as const, label: 'Expiring soon', value: facts.pantry.expiringWithinSevenDays, detail: `${facts.pantry.expired} expired` }] : []),
    ...(facts.maintenance ? [{ section: 'maintenance' as const, label: 'Maintenance due', value: facts.maintenance.overdue + facts.maintenance.dueSoon, detail: `${facts.maintenance.overdue} overdue` }] : []),
    ...(facts.pets ? [{ section: 'pets' as const, label: 'Pets', value: facts.pets.totalPets, detail: `${facts.pets.recentCareEntries} recent care logs` }] : []),
    ...(facts.notifications ? [{ section: 'notifications' as const, label: 'Unread notices', value: facts.notifications.unread }] : []),
    ...(facts.household ? [{ section: 'household' as const, label: 'Pending members', value: facts.household.pendingApprovals, detail: `${facts.household.activeMembers} active` }] : []),
    ...(facts.barcode ? [{ section: 'barcode' as const, label: 'Saved products', value: facts.barcode.savedProducts }] : []),
  ];
};

const aiUnavailableMessage: Record<Exclude<HomeOverviewResult['aiStatus'], 'generated'>, string> = {
  configuration_unavailable: 'AI-written summary is not configured. Exact household facts are still available.',
  rate_limited: 'AI-written summary is temporarily rate limited. Exact household facts are still available.',
  provider_unavailable: 'AI-written summary is temporarily unavailable. Exact household facts are still available.',
  timeout: 'AI-written summary took too long. Exact household facts are still available.',
  invalid_response: 'AI-written summary could not be validated. Exact household facts are still available.',
};

export function HomeAiOverview() {
  const { currentUser } = useAuth();
  const [result, setResult] = React.useState<HomeOverviewResult | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const generate = async () => {
    const householdId = currentUser?.householdId;
    if (!householdId || loading) return;
    setLoading(true);
    setError(null);
    try {
      setResult(unwrapAiActionResult(await generateHomeOverview(await getAiActionContext(householdId))));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Overview could not be generated.');
    } finally {
      setLoading(false);
    }
  };

  const metrics = result ? getMetrics(result) : [];

  return (
    <section aria-labelledby="ai-overview-heading" className="mb-8 border-y py-5">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Sparkles className="size-5 text-primary" aria-hidden="true" />
            <h2 id="ai-overview-heading" className="font-headline text-xl font-semibold">AI Overview</h2>
          </div>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            Generate a private snapshot from the household sections you can access. Exact counts are calculated by HomeHub.
          </p>
        </div>
        <Button onClick={generate} disabled={loading || !currentUser?.householdId} className="w-full shrink-0 sm:w-auto">
          {loading ? <RefreshCw className="mr-2 size-4 animate-spin" aria-hidden="true" /> : <Sparkles className="mr-2 size-4" aria-hidden="true" />}
          {loading ? 'Generating...' : result ? 'Regenerate Overview' : 'Generate Overview'}
        </Button>
      </div>

      <div role="status" aria-live="polite" className="mt-4">
        {loading && <p className="text-sm text-muted-foreground">Calculating authorized household facts and writing a summary...</p>}
        {error && (
          <div className="flex flex-wrap items-center gap-3 text-sm text-destructive">
            <AlertCircle className="size-4" aria-hidden="true" />
            <span>{error}</span>
            <Button variant="outline" size="sm" onClick={generate}>Try Again</Button>
          </div>
        )}
      </div>

      {result && (
        <div className="mt-5 space-y-5" data-testid="home-ai-overview-result">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
            {metrics.map(metric => (
              <Link
                key={metric.section}
                href={overviewSectionRoutes[metric.section]}
                data-testid={`overview-metric-${metric.section}`}
                className="min-w-0 border p-3 transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <p className="truncate text-xs text-muted-foreground">{metric.label}</p>
                <p className="mt-1 text-2xl font-semibold tabular-nums">{metric.value}</p>
                {metric.detail && <p className="truncate text-xs text-muted-foreground">{metric.detail}</p>}
              </Link>
            ))}
          </div>

          {result.narrative ? (
            <div className="space-y-3">
              <div>
                <h3 className="font-headline text-lg font-semibold">{result.narrative.headline}</h3>
                <p className="text-sm text-muted-foreground">{result.narrative.summary}</p>
              </div>
              {result.narrative.priorities.length > 0 && (
                <ul className="grid gap-2 md:grid-cols-2">
                  {result.narrative.priorities.map((priority, index) => (
                    <li key={`${priority.sourceSection}-${index}`} className="border-l-4 border-primary bg-muted/30 px-3 py-2">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-medium">{priority.title}</span>
                        <span className="text-xs uppercase text-muted-foreground">{priority.level}</span>
                      </div>
                      <p className="text-sm text-muted-foreground">{priority.explanation}</p>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              {aiUnavailableMessage[result.aiStatus as Exclude<HomeOverviewResult['aiStatus'], 'generated'>]}
            </p>
          )}
          <p className="text-xs text-muted-foreground">Generated {new Date(result.generatedAt).toLocaleString()}</p>
        </div>
      )}
    </section>
  );
}
