'use client';

import { Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { UsualSuggestion } from '@/lib/shopping/trip-plan';

/**
 * Usuals due (SH-32b): one chip per usual the household buys on a rhythm and
 * is due about now ("Milk · every ~6 days"), above the quick-add field. A tap
 * adds it to the open list through the same save path as quick add.
 */
export function UsualChips({ suggestions, onAdd }: { suggestions: UsualSuggestion[]; onAdd: (name: string) => void }) {
  if (suggestions.length === 0) return null;
  return (
    <div role="group" aria-label="Usuals due" className="flex flex-wrap gap-1.5 px-1" data-testid="usual-chips">
      {suggestions.map((suggestion) => (
        <Button
          key={suggestion.key}
          type="button"
          variant="outline"
          size="sm"
          className="h-11 rounded-full bg-popover px-3 text-xs shadow-raised [@media(pointer:coarse)]:h-12"
          onClick={() => onAdd(suggestion.name)}
        >
          <Plus className="mr-1 h-3.5 w-3.5" aria-hidden />
          {suggestion.label}
        </Button>
      ))}
    </div>
  );
}
