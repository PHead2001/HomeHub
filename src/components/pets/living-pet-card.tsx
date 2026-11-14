'use client';

import * as React from 'react';
import { flushSync } from 'react-dom';
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
import { PeekCard } from '@/components/dashboard/peek-card';
import { useMorphNavigation } from '@/hooks/use-morph-navigation';
import { useReducedMotion } from '@/hooks/use-reduced-motion';
import { feedingHeadline, formatPortion, petHref, petPhotoMorphName, SPECIES_ART_LABEL, speciesArt } from '@/lib/pets/care';
import { morphStyle } from '@/lib/motion';
import { cn } from '@/lib/utils';
import type { PetProfile } from '@/lib/pets/types';
import { PinnedNoteLine } from './pinned-note-line';
import { PetCareSummary, petAttention, usePetCare, type PetCare } from './pet-care-summary';
import { mealHeadline } from '@/lib/pets/meal-plan';

export type PetAttention = NonNullable<ReturnType<typeof petAttention>>;
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
  /**
   * Reports what needs attention on this pet (PE-26: a due or missed meal, an
   * overdue medication), or null; never while its data is loading or failed.
   */
  onAttention?: (petId: string, attention: PetAttention | null) => void;
};

/** Species label for display: the stored type, or the illustration's species for legacy "Other". */
export function petTypeLabel(pet: Pick<PetProfile, 'type' | 'dataAiHint'>): string {
  if (pet.type && pet.type !== 'Other') return pet.type;
  const art = speciesArt(pet.type, pet.dataAiHint);
  return art === 'other' ? 'Pet' : SPECIES_ART_LABEL[art].replace(/^\w/, (c) => c.toUpperCase());
}

/** Peek card facts (H26) for the pet link: what the card does not already show in full. */
function PetPeek({ pet, care }: { pet: PetProfile; care: PetCare }) {
  const { plan, status, dues, now, timeZone } = care;
  return (
    <div className="space-y-1.5" data-testid={`pet-peek-${pet.id}`}>
      <p className="break-words font-semibold text-foreground">{pet.name}</p>
      <p className="text-xs text-muted-foreground">
        {petTypeLabel(pet)} · {formatPortion(plan.amount, plan.unit)}{plan.perDay ? `, ${plan.perDay}× a day` : ''}
      </p>
      {pet.foodSchedule && <p className="line-clamp-2 text-xs text-muted-foreground">{pet.foodSchedule}</p>}
      {care.meal?.kind === 'slots' && <p className="text-xs text-foreground">{mealHeadline(care.meal)}</p>}
      {status && <p className="text-xs text-foreground">{feedingHeadline(status, now, timeZone)}</p>}
      {dues.length > 0 && (
        <ul className="space-y-0.5 text-xs text-foreground">
          {dues.map((due) => <li key={due.medication}>{due.medication}: {due.label}</li>)}
        </ul>
      )}
      <p className="text-xs font-medium text-primary">Open {pet.name}&apos;s page</p>
    </div>
  );
}

/**
 * Living pet card (H09): photo with a face-safe crop or species art (D17), the
 * feeding ring ("1 of 2 today"), "Fed 2 h ago by Sam", the next medication
 * countdown, one-tap feeding and hold to feed (press and hold the photo). The
 * name is the card's link; the menu and the feed button sit above the link layer
 * so they stay separate targets. One feed controller serves the button and the
 * hold, so both go through the shared feed operation (`feedPet`).
 */
export function LivingPetCard({ pet, householdId, canEdit, onEdit, onDelete, priority, index = 0, onAttention }: LivingPetCardProps) {
  const href = petHref(pet.id);
  const care = usePetCare(pet, householdId);
  // PE-26: what needs attention, from the shared status; nothing while loading or failed.
  const attention = care.feedings.loading || care.feedings.error ? null : petAttention(care);
  const attentionKey = attention ? `${attention.meal ?? ''}|${attention.medication ?? ''}` : '';
  React.useEffect(() => {
    if (!onAttention) return;
    onAttention(pet.id, attentionKey ? attention : null);
    // Reported by its text, so a new object for the same state reports nothing new.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onAttention, pet.id, attentionKey]);
  React.useEffect(() => () => onAttention?.(pet.id, null), [onAttention, pet.id]);
  const reduced = useReducedMotion();
  const { navigate } = useMorphNavigation();
  // The photo takes its shared-element name only while morphing into the pet page
  // (H12), so other View Transitions (the theme reveal) never capture it.
  const [morphing, setMorphing] = React.useState(false);
  React.useEffect(() => {
    if (!morphing) return;
    const timer = window.setTimeout(() => setMorphing(false), 1500);
    return () => window.clearTimeout(timer);
  }, [morphing]);
  const openPet = (event: React.MouseEvent<HTMLAnchorElement>) => {
    // Plain navigation under reduced motion and for modified clicks (new tab, etc.);
    // a click swallowed by hold to feed is already prevented.
    if (reduced || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    flushSync(() => setMorphing(true));
    navigate(href);
  };
  const feed = useQuickFeed({ petId: pet.id, petName: pet.name, plan: care.plan, meal: care.meal, status: care.status, food: care.food, known: care.known });
  const photoRef = React.useRef<HTMLDivElement>(null);
  const { hold, enabled: holdEnabled, handlers } = useHoldToFeed(feed, photoRef);
  const hintId = `feed-hint-${pet.id}`;

  return (
    <Card
      // PE-26b: a card that needs attention gets a ring; the order of the cards never changes.
      className={cn(
        'glow-card relative flex h-full flex-col overflow-hidden transition-ui',
        attention && (attention.medication ? 'ring-2 ring-destructive/60' : 'ring-2 ring-warning/80'),
      )}
      data-attention={attention ? (attention.medication ? 'medication' : 'meal') : undefined}
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
          frameStyle={morphing ? morphStyle(petPhotoMorphName(pet.id)) : undefined}
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
                data-pet-actions={pet.id}
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
        {/* `static` keeps the stretched link positioned against the card, not the peek wrapper. */}
        <PeekCard peek={<PetPeek pet={pet} care={care} />} className="static min-w-0">
          {/* Long names without spaces wrap and clamp at two lines instead of being clipped (PE-20d). */}
          <h2 className="line-clamp-2 break-words font-headline text-xl font-semibold leading-tight [overflow-wrap:anywhere]" title={pet.name}>
            {/* Stretched link: the whole card opens the pet; other controls sit above it. */}
            {/* Not draggable and no touch callout, so holding the photo (through this link's layer) stays a hold. */}
            <Link
              href={href}
              onClick={openPet}
              draggable={false}
              data-hold-to-feed={holdEnabled ? '' : undefined}
              className="rounded-sm [-webkit-touch-callout:none] after:absolute after:inset-0 after:z-10 after:content-['']"
            >
              {pet.name}
            </Link>
          </h2>
          <p className="text-sm text-muted-foreground">{petTypeLabel(pet)}</p>
        </PeekCard>
        {/* The most important pinned note as one small line (PE-29c); the board (P4) places the same component. */}
        <PinnedNoteLine householdId={householdId} petId={pet.id} />

        <PetCareSummary
          pet={pet}
          householdId={householdId}
          care={care}
          feed={feed}
          feedHintId={holdEnabled ? hintId : undefined}
          feedClassName="relative z-20 mt-auto pt-1"
          onSetMealTimes={canEdit ? () => onEdit(pet) : undefined}
        />
      </div>
    </Card>
  );
}
