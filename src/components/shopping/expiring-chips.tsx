'use client';

import { useMemo } from 'react';
import { Clock } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/hooks/use-auth';
import { useHouseholdToday } from '@/lib/shopping/use-household-today';
import { expiringChips } from '@/lib/shopping/overview';
import { cn } from '@/lib/utils';

/**
 * The pantry's expiring-soon items on the Shopping overview (SH-11c): one chip
 * per product whose soonest batch with packages left expired or expires within
 * three days of the household's today ("Greek yogurt · tomorrow"), soonest first.
 * A chip opens the Pantry Inventory tab on that batch (`expiringChips`).
 */
export function ExpiringChips({
  items,
  onOpenItem,
  onOpenPantry,
}: {
  /** The pantry documents (Pantry v2 batches, legacy documents too). */
  items: readonly { id: string }[];
  onOpenItem: (itemId: string) => void;
  onOpenPantry: () => void;
}) {
  const { household } = useAuth();
  // The household's day, rolling over at its midnight (an always-on tablet).
  const timeZone = household?.timeZone ?? null;
  const today = useHouseholdToday(timeZone);
  const { chips, more } = useMemo(
    () => expiringChips(items as readonly ({ id: string } & Record<string, unknown>)[], today, { timeZone }),
    [items, today, timeZone],
  );
  if (chips.length === 0) return null;

  return (
    <section aria-labelledby="expiring-heading" data-testid="expiring-chips" className="min-w-0 rounded-xl border bg-card p-4 text-card-foreground shadow-raised">
      <h2 id="expiring-heading" className="mb-2 flex items-center gap-2 font-headline text-base font-semibold">
        <Clock className="h-4 w-4 text-warning" aria-hidden /> Use soon
      </h2>
      <ul className="flex flex-wrap gap-2">
        {chips.map((chip) => (
          <li key={chip.id} className="min-w-0 max-w-full">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenItem(chip.id)}
              aria-label={`${chip.name}, ${chip.days < 0 ? 'expired' : `expires ${chip.when}`}. Open in the pantry`}
              className={cn(
                'h-auto min-h-11 max-w-full justify-start whitespace-normal rounded-full px-3 py-1.5 text-left text-sm coarse:min-h-12',
                chip.days < 0 ? 'border-destructive/50' : chip.days === 0 ? 'border-warning/60' : undefined,
              )}
            >
              <span className="min-w-0 break-words font-medium">{chip.name}</span>
              <span className={cn('shrink-0', chip.days < 0 ? 'text-destructive' : 'text-muted-foreground')}>· {chip.when}</span>
            </Button>
          </li>
        ))}
        {more > 0 && (
          <li>
            <Button type="button" variant="ghost" onClick={onOpenPantry} className="min-h-11 rounded-full px-3 text-sm coarse:min-h-12">
              {more} more in the pantry
            </Button>
          </li>
        )}
      </ul>
    </section>
  );
}
