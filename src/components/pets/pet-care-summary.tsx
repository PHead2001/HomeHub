'use client';

import { useId, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Skeleton } from '@/components/ui/skeleton';
import {
  feedingCountLabel,
  feedingHeadline,
  feedingPlan,
  feedingHistoryState,
  quickFeedFood,
  type FeedingStatus,
} from '@/lib/pets/care';
import { mealAttention, mealStatus, type MealStatus } from '@/lib/pets/meal-plan';
import { NumberTicker } from '@/components/motion/number-ticker';
import { useAuth } from '@/hooks/use-auth';
import { knownFromLogs } from '@/lib/pets/feed-decision';
import type { PetFeedingLog, PetProfile } from '@/lib/pets/types';
import { cn } from '@/lib/utils';
import { FeedingRing } from './feeding-ring';
import { MedicationChips } from './medication-chip';
import { FeedingWeekStrip, MealSlotsStatus, SetMealTimesButton } from './meal-status';
import { GiveDoseDialog } from './give-dose-dialog';
import { useMedicationState } from './medication-api';
import { usePetLogs } from './pet-log-api';
import { QuickFeedButton, type QuickFeedController } from './quick-feed-button';
import { useNow } from './use-now';
import { unavailableText } from '@/lib/pets/live-listener';

/**
 * Newest feedings each card loads (per date shape, merged): enough for the
 * seven-day strip of a pet with up to four meals a day (PE-25c). Fewer loaded
 * than this means the history is complete; at the limit, older days the strip
 * cannot see read "not loaded", never "missed".
 */
export const PET_FEEDING_WINDOW = 30;

/**
 * A pet's live care data: feedings, the plan and today's status, and every
 * current medication countdown. "Today", "yesterday" and "Due today" are the
 * household's day (`household.timeZone`, PE-7a/b), and `now` comes from the one
 * shared minute clock (PE-21c), so every card rolls over at household midnight.
 * `meal` is the one shared feeding status (PE-22h): meal slots when the pet has
 * a confirmed plan, else the legacy daily target.
 */
export function usePetCare(pet: PetProfile, householdId: string) {
  const now = useNow();
  const { household } = useAuth();
  const timeZone = household?.timeZone ?? null;
  const feedings = usePetLogs<PetFeedingLog>(householdId, pet.id, 'feeding-logs', PET_FEEDING_WINDOW);
  // Courses (their next scheduled dose) and legacy countdowns (D-P8), most urgent first (P3).
  const medications = useMedicationState(householdId, pet.id, now, timeZone);
  const unknown = feedings.loading || Boolean(feedings.error);
  const meal: MealStatus | null = unknown ? null : mealStatus(pet, feedings.logs, now, timeZone);
  // The legacy plan (no confirmed slots), for the detailed form's defaults and older readers.
  const plan = meal?.kind === 'legacy' ? meal.plan : feedingPlan(pet);
  const status: FeedingStatus | null = meal ? ringView(meal) : null;
  // Most urgent first; empty while loading or unavailable.
  const dues = medications.dues;
  // The quick-feed food type waits for the history (never Dry by default while loading).
  const food = quickFeedFood(feedingHistoryState(feedings), feedings.logs[0]?.foodType);
  // The feed operation's fallback for a pet without a feeding-state document (household day).
  const known = unknown ? null : knownFromLogs(feedings.logs, now, timeZone);
  const historyComplete = feedings.logs.length < PET_FEEDING_WINDOW;
  return { now, timeZone, feedings, medications, plan, meal, status, dues, food, known, historyComplete };
}

export type PetCare = ReturnType<typeof usePetCare>;

/** The ring's view of either status: meals fed of today's planned meals, or the legacy count. */
function ringView(meal: MealStatus): FeedingStatus {
  if (meal.kind === 'legacy') return meal.status;
  const { fedCount, planned } = meal.day;
  return {
    fedToday: fedCount,
    perDay: planned || null,
    progress: planned ? Math.min(1, fedCount / planned) : 0,
    complete: meal.complete,
    last: meal.last,
    ...(meal.offDay ? { nonDaily: true } : {}),
  };
}

/** What the attention strip and the card ring show for a pet (PE-26): a due or missed meal, or an overdue medication. */
export function petAttention(care: Pick<PetCare, 'meal' | 'dues' | 'medications'>): { meal: string | null; medication: string | null } | null {
  const meal = mealAttention(care.meal);
  const overdue = care.medications.error ? undefined : care.dues.find((due) => due.state === 'overdue');
  const medication = overdue ? `${overdue.medication}: ${overdue.label.toLowerCase()}` : null;
  return meal || medication ? { meal, medication } : null;
}

/** "1 of 2 today" / "2 today" / "Not fed today", with the count as a live number (H12). */
function FeedingCount({ status }: { status: FeedingStatus }) {
  if (status.perDay) return <><NumberTicker value={status.fedToday} animateOnMount={false} /> of {status.perDay} today</>;
  if (status.fedToday > 0) return <><NumberTicker value={status.fedToday} animateOnMount={false} /> today</>;
  // An off-day of a non-daily schedule is not a missed meal (PE-18b).
  return <>{feedingCountLabel(status)}</>;
}

