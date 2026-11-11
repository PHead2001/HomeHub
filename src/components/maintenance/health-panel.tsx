'use client';

import { useState } from 'react';
import { ChevronRight, HeartPulse } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import {
  HEALTH_BAND_LABELS,
  HEALTH_RULES,
  type HealthDeduction,
  type HealthResult,
} from '@/lib/maintenance/health';
import { HEALTH_BAND_TEXT_CLASS, HealthRing } from './health-ring';

const VISIBLE_DEDUCTIONS = 5;

/**
 * Home health dial (H10) with the reasons behind the score. Every deduction is a
 * button that opens the asset or vehicle it comes from.
 */
export function HealthPanel({
  health,
  onOpen,
}: {
  health: HealthResult;
  onOpen: (deduction: HealthDeduction) => void;
}) {
  const [showAll, setShowAll] = useState(false);
  const deductions = showAll ? health.deductions : health.deductions.slice(0, VISIBLE_DEDUCTIONS);
  const hidden = health.deductions.length - deductions.length;

  return (
    <Card data-testid="maintenance-health">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 font-headline">
          <HeartPulse aria-hidden className="h-5 w-5 text-primary" />
          Home health
        </CardTitle>
        <CardDescription>From overdue and upcoming maintenance, expiring documents and recent work.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-6 sm:grid-cols-[auto_minmax(0,1fr)] sm:items-start">
        <div className="flex flex-col items-center gap-2">
          <HealthRing score={health.score} band={health.band} size="lg" label="Home health" />
          <p className={cn('text-sm font-medium', HEALTH_BAND_TEXT_CLASS[health.band])}>{HEALTH_BAND_LABELS[health.band]}</p>
        </div>

        <div className="min-w-0 space-y-3">
          <h3 className="text-sm font-semibold">Why this score</h3>
          {health.deductions.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nothing is overdue or due soon. Keep logging work to stay here.</p>
          ) : (
            <ul className="space-y-1" aria-label="Score deductions">
              {deductions.map((deduction) => (
                <li key={deduction.id}>
                  <button
                    type="button"
                    onClick={() => onOpen(deduction)}
                    className="flex min-h-[var(--target-min)] w-full items-center gap-3 rounded-md px-2 py-1.5 text-left text-sm transition-ui hover:bg-accent"
                  >
                    <span className="w-9 shrink-0 font-semibold tabular-nums text-destructive">−{deduction.points}</span>
                    <span className="min-w-0 flex-1">
                      <span className="font-medium">{deduction.targetName}</span>
                      <span className="text-muted-foreground">: {deduction.reason}</span>
                    </span>
                    <ChevronRight aria-hidden className="h-4 w-4 shrink-0 text-muted-foreground" />
                    <span className="sr-only">Open {deduction.targetName}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {(hidden > 0 || showAll) && health.deductions.length > VISIBLE_DEDUCTIONS && (
            <Button type="button" variant="ghost" size="sm" aria-expanded={showAll} onClick={() => setShowAll((value) => !value)}>
              {showAll ? 'Show fewer' : `Show ${hidden} more`}
            </Button>
          )}
          {health.bonus > 0 && (
            <p className="px-2 text-sm text-muted-foreground">
              <span className="mr-3 font-semibold tabular-nums text-success">+{health.bonus}</span>{' '}
              {health.recentLogs} {health.recentLogs === 1 ? 'log' : 'logs'} in the last {HEALTH_RULES.recentDays} days
            </p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
