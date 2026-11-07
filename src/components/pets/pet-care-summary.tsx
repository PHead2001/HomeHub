'use client';

import { Skeleton } from '@/components/ui/skeleton';
import {
  currentMedications,
  feedingHeadline,
  feedingPlan,
  feedingHistoryState,
  feedingStatus,
  quickFeedFood,
  type FeedingStatus,
} from '@/lib/pets/care';
import { NumberTicker } from '@/components/motion/number-ticker';
import type { PetFeedingLog, PetProfile } from '@/lib/pets/types';
import { cn } from '@/lib/utils';
import { FeedingRing } from './feeding-ring';
import { MedicationChips } from './medication-chip';
import { useMedicationCountdownLogs, usePetLogs } from './pet-log-api';
import { QuickFeedButton, type QuickFeedController } from './quick-feed-button';
import { useNow } from './use-now';

/** A pet's live care data: feedings, the plan and today's status, and every current medication countdown. */
export function usePetCare(pet: PetProfile, householdId: string) {
  const now = useNow();
  const feedings = usePetLogs<PetFeedingLog>(householdId, pet.id, 'feeding-logs', 20);
  const medications = useMedicationCountdownLogs(householdId, pet.id);
  const plan = feedingPlan(pet);
  const status = feedings.loading || feedings.error ? null : feedingStatus(feedings.logs, plan, now);
  // Most urgent first; empty while loading or unavailable.
  const dues = medications.loading || medications.error ? [] : currentMedications(medications.logs, now);
  // The quick-feed food type waits for the history (never Dry by default while loading).
  const food = quickFeedFood(feedingHistoryState(feedings), feedings.logs[0]?.foodType);
  return { now, feedings, medications, plan, status, dues, food };
}

export type PetCare = ReturnType<typeof usePetCare>;

/** "1 of 2 today" / "2 today" / "Not fed today", with the count as a live number (H12). */
function FeedingCount({ status }: { status: FeedingStatus }) {
  if (status.perDay) return <><NumberTicker value={status.fedToday} animateOnMount={false} /> of {status.perDay} today</>;
  if (status.fedToday > 0) return <><NumberTicker value={status.fedToday} animateOnMount={false} /> today</>;
  return <>Not fed today</>;
}

/**
 * Feeding ring, "Fed 2 h ago by Sam", one chip per current medication and feeding,
 * shared by the pet card and the pet detail page. A failed load is shown as
 * "unavailable", never as an empty history (which would read as "not fed").
 * The pet card passes its own `care` and `feed` controller, which hold to feed
 * shares, so both use one data subscription and one writer.
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
};

export function PetCareSummary(props: SummaryProps) {
  return props.care ? <CareSummaryView {...props} care={props.care} /> : <OwnCareSummary {...props} />;
}

function OwnCareSummary(props: SummaryProps) {
  const care = usePetCare(props.pet, props.householdId);
  return <CareSummaryView {...props} care={care} />;
}

function CareSummaryView({ pet, feedClassName, care, feed, feedHintId, maxMedicationChips = 2 }: SummaryProps & { care: PetCare }) {
  const { now, feedings, medications, plan, status, dues, food } = care;

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
      ) : !status ? (
        <p className="text-sm text-muted-foreground">Feeding status is unavailable right now.</p>
      ) : (
        <div className="flex items-center gap-3">
          <FeedingRing status={status} />
          <div className="min-w-0">
            <p className={cn('text-sm font-medium', status.last ? 'text-foreground' : 'text-muted-foreground')}>
              {feedingHeadline(status, now)}
            </p>
            <p className={cn('text-xs', status.complete ? 'font-medium text-success' : 'text-muted-foreground')}>
              {status.complete && status.perDay ? 'All fed today' : <FeedingCount status={status} />}
            </p>
          </div>
        </div>
      )}

      {medications.error ? (
        <p className="text-xs text-muted-foreground">Next medication dose is unavailable right now.</p>
      ) : (
        <MedicationChips dues={dues} max={maxMedicationChips} className="self-start" />
      )}

      <div className={feedClassName}>
        <QuickFeedButton
          petId={pet.id}
          petName={pet.name}
          plan={plan}
          status={status}
          food={food}
          controller={feed}
          describedBy={feedHintId}
          variant={status?.complete ? 'secondary' : 'default'}
          className="w-full"
        />
      </div>
    </>
  );
}