/**
 * Feeding ring, today's meals or "Fed 2 h ago by Sam", one chip per current
 * medication and feeding, shared by the pet card and the pet detail page. A
 * failed load is shown as "unavailable", never as an empty history (which
 * would read as "not fed"). The pet card passes its own `care` and `feed`
 * controller, which hold to feed shares, so both use one data subscription and
 * one writer.
 */
type SummaryProps = {
  pet: PetProfile;
  householdId: string;
  feedClassName?: string;
  care?: PetCare;
  feed?: QuickFeedController;
  feedHintId?: string;
  /** Medication chips shown before "+N" (the card is compact; the detail page shows more). */
  maxMedicationChips?: number;
  /** The seven-day strip (PE-25). */
  showWeek?: boolean;
  /** "Set meal times" for a pet without confirmed slots; only passed to members who may edit pets. */
  onSetMealTimes?: () => void;
};

export function PetCareSummary(props: SummaryProps) {
  return props.care ? <CareSummaryView {...props} care={props.care} /> : <OwnCareSummary {...props} />;
}

function OwnCareSummary(props: SummaryProps) {
  const care = usePetCare(props.pet, props.householdId);
  return <CareSummaryView {...props} care={care} />;
}

function CareSummaryView({ pet, feedClassName, care, feed, feedHintId, maxMedicationChips = 2, showWeek, onSetMealTimes }: SummaryProps & { care: PetCare }) {
  const { now, timeZone, feedings, medications, plan, meal, status, dues, food, known } = care;
  // The Feed button is described by the fed status it acts on (PE-20b), then the hold hint.
  const statusId = useId();
  const router = useRouter();
  // A course chip opens Give dose here (PE-24b); a legacy chip opens the Medication tab, where it is confirmed.
  const [givingId, setGivingId] = useState<string | null>(null);
  const giving = givingId ? medications.courses.find((course) => course.id === givingId && course.status === 'active') ?? null : null;

  return (
    <>
      {feedings.loading ? (
        <div className="flex items-center gap-3" aria-hidden>
          <Skeleton className="h-12 w-12 rounded-full" />
          <div className="flex-1 space-y-1.5">
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-3 w-1/3" />
          </div>
        </div>
      ) : !status || !meal ? (
        <p id={statusId} className="text-sm text-muted-foreground">{unavailableText('Feeding status', feedings.failure ?? 'retrying')}</p>
      ) : meal.kind === 'slots' ? (
        <div className="flex items-start gap-3">
          <FeedingRing status={status} />
          <div id={statusId} className="min-w-0 space-y-1">
            <MealSlotsStatus status={meal} timeZone={timeZone} />
            <p className="text-xs text-muted-foreground">{feedingHeadline(status, now, timeZone)}</p>
          </div>
        </div>
      ) : (
        <div className="flex items-center gap-3">
          <FeedingRing status={status} />
          <div id={statusId} className="min-w-0">
            <p className={cn('text-sm font-medium', status.last ? 'text-foreground' : 'text-muted-foreground')}>
              {feedingHeadline(status, now, timeZone)}
            </p>
            <p className={cn('text-xs', status.complete ? 'font-medium text-success' : 'text-muted-foreground')}>
              {status.complete && status.perDay ? 'All fed today' : <FeedingCount status={status} />}
            </p>
            {/* PE-10b (D-P18): a neutral hint from the parsed schedule, never a "due" claim. */}
            {meal.nextMealHint && <p className="text-xs text-muted-foreground" data-testid="next-meal-hint">{meal.nextMealHint}</p>}
          </div>
        </div>
      )}

      {showWeek && !feedings.loading && !feedings.error && (
        <FeedingWeekStrip pet={pet} logs={feedings.logs} now={now} timeZone={timeZone} complete={care.historyComplete} />
      )}

      {medications.error ? (
        <p className="text-xs text-muted-foreground">{unavailableText('The next medication dose', medications.failure ?? 'retrying')}</p>
      ) : (
        <MedicationChips
          dues={dues}
          max={maxMedicationChips}
          className="self-start"
          onSelect={(due) => {
            if (due.courseId) setGivingId(due.courseId);
            else router.push(`/pets/${encodeURIComponent(pet.id)}?tab=medication`);
          }}
        />
      )}
      <GiveDoseDialog petId={pet.id} petName={pet.name} course={giving} onOpenChange={(open) => { if (!open) setGivingId(null); }} />

      <div className={cn('flex flex-col gap-2', feedClassName)}>
        {meal?.kind === 'legacy' && onSetMealTimes && <SetMealTimesButton petName={pet.name} onClick={onSetMealTimes} />}
        <QuickFeedButton
          petId={pet.id}
          petName={pet.name}
          plan={plan}
          meal={meal}
          status={status}
          food={food}
          known={known}
          controller={feed}
          describedBy={feedings.loading ? feedHintId : [statusId, feedHintId].filter(Boolean).join(' ')}
          variant={meal?.kind === 'slots' ? (meal.complete || meal.offDay ? 'secondary' : 'default') : status?.complete ? 'secondary' : 'default'}
          className="w-full"
        />
      </div>
    </>
  );
}
