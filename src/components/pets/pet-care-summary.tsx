'use client';

import { useId } from 'react';
import { Skeleton } from '@/components/ui/skeleton';
import {
  currentMedications,
  feedingCountLabel,
  feedingHeadline,
  feedingPlan,
  feedingHistoryState,
  feedingStatus,
  quickFeedFood,
  type FeedingStatus,
} from '@/lib/pets/care';
import { NumberTicker } from '@/components/motion/number-ticker';
import { useAuth } from '@/hooks/use-auth';
import { knownFromLogs } from '@/lib/pets/feed-decision';
import type { PetFeedingLog, PetProfile } from '@/lib/pets/types';
import { cn } from '@/lib/utils';
import { FeedingRing } from './feeding-ring';
import { MedicationChips } from './medication-chip';
import { useMedicationCountdownLogs, usePetLogs } from './pet-log-api';
import { QuickFeedButton, type QuickFeedController } from './quick-feed-button';
import { useNow } from './use-now';
import { unavailableText } from '@/lib/pets/live-listener';

/**
 * A pet's live care data: feedings, the plan and today's status, and every
 * current medication countdown. "Today", "yesterday" and "Due today" are the
 * household's day (`household.timeZone`, PE-7a/b), and `now` comes from the one
 * shared minute clock (PE-21c), so every card rolls over at household midnight.
 */
export function usePetCare(pet: PetProfile, householdId: string) {
  const now = useNow();
  const { household } = useAuth();
  const timeZone = household?.timeZone ?? null;
  const feedings = usePetLogs<PetFeedingLog>(householdId, pet.id, 'feeding-logs', 20);
  const medications = useMedicationCountdownLogs(householdId, pet.id);
  const plan = feedingPlan(pet);
  const status = feedings.loading || feedings.error ? null : feedingStatus(feedings.logs, plan, now, timeZone);
  // Most urgent first; empty while loading or unavailable.
  const dues = medications.loading || medications.error ? [] : currentMedications(medications.logs, now, timeZone);
  // The quick-feed food type waits for the history (never Dry by default while loading).
  const food = quickFeedFood(feedingHistoryState(feedings), feedings.logs[0]?.foodType);
  // The feed operation's fallback for a pet without a feeding-state document (household day).
  const known = feedings.loading || feedings.error ? null : knownFromLogs(feedings.logs, now, timeZone);
  return { now, timeZone, feedings, medications, plan, status, dues, food, known };
}

export type PetCare = ReturnType<typeof usePetCare>;

/** "1 of 2 today" / "2 today" / "Not fed today", with the count as a live number (H12). */
function FeedingCount({ status }: { status: FeedingStatus }) {
  if (status.perDay) return <><NumberTicker value={status.fedToday} animateOnMount={false} /> of {status.perDay} today</>;
  if (status.fedToday > 0) return <><NumberTicker value={status.fedToday} animateOnMount={false} /> today</>;
  // An off-day of a non-daily schedule is not a missed meal (PE-18b).
  return <>{feedingCountLabel(status)}</>;
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
  const { now, timeZone, feedings, medications, plan, status, dues, food, known } = care;
  // The Feed button is described by the fed status it acts on (PE-20b), then the hold hint.
  const statusId = useId();

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
        <p id={statusId} className="text-sm text-muted-foreground">{unavailableText('Feeding status', feedings.failure ?? 'retrying')}</p>
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
          </div>
        </div>
      )}

      {medications.error ? (
        <p className="text-xs text-muted-foreground">{unavailableText('The next medication dose', medications.failure ?? 'retrying')}</p>
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
          known={known}
          controller={feed}
          describedBy={feedings.loading ? feedHintId : [statusId, feedHintId].filter(Boolean).join(' ')}
          variant={status?.complete ? 'secondary' : 'default'}
          className="w-full"
        />
      </div>
    </>
  );
}
