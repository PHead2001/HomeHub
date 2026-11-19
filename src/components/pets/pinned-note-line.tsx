'use client';

import { Pin } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useSharedPetCare } from './care-store';

/**
 * The pet's most important pinned note as one small line (PE-29c): the first
 * pinned note (newest pin; "Show first" moves one up). Shown on the pet card
 * and the pet page; the wall board (P4) places the same component. Nothing is
 * rendered while loading, on a failed read, or without pinned notes, so it
 * never claims anything it has not read.
 */
export function PinnedNoteLine({ householdId, petId, className }: { householdId: string | null | undefined; petId: string; className?: string }) {
  // From the household's care store (PE-21a): the card, the board and the pet page share one subscription.
  const { headline, loading, error } = useSharedPetCare(householdId, petId).pinned;
  if (loading || error || !headline) return null;
  return (
    <p className={cn('flex min-w-0 items-start gap-1.5 text-sm text-muted-foreground', className)} data-testid={`pinned-note-${petId}`}>
      <Pin aria-hidden className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
      <span className="sr-only">Pinned note: </span>
      <span className="line-clamp-2 min-w-0 break-words [overflow-wrap:anywhere]">{headline.text}</span>
    </p>
  );
}
