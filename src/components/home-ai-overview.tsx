'use client';

/**
 * AI rewrite of the morning brief (H04). The brief itself is deterministic and
 * always shown first; this asks the existing overview flow (`generateHomeOverview`)
 * on demand, from the small sparkle button on the brief. That flow computes the
 * exact facts on the server from the sections the member may view, then (quota
 * permitting) lets the model write a summary of only those facts. The result is
 * shown in the brief's place with an "AI-written" marker, the exact counts it was
 * written from, and "Show plain brief" to go back. Nothing is stored.
 */
import * as React from 'react';
import Link from 'next/link';
import { generateHomeOverview } from '@/ai/flows/generate-home-overview';
import { getAiActionContext, unwrapAiActionResult } from '@/ai/client';
import type { HomeOverviewResult, OverviewSection } from '@/ai/overview-types';
import { overviewSectionRoutes } from '@/ai/overview-types';
import { useAuth } from '@/hooks/use-auth';
import { friendlyError } from '@/lib/friendly-error';

type Metric = { section: OverviewSection; label: string; value: number; detail?: string };

/** HomeHub's exact counts from the overview facts (never the model's). */
export const overviewMetrics = (result: HomeOverviewResult): Metric[] => {
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

export const aiUnavailableMessage: Record<Exclude<HomeOverviewResult['aiStatus'], 'generated'>, string> = {
  configuration_unavailable: 'AI-written summary is not configured. Exact household facts are still available.',
  rate_limited: 'AI-written summary is temporarily rate limited. Exact household facts are still available.',
  quota_exceeded: "Today's AI requests are used up (they reset at midnight UTC). Exact household facts are still available.",
  provider_unavailable: 'AI-written summary is temporarily unavailable. Exact household facts are still available.',
  timeout: 'AI-written summary took too long. Exact household facts are still available.',
  invalid_response: 'AI-written summary could not be validated. Exact household facts are still available.',
};

export type BriefRewrite = {
  result: HomeOverviewResult | null;
  loading: boolean;
  error: string | null;
  /** Asks AI to rewrite the brief (one overview request; quota handled by the flow). */
  rewrite: () => Promise<void>;
  /** Back to the plain, deterministic brief. */
  reset: () => void;
};

export function useBriefRewrite(): BriefRewrite {
  const { currentUser } = useAuth();
  const [result, setResult] = React.useState<HomeOverviewResult | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const busy = React.useRef(false);

  const rewrite = React.useCallback(async () => {
    const householdId = currentUser?.householdId;
    if (!householdId || busy.current) return;
    busy.current = true;
    setLoading(true);
    setError(null);
    try {
      setResult(unwrapAiActionResult(await generateHomeOverview(await getAiActionContext(householdId))));
    } catch (caught) {
      setError(caught instanceof Error && caught.message ? caught.message : friendlyError(caught));
    } finally {
      busy.current = false;
      setLoading(false);
    }
  }, [currentUser?.householdId]);

  const reset = React.useCallback(() => {
    setResult(null);
    setError(null);
  }, []);

  return { result, loading, error, rewrite, reset };
}

/**
 * Under the AI-written brief: the model's priorities (linked to their section) and
 * HomeHub's exact counts the text was written from, so every number can be checked.
 */
export function BriefAiDetails({ result }: { result: HomeOverviewResult }) {
  const metrics = overviewMetrics(result);
  return (
    <div className="mt-3 space-y-3" data-testid="home-ai-overview-result">
      {!result.narrative && (
        <p className="text-sm text-muted-foreground">
          {aiUnavailableMessage[result.aiStatus as Exclude<HomeOverviewResult['aiStatus'], 'generated'>]}
        </p>
      )}
      {result.narrative && result.narrative.priorities.length > 0 && (
        <ul className="grid gap-2 md:grid-cols-2" aria-label="AI-suggested priorities">
          {result.narrative.priorities.slice(0, 4).map((priority, index) => (
            <li key={`${priority.sourceSection}-${index}`} className="min-w-0 rounded-md border-l-4 border-primary bg-muted/30 px-3 py-2">
              <Link href={overviewSectionRoutes[priority.sourceSection]} className="font-medium underline-offset-4 hover:underline">
                {priority.title}
              </Link>
              <p className="text-sm text-muted-foreground">{priority.explanation}</p>
            </li>
          ))}
        </ul>
      )}
      <div>
        <p className="mb-1.5 text-xs text-muted-foreground">HomeHub&apos;s exact counts</p>
        <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
          {metrics.map((metric) => (
            <li key={metric.section} className="min-w-0">
              <Link
                href={overviewSectionRoutes[metric.section]}
                data-testid={`overview-metric-${metric.section}`}
                className="block min-w-0 rounded-md border px-3 py-1.5 transition-ui hover:bg-muted/40"
              >
                <span className="block truncate text-xs text-muted-foreground">{metric.label}</span>
                <span className="block text-lg font-semibold tabular-nums">{metric.value}</span>
                {metric.detail && <span className="block truncate text-xs text-muted-foreground">{metric.detail}</span>}
              </Link>
            </li>
          ))}
        </ul>
      </div>
      <p className="text-xs text-muted-foreground">Written {new Date(result.generatedAt).toLocaleString()}</p>
    </div>
  );
}
