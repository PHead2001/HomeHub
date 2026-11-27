'use client';

import { createContext, useContext } from 'react';
import { lookupIds } from '@/lib/barcode/gtin';
import { nutritionChips, type NutritionChip } from '@/lib/barcode/nutrition';
import type { LibraryPhoto } from '@/lib/barcode/use-library-photos';
import { cn } from '@/lib/utils';

/** The household library on this device, for rows that show a product's chips (BL-22). */
export const LibraryFactsContext = createContext<ReadonlyMap<string, LibraryPhoto> | null>(null);

/** The chips for a stored barcode (either form), from the library in context. */
export function useBarcodeChips(barcode: string | null | undefined): NutritionChip[] {
  const library = useContext(LibraryFactsContext);
  if (!library || !barcode) return [];
  for (const id of lookupIds(barcode)) {
    const entry = library.get(id);
    if (entry) return nutritionChips(entry);
  }
  return [];
}

const TONE: Record<string, string> = {
  a: 'border-success/40 text-success',
  b: 'border-success/30 text-success',
  c: 'border-warning/60 text-foreground',
  d: 'border-warning text-foreground',
  e: 'border-destructive/40 text-destructive',
};

export function NutritionChips({ chips, className }: { chips: readonly NutritionChip[]; className?: string }) {
  if (chips.length === 0) return null;
  return (
    <span className={cn('flex flex-wrap gap-1', className)} data-testid="nutrition-chips">
      {chips.map((chip) => (
        <span
          key={chip.kind}
          className={cn('rounded-full border px-2 py-0.5 text-xs leading-tight', chip.tone ? TONE[chip.tone] : 'border-border text-muted-foreground')}
        >
          {chip.label}
        </span>
      ))}
    </span>
  );
}
