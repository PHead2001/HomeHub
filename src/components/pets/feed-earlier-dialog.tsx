'use client';

import * as React from 'react';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { FieldError, fieldErrorProps } from '@/components/field-error';
import type { FeedingEntry } from '@/lib/pets/care';
import {
  EARLIER_CHIP_MINUTES,
  EARLIER_REFUSALS,
  checkEarlierTime,
  earlierChipLabel,
  earlierChoice,
  earlierFeedPlan,
  earlierInstant,
  earlierPlanLine,
  earlierWhenLabel,
  type EarlierDay,
  type EarlierPlan,
} from '@/lib/pets/feed-earlier';
import type { planForDay } from '@/lib/pets/meal-plan';
import type { PortionUnit } from '@/lib/pets/types';
import { cn } from '@/lib/utils';
import { useNow } from './use-now';

/** What the dialog asks to log: the chosen time (`backdatedAt` when more than a minute ago) and the portion it counts for. */
export type FeedEarlierChoice = {
  at: Date;
  backdatedAt?: Date;
  portion: { amount: number; unit: PortionUnit };
  slotName: string | null;
  /** It counts as an extra feeding of its day (its meal was already fed, or none is planned then). */
  extra: boolean;
};

export type FeedEarlierDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  petName: string;
  /** The household zone; every choice is a household wall time (never the device's zone). */
  timeZone: string | null | undefined;
  /** The pet's plan source (meal times and their history); null while unknown (the portion then comes from `fallbackPortion`). */
  pet: Parameters<typeof planForDay>[0] | null;
  /** Recent feedings (today's and yesterday's), null while loading or unavailable. */
  logs: FeedingEntry[] | null;
  /** The portion when the plan is unknown (the usual portion). */
  fallbackPortion: { amount: number; unit: PortionUnit };
  /** "Fed 2 h ago by Sam": the last-fed context. */
  lastFed?: string | null;
  saving: boolean;
  /** Logs it; resolves true when the dialog may close (saved, queued, or handed to "Feed again?"). */
  onSave: (choice: FeedEarlierChoice) => Promise<boolean>;
  onCloseAutoFocus?: (event: Event) => void;
};

const chipTestId = (minutes: number) => `feed-earlier-chip-${minutes}`;

/**
 * "When did <pet> eat?" (owner request "Feed earlier"): quick choices (15 min,
 * 30 min, 1 h, 2 h ago), Today or Yesterday and a time field, all household
 * wall times. It shows when that is, the meal it counts for with the plan in
 * force that day (or that it is an extra feeding) and its portion, and the last
 * feeding. A future time is refused inline. Saving goes through the caller's
 * shared feed path (`onSave`); the dialog stays open after a failure (the
 * toast offers Retry).
 */
