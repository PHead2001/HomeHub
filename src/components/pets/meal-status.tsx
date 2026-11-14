'use client';

import { CalendarClock, Check, Clock } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import {
  feedingWeek,
  formatSlotTime,
  mealHeadline,
  slotLine,
  type DayMark,
  type MealStatus,
  type SlotState,
} from '@/lib/pets/meal-plan';
import { formatPortion, type FeedingEntry } from '@/lib/pets/care';
import type { PetProfile } from '@/lib/pets/types';

/**
 * The meal-slot part of a pet's status (PE-22b, PE-10a): the status line ("Dinner
 * due 6:00 pm" on an amber tint once a slot's time has passed unfed, otherwise
 * the next meal or "All 2 meals done today") and one line per slot of today
 * ("Breakfast ✓ 7:42 am · Sam", "Dinner 6:00 pm", "Lunch missed"). Every text
 * is printed, so colour is never the only signal.
 */
export function MealSlotsStatus({ status, timeZone, id, compact }: { status: Extract<MealStatus, { kind: 'slots' }>; timeZone: string | null; id?: string; compact?: boolean }) {
  const headline = mealHeadline(status);
  return (
    <div id={id} className="min-w-0 space-y-1" data-testid="meal-slots-status">
      <p
        className={cn(
          'inline-flex max-w-full items-center gap-1.5 rounded-full text-sm font-medium',
          status.due ? 'border border-warning/80 bg-warning/10 px-2.5 py-0.5 text-warning' : status.complete ? 'text-success' : 'text-foreground',
        )}
        data-meal-state={status.due ? 'due' : status.complete ? 'complete' : status.offDay ? 'off' : 'pending'}
      >
        {status.due ? <Clock aria-hidden className="h-3.5 w-3.5 shrink-0" /> : status.complete ? <Check aria-hidden className="h-3.5 w-3.5 shrink-0" /> : null}
        <span className="min-w-0 break-words">{headline}</span>
      </p>
      {!compact && status.day.slots.length > 0 && (
        <ul className="space-y-0.5 text-xs text-muted-foreground" aria-label="Today's meals">
          {status.day.slots.map((state) => (
            <li key={state.slot.id} className={cn('break-words', slotTone(state))} data-slot-phase={state.phase}>
              {slotLine(state, timeZone)}
            </li>
          ))}
          {status.day.off.length > 0 && (
            <li className="text-muted-foreground">{status.day.off.map((slot) => slot.name).join(', ')}: not today</li>
          )}
        </ul>
      )}
    </div>
  );
}

function slotTone(state: SlotState): string {
  if (state.phase === 'fed') return 'text-foreground';
  if (state.phase === 'due') return 'font-medium text-foreground';
  return 'text-muted-foreground';
}

const MARK_CLASSES: Record<DayMark['state'], string> = {
  met: 'border-success bg-success text-success-foreground',
  partial: 'border-warning bg-warning/10 text-foreground',
  missed: 'border-destructive/60 bg-destructive/10 text-foreground',
  off: 'border-dashed border-border bg-transparent text-muted-foreground',
  fed: 'border-primary/50 bg-primary/10 text-foreground',
  today: 'border-primary bg-background text-foreground',
  unknown: 'border-dashed border-border bg-muted/40 text-muted-foreground',
};

const MARK_SYMBOL: Record<DayMark['state'], string> = {
  met: '✓',
  partial: '½',
  missed: '✕',
  off: '–',
  fed: '•',
  today: '…',
  unknown: '?',
};

/**
 * Seven-day feeding strip (PE-25): one mark per household day, each judged by
 * the plan in force that day (PE-25d), from the logs the card already loaded
 * (PE-25c). A double feed carries a "+N" badge (PE-25b); an off-day is a dashed
 * dash, never a miss. Each mark has its full text for screen readers and as a
 * title (no hover-only information: the list reads the same with a keyboard).
 */
export function FeedingWeekStrip({
  pet,
  logs,
  now,
  timeZone,
  complete,
  className,
}: {
  pet: Pick<PetProfile, 'foodSchedule' | 'feedingsPerDay' | 'portionAmount' | 'portionUnit' | 'mealPlan' | 'mealPlanHistory'>;
  logs: FeedingEntry[];
  now: Date;
  timeZone: string | null;
  /** The loaded logs are the whole history of these days (not cut at the listener's limit). */
  complete: boolean;
  className?: string;
}) {
  const marks = feedingWeek(pet, logs, now, timeZone, { complete });
  return (
    <div className={cn('space-y-1', className)} data-testid="feeding-week">
      <p className="text-xs font-medium text-muted-foreground">Last 7 days</p>
      <ol className="flex gap-1" aria-label="Feedings over the last 7 days">
        {marks.map((mark) => (
          <li key={mark.day} className="flex min-w-0 flex-1 flex-col items-center gap-0.5" data-day-state={mark.state} title={mark.label}>
            <span
              aria-hidden
              className={cn('relative flex h-7 w-full max-w-9 items-center justify-center rounded-md border text-xs font-semibold', MARK_CLASSES[mark.state])}
            >
              {MARK_SYMBOL[mark.state]}
              {mark.extra > 0 && (
                <span className="absolute -right-1 -top-1.5 rounded-full border border-border bg-card px-1 text-[0.625rem] font-semibold leading-tight text-foreground">
                  +{mark.extra}
                </span>
              )}
            </span>
            <span aria-hidden className="text-[0.6875rem] text-muted-foreground">{mark.weekday.slice(0, 2)}</span>
            <span className="sr-only">{mark.label}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

/**
 * "Set meal times" for a pet whose schedule is not confirmed as slots (D-P3,
 * PE-6g): opens the meal plan editor, where the parsed schedule is shown as a
 * suggestion to correct. Only for members who may edit pets.
 */
export function SetMealTimesButton({ petName, onClick, className }: { petName: string; onClick: () => void; className?: string }) {
  return (
    <Button type="button" variant="outline" size="sm" className={cn('w-full', className)} onClick={onClick} aria-label={`Set meal times for ${petName}`} data-testid="set-meal-times">
      <CalendarClock aria-hidden className="mr-2 h-4 w-4" />
      Set meal times
    </Button>
  );
}

/** A plan's slots as a read-only list for the pet page ("Breakfast · 7:00 am · 1 cup · not on Sun"). */
export function MealPlanList({ slots }: { slots: NonNullable<PetProfile['mealPlan']>['slots'] }) {
  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  return (
    <ul className="space-y-1" data-testid="meal-plan-list">
      {[...slots].sort((a, b) => a.time.localeCompare(b.time)).map((slot) => (
        <li key={slot.id} className="break-words text-muted-foreground">
          <span className="font-medium text-foreground">{slot.name}</span> · {formatSlotTime(slot.time)} · {formatPortion(slot.amount, slot.unit)}
          {slot.offDays?.length ? ` · not on ${slot.offDays.map((day) => DAYS[day]).join(', ')}` : ''}
        </li>
      ))}
    </ul>
  );
}
