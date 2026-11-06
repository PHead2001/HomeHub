'use client';

import { Edit, MoreVertical, Trash2 } from 'lucide-react';
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
 * and a trip progress bar. Edit/Delete appear only for members who may do them.
 */
export function ListCard({
  list,
  counts,
  onSelect,
  onEdit,
  onDelete,
}: {
  list: ShoppingList;
  counts?: ListCounts;
  onSelect: () => void;
  onEdit?: () => void;
  onDelete?: () => void;
}) {
  const tint = listTint(list);
  const total = counts ? counts.needed + counts.purchased : 0;
  const progress = counts && total > 0 ? Math.round((counts.purchased / total) * 100) : 0;
  const summary = !counts
    ? null
    : total === 0
      ? 'Empty'
      : counts.needed === 0
        ? `All ${pluralize(counts.purchased, 'item')} in the cart`
        : `${counts.needed} to buy${counts.purchased > 0 ? ` · ${counts.purchased} in the cart` : ''}`;

  return (
    <div className="glow-card flex flex-col justify-between gap-4 rounded-xl border bg-card p-5 text-card-foreground shadow-raised">
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
              <Button variant="ghost" size="icon" aria-label={`Open actions for ${list.name}`} className="h-8 w-8 shrink-0">
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

      <Button className="w-full" aria-label={`Open ${list.name}`} onClick={onSelect}>Open List</Button>
    </div>
  );
}