export function FeedEarlierDialog({
  open,
  onOpenChange,
  petName,
  timeZone,
  pet,
  logs,
  fallbackPortion,
  lastFed,
  saving,
  onSave,
  onCloseAutoFocus,
}: FeedEarlierDialogProps) {
  const now = useNow();
  const timeId = React.useId();
  const [day, setDay] = React.useState<EarlierDay>('today');
  const [time, setTime] = React.useState('');
  // The chosen quick choice and its exact instant (a wall time that happens twice, at fall back, stays the one chosen).
  const [chip, setChip] = React.useState<{ minutes: number; at: Date } | null>(null);
  const [submitted, setSubmitted] = React.useState(false);
  const [shownOpen, setShownOpen] = React.useState(false);
  // Reset on every opening (state adjusted during render, as the other pet dialogs do).
  if (open !== shownOpen) {
    setShownOpen(open);
    if (open) {
      setDay('today');
      setTime('');
      setChip(null);
      setSubmitted(false);
    }
  }

  const at = chip ? chip.at : time ? earlierInstant(day, time, now, timeZone) : null;
  const check = at ? checkEarlierTime(at, now, timeZone) : null;
  // A future time is refused as soon as it is typed; a blank one only once Save was tried.
  const error = check && !check.ok ? EARLIER_REFUSALS[check.reason] : submitted && !at ? EARLIER_REFUSALS.invalid : null;
  const plan: EarlierPlan | null = at && check?.ok
    ? (pet ? earlierFeedPlan(pet, logs, at, now, timeZone) : { kind: 'legacy', ...fallbackPortion })
    : null;

  const choose = (minutes: number) => {
    const choice = earlierChoice(minutes, new Date(), timeZone);
    setChip({ minutes, at: choice.at });
    setDay(choice.day);
    setTime(choice.time);
  };

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    setSubmitted(true);
    if (saving) return;
    const current = new Date();
    const chosen = chip ? chip.at : time ? earlierInstant(day, time, current, timeZone) : null;
    const result = checkEarlierTime(chosen, current, timeZone);
    if (!result.ok || !chosen) return;
    const counted = pet ? earlierFeedPlan(pet, logs, chosen, current, timeZone) : { kind: 'legacy' as const, ...fallbackPortion };
    const done = await onSave({
      at: chosen,
      ...(result.backdatedAt ? { backdatedAt: result.backdatedAt } : {}),
      portion: { amount: counted.amount, unit: counted.unit },
      slotName: counted.kind === 'slot' ? counted.slotName : null,
      extra: counted.kind === 'extra',
    });
    if (done) onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!saving) onOpenChange(next); }}>
      <DialogContent className="sm:max-w-[440px]" data-testid="feed-earlier-dialog" onCloseAutoFocus={onCloseAutoFocus} phoneSheet>
        <form onSubmit={save} noValidate>
          <DialogHeader>
            <DialogTitle className="break-words">When did {petName} eat?</DialogTitle>
            <DialogDescription className="break-words" data-testid="feed-earlier-last-fed">
              {lastFed ? `${lastFed}.` : 'Log a feeding that already happened.'}
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div role="group" aria-label="Quick choices" className="flex flex-wrap gap-2">
              {EARLIER_CHIP_MINUTES.map((minutes) => (
                <Button
                  key={minutes}
                  type="button"
                  size="sm"
                  variant={chip?.minutes === minutes ? 'default' : 'outline'}
                  aria-pressed={chip?.minutes === minutes}
                  className="min-h-11 rounded-full"
                  onClick={() => choose(minutes)}
                  data-testid={chipTestId(minutes)}
                >
                  {earlierChipLabel(minutes)}
                </Button>
              ))}
            </div>
            <div className="grid gap-2">
              <Label htmlFor={timeId}>Or choose the time</Label>
              <div className="flex flex-wrap items-center gap-2">
                <div role="group" aria-label="Day" className="flex">
                  {(['today', 'yesterday'] as const).map((option, index) => (
                    <Button
                      key={option}
                      type="button"
                      variant={day === option ? 'default' : 'outline'}
                      aria-pressed={day === option}
                      className={cn(index === 0 ? 'rounded-r-none' : 'rounded-l-none border-l-0')}
                      onClick={() => { setDay(option); setChip(null); }}
                      data-testid={`feed-earlier-day-${option}`}
                    >
                      {option === 'today' ? 'Today' : 'Yesterday'}
                    </Button>
                  ))}
                </div>
                <Input
                  type="time"
                  value={time}
                  className="w-36"
                  onChange={(event) => { setTime(event.target.value); setChip(null); }}
                  data-testid="feed-earlier-time"
                  {...fieldErrorProps(timeId, error)}
                />
              </div>
              <FieldError id={timeId}>{error}</FieldError>
            </div>
            <div role="status" aria-live="polite" className="min-h-16 rounded-md bg-muted px-3 py-2 text-sm" data-testid="feed-earlier-summary">
              {at && plan ? (
                <>
                  <p className="font-medium text-foreground" data-testid="feed-earlier-when">{earlierWhenLabel(at, now, timeZone)}</p>
                  <p className="text-muted-foreground" data-testid="feed-earlier-counts">{earlierPlanLine(plan, timeZone)}</p>
                </>
              ) : (
                <p className="text-muted-foreground">Choose when {petName} ate.</p>
              )}
            </div>
          </div>
          <DialogFooter className="gap-2">
            <Button type="button" variant="outline" disabled={saving} onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={saving || Boolean(check && !check.ok)} data-testid="feed-earlier-save">
              {saving && <Loader2 aria-hidden className="mr-2 h-4 w-4 animate-spin" />}
              Log feeding
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
