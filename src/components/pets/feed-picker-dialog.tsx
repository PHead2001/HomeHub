'use client';

import * as React from 'react';
import { ChevronLeft, Utensils } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { feedingPlan, formatPortion } from '@/lib/pets/care';
import type { PetProfile } from '@/lib/pets/types';
import { usePetCare } from './pet-care-summary';
import { FeedConfirmPanel, useQuickFeed } from './quick-feed-button';

function ConfirmStep({ pet, householdId, onDone }: { pet: PetProfile; householdId: string; onDone: () => void }) {
  const care = usePetCare(pet, householdId);
  const quick = useQuickFeed({ petId: pet.id, petName: pet.name, plan: care.plan, status: care.status, food: care.food });
  const titleId = React.useId();
  return <FeedConfirmPanel petName={pet.name} quick={quick} titleId={titleId} onDone={onDone} />;
}

/**
 * "Log feeding" from the home-screen shortcut (`/pets?feed=1`, H17): with one pet
 * it opens straight to the confirm step; with several it lists them first. Every
 * path ends in the same tap-plus-confirm step and writer as the Feed button.
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
          <DialogDescription>{chosen ? `At ${chosen.name}'s usual portion.` : 'Who did you feed?'}</DialogDescription>
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
            {pets.map((pet) => {
              const plan = feedingPlan(pet);
              const portion = formatPortion(plan.amount, plan.unit);
              return (
                <li key={pet.id}>
                  <Button type="button" variant="outline" className="w-full justify-start" onClick={() => setChosenId(pet.id)} aria-label={`${pet.name}, ${portion}`}>
                    <Utensils aria-hidden className="mr-2 h-4 w-4" />
                    <span className="truncate">{pet.name}</span>
                    <span className="ml-auto pl-2 text-xs text-muted-foreground">{portion}</span>
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  );
}
