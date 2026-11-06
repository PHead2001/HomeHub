'use client';

import { Skeleton } from '@/components/ui/skeleton';
import {
  feedingCountLabel,
  feedingHeadline,
  feedingPlan,
  feedingStatus,
  knownFoodType,
  nextMedication,
} from '@/lib/pets/care';
import type { PetFeedingLog, PetProfile } from '@/lib/pets/types';
import { cn } from '@/lib/utils';
import { FeedingRing } from './feeding-ring';
import { MedicationChip } from './medication-chip';
import { useMedicationCountdownLogs, usePetLogs } from './pet-log-api';
import { QuickFeedButton } from './quick-feed-button';
import { useNow } from './use-now';

/**
 * Feeding ring, "Fed 2 h ago by Sam", the next-medication chip and one-tap feeding,
 * shared by the pet card and the pet detail page. A failed load is shown as
 * "unavailable", never as an empty history (which would read as "not fed").
 */
export function PetCareSummary({ pet, householdId, feedClassName }: { pet: PetProfile; householdId: string; feedClassName?: string }) {
  const now = useNow();
  const feedings = usePetLogs<PetFeedingLog>(householdId, pet.id, 'feeding-logs', 20);
  const medications = useMedicationCountdownLogs(householdId, pet.id);

  const plan = feedingPlan(pet);
  const status = feedings.loading || feedings.error ? null : feedingStatus(feedings.logs, plan, now);
  const due = medications.loading || medications.error ? null : nextMedication(medications.logs, now);

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
              {status.complete && status.perDay ? 'All fed today' : feedingCountLabel(status)}
            </p>
          </div>
        </div>
      )}

      {medications.error ? (
        <p className="text-xs text-muted-foreground">Next medication dose is unavailable right now.</p>
      ) : due ? (
        <MedicationChip due={due} className="self-start" />
      ) : null}

      <div className={feedClassName}>
        <QuickFeedButton
          petId={pet.id}
          petName={pet.name}
          plan={plan}
          status={status}
          foodType={knownFoodType(feedings.logs[0]?.foodType)}
          variant={status?.complete ? 'secondary' : 'default'}
          className="w-full"
        />
      </div>
    </>
  );
}
