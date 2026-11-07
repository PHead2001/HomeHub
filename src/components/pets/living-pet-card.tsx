'use client';

import * as React from 'react';
import Link from 'next/link';
import { Edit, MoreVertical, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { SPECIES_ART_LABEL, speciesArt } from '@/lib/pets/care';
import type { PetProfile } from '@/lib/pets/types';
import { PetCareSummary, usePetCare } from './pet-care-summary';
import { PetPhoto } from './pet-photo';
import { HoldToFeedOverlay, useHoldToFeed } from './hold-to-feed';
import { useQuickFeed } from './quick-feed-button';

export type LivingPetCardProps = {
  pet: PetProfile;
  householdId: string;
  canEdit: boolean;
  onEdit: (pet: PetProfile) => void;
  onDelete: (pet: PetProfile) => void;
  priority?: boolean;
  index?: number;
};

/** Species label for display: the stored type, or the illustration's species for legacy "Other". */
export function petTypeLabel(pet: Pick<PetProfile, 'type' | 'dataAiHint'>): string {
  if (pet.type && pet.type !== 'Other') return pet.type;
  const art = speciesArt(pet.type, pet.dataAiHint);
  return art === 'other' ? 'Pet' : SPECIES_ART_LABEL[art].replace(/^\w/, (c) => c.toUpperCase());
}

/**
 * Living pet card (H09): photo with a face-safe crop or species art (D17), the
 * feeding ring ("1 of 2 today"), "Fed 2 h ago by Sam", the next medication
 * countdown, one-tap feeding and hold to feed (press and hold the photo). The
 * name is the card's link; the menu and the feed button sit above the link layer
 * so they stay separate targets. One feed controller serves the button and the
 * hold, so both write through the same `addFeedingLog` call.
 */
export function LivingPetCard({ pet, householdId, canEdit, onEdit, onDelete, priority, index = 0 }: LivingPetCardProps) {
  const href = `/pets/${pet.id}`;
  const care = usePetCare(pet, householdId);
  const feed = useQuickFeed({ petId: pet.id, petName: pet.name, plan: care.plan, status: care.status, foodType: care.foodType });
  const photoRef = React.useRef<HTMLDivElement>(null);
  const { hold, enabled: holdEnabled, handlers } = useHoldToFeed(feed, photoRef);
  const hintId = `feed-hint-${pet.id}`;

  return (
    <Card
      className="glow-card relative flex h-full flex-col overflow-hidden transition-ui"
      data-testid={`pet-card-${pet.id}`}
      {...(holdEnabled ? handlers : {})}
    >
      <div ref={photoRef} className="relative select-none" data-testid={`pet-photo-${pet.id}`} data-hold-phase={hold.phase}>
        <PetPhoto
          name={pet.name}
          type={pet.type}
          hint={pet.dataAiHint}
          photoUrl={pet.photoUrl}
          priority={priority}
          sizes="(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 25vw"
          className="aspect-[4/3] w-full"
          blinkOffset={index}
        />
        {holdEnabled && <HoldToFeedOverlay hold={hold} feed={feed} />}
      </div>
      {holdEnabled && (
        <span id={hintId} className="sr-only">
          Or press and hold the photo of {pet.name} to log {feed.portion}.
        </span>
      )}

      {canEdit && (
        <div className="absolute right-2 top-2 z-20">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="secondary"
                size="icon"
                aria-label={`Open actions for ${pet.name}`}
                className="h-9 w-9 rounded-full bg-background/80 shadow-raised hover:bg-background"
              >
                <MoreVertical className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => onEdit(pet)}>
                <Edit className="mr-2 h-4 w-4" />
                <span>Edit</span>
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => onDelete(pet)} className="text-destructive focus:bg-destructive/10 focus:text-destructive">
                <Trash2 className="mr-2 h-4 w-4" />
                <span>Delete</span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      )}

      <div className="flex flex-1 flex-col gap-3 p-4">
        <div className="min-w-0">
          <h2 className="font-headline text-xl font-semibold leading-tight">
            {/* Stretched link: the whole card opens the pet; other controls sit above it. */}
            {/* Not draggable and no touch callout, so holding the photo (through this link's layer) stays a hold. */}
            <Link
              href={href}
              draggable={false}
              data-hold-to-feed={holdEnabled ? '' : undefined}
              className="rounded-sm [-webkit-touch-callout:none] after:absolute after:inset-0 after:z-10 after:content-['']"
            >
              {pet.name}
            </Link>
          </h2>
          <p className="text-sm text-muted-foreground">{petTypeLabel(pet)}</p>
        </div>

        <PetCareSummary
          pet={pet}
          householdId={householdId}
          care={care}
          feed={feed}
          feedHintId={holdEnabled ? hintId : undefined}
          feedClassName="relative z-20 mt-auto pt-1"
        />
      </div>
    </Card>
  );
}
