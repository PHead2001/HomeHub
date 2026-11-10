'use client';

import type { CSSProperties, MouseEvent } from 'react';
import { Edit, MoreVertical, Trash2 } from 'lucide-react';
import { PeekCard } from '@/components/dashboard/peek-card';
import { NumberTicker } from '@/components/motion/number-ticker';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import type { ShoppingList } from '@/lib/types';
import { cn } from '@/lib/utils';
import { listTint } from '@/lib/shopping/list-style';
import { pluralize } from '@/lib/shopping/items';
import { renderListIcon } from './list-icons';

export type ListCounts = { needed: number; purchased: number };

/**
 * One list on the Shopping Lists overview: tinted icon, name, what is left to buy
 * (live tickers) and a trip progress bar. Edit/Delete appear only for members who
 * may do them. Open List has a peek card (H26) and morphs into the open list
 * (H12) through `style` (the shared-element name, set only while morphing).
 */
export function ListCard({
  list,
  counts,
  onSelect,
  onEdit,
  onDelete,
  style,
}: {
  list: ShoppingList;
  counts?: ListCounts;
  onSelect: (event: MouseEvent<HTMLButtonElement>) => void;
  onEdit?: () => void;
  onDelete?: () => void;
  style?: CSSProperties;
}) {
  const tint = listTint(list);
  const total = counts ? counts.needed + counts.purchased : 0;
  const progress = counts && total > 0 ? Math.round((counts.purchased / total) * 100) : 0;
  const summary = !counts
    ? null
    : total === 0
      ? 'Empty'
      : counts.needed === 0
        ? <>All <NumberTicker value={counts.purchased} animateOnMount={false} /> {counts.purchased === 1 ? 'item' : 'items'} in the cart</>
        : (
          <>
            <NumberTicker value={counts.needed} animateOnMount={false} /> to buy
            {counts.purchased > 0 && <> · <NumberTicker value={counts.purchased} animateOnMount={false} /> in the cart</>}
          </>
        );
  const peek = (
    <div className="space-y-1">
      <p className="font-headline font-semibold">{list.name}</p>
      <p className="text-muted-foreground">{list.type} list</p>
      {counts && (
        <p className="text-xs text-muted-foreground">
          {total === 0 ? 'No items yet' : `${pluralize(counts.needed, 'item')} to buy · ${counts.purchased} in the cart · ${progress}% done`}
        </p>
      )}
      {list.description && <p className="line-clamp-2 text-xs text-muted-foreground">{list.description}</p>}
    </div>
  );

  return (
    <div style={style} data-testid={`list-card-${list.id}`} className="glow-card flex h-full flex-col justify-between gap-4 rounded-xl border bg-card p-5 text-card-foreground shadow-raised">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <span className={cn('flex h-11 w-11 shrink-0 items-center justify-center rounded-xl', tint.classes.softChip)}>
            {renderListIcon(list, { className: 'h-6 w-6' })}
          </span>
          <div className="min-w-0">
            <h2 className="break-words font-headline text-lg font-semibold leading-tight">{list.name}</h2>
            {list.description && <p className="mt-0.5 line-clamp-2 text-sm text-muted-foreground">{list.description}</p>}
          </div>
        </div>
        {(onEdit || onDelete) && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" aria-label={`Open actions for ${list.name}`} className="h-11 w-11 shrink-0 [@media(pointer:coarse)]:h-12 [@media(pointer:coarse)]:w-12">
                <MoreVertical aria-hidden />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {onEdit && <DropdownMenuItem onClick={onEdit}><Edit className="mr-2" aria-hidden /> Edit</DropdownMenuItem>}
              {onDelete && <DropdownMenuItem onClick={onDelete} className="text-destructive"><Trash2 className="mr-2" aria-hidden /> Delete</DropdownMenuItem>}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>

      <div className="space-y-2">
        {/* Fixed height so the card does not grow when counts arrive. */}
        <p className="h-5 text-sm text-muted-foreground">{summary}</p>
        <div
          className="h-1.5 overflow-hidden rounded-full bg-muted"
          role="progressbar"
          aria-label={`${list.name} trip progress`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={progress}
        >
          <div className={cn('h-full rounded-full transition-[width] duration-500 ease-out', tint.classes.bg)} style={{ width: `${progress}%` }} />
        </div>
      </div>

      <PeekCard peek={peek}>
        <Button className="w-full" aria-label={`Open List: ${list.name}`} onClick={onSelect}>Open List</Button>
      </PeekCard>
    </div>
  );
}
