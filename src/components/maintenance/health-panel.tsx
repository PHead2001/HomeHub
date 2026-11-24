'use client';

import { useState } from 'react';
import Link from 'next/link';
import { ChevronRight, HeartPulse, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import {
  HEALTH_BAND_LABELS,
  isScored,
  type HealthDeduction,
  type HealthResult,
  type HealthUnscored,
} from '@/lib/maintenance/health';
import { HEALTH_BAND_TEXT_CLASS, HealthRing } from './health-ring';

const VISIBLE_DEDUCTIONS = 5;

/** Where "Add a schedule" goes when the page does not handle it itself. */
export const ADD_SCHEDULE_HREF = '/maintenance?tab=assets';

/**
 * Home health dial (H10, MA-10) with the reasons behind the score. Every
 * deduction is a button that opens the asset or vehicle it comes from. When
 * nothing active is tracked yet there is no score: the panel says "Not enough
 * tracked yet" and offers to add a schedule (`onAddSchedule`, else a link to the
 * Home Assets tab).
 */
export function HealthPanel({
  health,
  onOpen,
  onAddSchedule,
}: {
  health: HealthResult | HealthUnscored;
  onOpen: (deduction: HealthDeduction) => void;
  onAddSchedule?: () => void;
}) {
  const [showAll, setShowAll] = useState(false);

  if (!isScored(health)) {
    return (
      <Card data-testid="maintenance-health" data-health-state="not-enough-tracked">
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 font-headline">
            <HeartPulse aria-hidden className="h-5 w-5 text-primary" />
            Home health
          </CardTitle>
          <CardDescription>Not enough tracked yet</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Add a maintenance schedule to an asset, or a service, registration or inspection date to a vehicle, and HomeHub will score how the home is keeping up.
          </p>
          {onAddSchedule ? (
            <Button type="button" variant="outline" onClick={onAddSchedule}>
              <Plus aria-hidden className="mr-2 h-4 w-4" />
              Add a schedule
            </Button>
          ) : (
            <Button asChild variant="outline">
              <Link href={ADD_SCHEDULE_HREF}>
                <Plus aria-hidden className="mr-2 h-4 w-4" />
                Add a schedule
              </Link>
            </Button>
          )}
        </CardContent>
      </Card>
    );
  }

  const deductions = showAll ? health.deductions : health.deductions.slice(0, VISIBLE_DEDUCTIONS);
  const hidden = health.deductions.length - deductions.length;

  return (
    <Card data-testid="maintenance-health">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 font-headline">
          <HeartPulse aria-hidden className="h-5 w-5 text-primary" />
          Home health
        </CardTitle>
        <CardDescription>
          The average of {health.tracked} tracked {health.tracked === 1 ? 'item' : 'items'}. Overdue work and expired registrations or inspections lower an item&apos;s score; due soon does not.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-6 sm:grid-cols-[auto_minmax(0,1fr)] sm:items-start">
        <div className="flex flex-col items-center gap-2">
          <HealthRing score={health.score} band={health.band} size="lg" label="Home health" />
          <p className={cn('text-sm font-medium', HEALTH_BAND_TEXT_CLASS[health.band])}>{HEALTH_BAND_LABELS[health.band]}</p>
        </div>

        <div className="min-w-0 space-y-3">
          <h3 className="text-sm font-semibold">Why this score</h3>
          {health.deductions.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nothing is overdue or expired.</p>
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
                    <span className="min-w-0 flex-1 break-words [overflow-wrap:anywhere]">
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
        </div>
      </CardContent>
    </Card>
  );
}
