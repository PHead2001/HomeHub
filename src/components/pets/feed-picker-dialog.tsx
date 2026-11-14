'use client';

import * as React from 'react';
import { ChevronLeft, Utensils } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { feedingCountLabel, feedingHeadline, formatPortion } from '@/lib/pets/care';
import type { PetProfile } from '@/lib/pets/types';
import { usePetCare, type PetCare } from './pet-care-summary';
import { FeedConfirmPanel, useQuickFeed } from './quick-feed-button';

/** "Fed 12 min ago by Sam · 1 of 2 today", "Checking…" while loading, or "Last feeding unavailable" (PE-19). */
function fedStatusLine(care: PetCare): string {
  if (care.feedings.loading) return 'Checking last feeding…';
  if (!care.status) return 'Last feeding unavailable';
  const headline = feedingHeadline(care.status, care.now, care.timeZone);
  return care.status.last ? `${headline} · ${feedingCountLabel(care.status)}` : headline;
}

function ConfirmStep({ pet, householdId, onDone }: { pet: PetProfile; householdId: string; onDone: () => void }) {
  const care = usePetCare(pet, householdId);
  const quick = useQuickFeed({ petId: pet.id, petName: pet.name, plan: care.plan, status: care.status, food: care.food, known: care.known });
  const titleId = React.useId();
  const lastFed = care.status?.last ? fedStatusLine(care) : null;
  return <FeedConfirmPanel petName={pet.name} quick={quick} titleId={titleId} onDone={onDone} lastFed={lastFed} />;
}

/** One pet in the list, with its portion and fed status. */
function PetRow({ pet, householdId, onChoose }: { pet: PetProfile; householdId: string; onChoose: () => void }) {
  const care = usePetCare(pet, householdId);
  const portion = formatPortion(care.plan.amount, care.plan.unit);
  const status = fedStatusLine(care);
  return (
    <Button
      type="button"
      variant="outline"
      className="h-auto min-h-12 w-full justify-start py-2"
      onClick={onChoose}
      aria-label={`${pet.name}, ${portion}. ${status}`}
    >
      <Utensils aria-hidden className="mr-2 h-4 w-4 shrink-0" />
      <span className="min-w-0 whitespace-normal text-left">
        <span className="line-clamp-2 block break-words [overflow-wrap:anywhere]">{pet.name}</span>
        <span className="block truncate text-xs font-normal text-muted-foreground" data-testid={`feed-picker-status-${pet.id}`}>{status}</span>
      </span>
      <span className="ml-auto shrink-0 pl-2 text-xs text-muted-foreground">{portion}</span>
    </Button>
  );
}

/**
 * "Log feeding" from the home-screen shortcut (`/pets?feed=1`, H17): with one pet
 * it opens straight to the confirm step; with several it lists them first, each
 * with its fed status ("Fed 12 min ago by Sam · 1 of 2 today", PE-19). Every
 * path ends in the same confirm step and shared feed operation as the Feed
 * button, including its "Feed again?" check.
 */
export function FeedPickerDialog({
  open,
  onOpenChange,
  pets,
  householdId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  pets: PetProfile[];
  householdId: string;
}) {
  const [chosenId, setChosenId] = React.useState<string | null>(null);
  const single = pets.length === 1 ? pets[0] : null;
  const chosen = single ?? pets.find((pet) => pet.id === chosenId) ?? null;
  const close = () => {
    onOpenChange(false);
    setChosenId(null);
  };

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : close())}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Log a feeding</DialogTitle>
          <DialogDescription className="break-words">{chosen ? `At ${chosen.name}'s usual portion.` : 'Who did you feed?'}</DialogDescription>
        </DialogHeader>
        {chosen ? (
          <div className="space-y-3">
            <ConfirmStep key={chosen.id} pet={chosen} householdId={householdId} onDone={close} />
            {!single && (
              <Button type="button" variant="link" className="h-auto p-0" onClick={() => setChosenId(null)}>
                <ChevronLeft aria-hidden className="mr-1 h-4 w-4" /> Choose another pet
              </Button>
            )}
          </div>
        ) : (
          <ul className="space-y-2" aria-label="Pets">
            {pets.map((pet) => (
              <li key={pet.id}>
                <PetRow pet={pet} householdId={householdId} onChoose={() => setChosenId(pet.id)} />
              </li>
            ))}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  );
}
