'use client';

import { useRef, useState } from 'react';
import Image from 'next/image';
import { Archive, GripVertical, MoreVertical, Refrigerator, ShoppingCart, Snowflake, Trash2, Edit, ArrowRightLeft, X, Minus, Plus, PackageX } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { TabDropdownMenu } from './tab-activity';
import type { PantryItemLocation } from '@/lib/types';
import { cn } from '@/lib/utils';
import { PANTRY_LOCATIONS, expiryLabelForDays, expiryStateForDays, pantryEmoji, type ExpiryState } from '@/lib/shopping/pantry';
import { batchAmountLabel, daysUntilDay, productSummary, type PantryBatch, type PantryProduct } from '@/lib/shopping/pantry-batches';
import { NumberTicker } from '@/components/motion/number-ticker';
import { Stagger, StaggerItem } from '@/components/motion/stagger';

const SHELF_ICON: Record<PantryItemLocation, LucideIcon> = { Pantry: Archive, Fridge: Refrigerator, Freezer: Snowflake };

const SHELF_SURFACE: Record<PantryItemLocation, string> = {
  Pantry: 'bg-card',
  Fridge: 'bg-card bg-gradient-to-b from-info/5 to-transparent',
  Freezer: 'bg-card bg-gradient-to-b from-info/10 to-transparent',
};

/** Expiry styling on the tile's visual layer (never on the clickable box). */
const EXPIRY_VISUAL: Record<ExpiryState, string> = {
  expired: 'opacity-60 -rotate-3 saturate-50',
  soon: 'ring-2 ring-warning/70 shadow-[0_0_18px_-4px_hsl(var(--warning)/0.65)]',
  fresh: '',
  none: '',
};

const DRAG_THRESHOLD = 6;

type DragState = { id: string; pointerId: number; startX: number; startY: number; moved: boolean };

export type PantryShelvesProps = {
  /** Products (a name's visible batches on one shelf), one tile each. */
  items: PantryProduct[];
  /** Product photos by product key (from the barcode library). */
  photos: Record<string, string | undefined>;
  /** Product keys lifted off the shelf by the last generated recipe. */
  liftedIds: ReadonlySet<string>;
  /** Today in the household zone; expiry states are counted from it (SH-10b). */
  today: string;
  timeZone?: string | null;
  canEdit: boolean;
  canDelete: boolean;
  onEdit: (batch: PantryBatch) => void;
  onDelete: (item: PantryProduct) => void;
  onMove: (item: PantryProduct, location: PantryItemLocation) => void;
  onAddToList?: (item: PantryProduct) => void;
  /** "Used one": one package from the soonest-expiring batch (SH-22a). */
  onUseOne: (item: PantryProduct) => void;
  /** "+1": one more package of the soonest batch. */
  onAddOne: (item: PantryProduct) => void;
  /** "Out of this": every package used up, then "Add to list?" (SH-29). */
  onOutOfThis: (item: PantryProduct) => void;
};

/**
 * The pantry as real shelves (H08): Pantry, Fridge and Freezer are shelves of
 * product tiles (a product photo from the barcode library, or a food emoji). A
 * tile groups a product's batches ("2 × 450 g · next Fri, 1 × 450 g") and has
 * one-tap "Used one" (−) and "One more" (+) buttons; its menu has Edit (per
 * batch), Move to, Put on a shopping list, Out of this and Delete. Expiry is
 * counted from the household's today. Items
 * expiring within three days glow amber, expired ones fade and tilt, freezer
 * tiles get a frost edge. Members who can edit move a tile to another shelf by
 * dragging its handle (mouse or touch), by keyboard (focus the handle, Space or
 * Enter to pick up, arrow keys to choose a shelf, Space or Enter to drop, Escape
 * to cancel), or by tapping the handle and then "Move here" on a shelf.
 */
export function PantryShelves({
  items, photos, liftedIds, today, timeZone, canEdit, canDelete, onEdit, onDelete, onMove, onAddToList, onUseOne, onAddOne, onOutOfThis,
}: PantryShelvesProps) {
  const [picked, setPicked] = useState<{ id: string; target: PantryItemLocation } | null>(null);
  const [ghost, setGhost] = useState<{ id: string; x: number; y: number } | null>(null);
  const [overShelf, setOverShelf] = useState<PantryItemLocation | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const dragRef = useRef<DragState | null>(null);
  const suppressClickRef = useRef(false);
  const byId = new Map(items.map((item) => [item.key, item]));
  const pickedItem = picked ? byId.get(picked.id) ?? null : null;
  const ghostItem = ghost ? byId.get(ghost.id) ?? null : null;

  const drop = (item: PantryProduct, location: PantryItemLocation) => {
    setPicked(null);
    if (location === item.location) {
      setAnnouncement(`${item.name} stays in the ${item.location}.`);
      return;
    }
    setAnnouncement(`${item.name} moved to the ${location}.`);
    onMove(item, location);
  };

  const pickUp = (item: PantryProduct) => {
    setPicked({ id: item.key, target: item.location });
    setAnnouncement(`Picked up ${item.name} from the ${item.location}. Use the arrow keys to choose a shelf, then press Enter to drop or Escape to cancel. You can also press Move here on a shelf.`);
  };

  const cancel = (item: PantryProduct) => {
    setPicked(null);
    setAnnouncement(`${item.name} put back in the ${item.location}.`);
  };

  const handleKeyDown = (event: React.KeyboardEvent, item: PantryProduct) => {
    if (!picked || picked.id !== item.key) return;
    const index = PANTRY_LOCATIONS.indexOf(picked.target);
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
      event.preventDefault();
      const target = PANTRY_LOCATIONS[(index + 1) % PANTRY_LOCATIONS.length];
      setPicked({ id: item.key, target });
      setAnnouncement(`Over the ${target}.`);
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
      event.preventDefault();
      const target = PANTRY_LOCATIONS[(index + PANTRY_LOCATIONS.length - 1) % PANTRY_LOCATIONS.length];
      setPicked({ id: item.key, target });
      setAnnouncement(`Over the ${target}.`);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      cancel(item);
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      drop(item, picked.target);
    }
  };

  const handleHandleClick = (item: PantryProduct) => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    if (picked?.id === item.key) drop(item, picked.target);
    else pickUp(item);
  };

  const onPointerDown = (event: React.PointerEvent, item: PantryProduct) => {
    if (event.button !== 0) return;
    dragRef.current = { id: item.key, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, moved: false };
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  };

  const onPointerMove = (event: React.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (!drag.moved && Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < DRAG_THRESHOLD) return;
    drag.moved = true;
    setGhost({ id: drag.id, x: event.clientX, y: event.clientY });
    const shelf = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>('[data-shelf]')?.dataset.shelf;
    setOverShelf((PANTRY_LOCATIONS as readonly string[]).includes(shelf ?? '') ? (shelf as PantryItemLocation) : null);
  };

  const endPointerDrag = (event: React.PointerEvent, commit: boolean) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    if (drag.moved) {
      suppressClickRef.current = true;
      const item = byId.get(drag.id);
      if (commit && item && overShelf) drop(item, overShelf);
    }
    setGhost(null);
    setOverShelf(null);
  };

  return (
    <div className="space-y-5" data-testid="pantry-shelves">
      <p className="sr-only" aria-live="polite">{announcement}</p>
      {PANTRY_LOCATIONS.map((location) => {
        const shelfItems = items.filter((item) => item.location === location);
        const Icon = SHELF_ICON[location];
        const isTarget = (picked && picked.target === location) || overShelf === location;
        const headingId = `shelf-heading-${location.toLowerCase()}`;
        return (
          <section
            key={location}
            data-shelf={location}
            aria-labelledby={headingId}
            className={cn(
              'relative rounded-2xl border p-4 shadow-raised transition-ui sm:p-5',
              SHELF_SURFACE[location],
              isTarget && 'border-primary ring-2 ring-primary/40',
            )}
          >
            <div className="mb-3 flex items-center justify-between gap-3">
              <h3 id={headingId} className="flex items-center gap-2 font-headline text-lg font-semibold">
                <Icon className={cn('h-5 w-5', location === 'Pantry' ? 'text-primary' : 'text-info')} aria-hidden />
                {location}
                <span className="text-sm font-normal text-muted-foreground"><NumberTicker value={shelfItems.length} animateOnMount={false} /> {shelfItems.length === 1 ? 'item' : 'items'}</span>
              </h3>
              {pickedItem && (
                pickedItem.location === location ? (
                  <Button size="sm" variant="ghost" onClick={() => cancel(pickedItem)}>
                    <X className="mr-1 h-4 w-4" aria-hidden /> Cancel move
                  </Button>
                ) : (
                  <Button size="sm" variant={picked?.target === location ? 'default' : 'outline'} onClick={() => drop(pickedItem, location)}>
                    Move here
                  </Button>
                )
              )}
            </div>

            {shelfItems.length === 0 ? (
              <p className="rounded-lg border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
                Nothing in the {location.toLowerCase()} yet.
              </p>
            ) : (
              <Stagger as="ul" count={shelfItems.length} className="grid grid-cols-2 gap-3 min-[420px]:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
                {shelfItems.map((item) => {
                  const days = daysUntilDay(item.nextExpiry, today, timeZone);
                  const state = expiryStateForDays(days);
                  const label = expiryLabelForDays(days);
                  const summary = productSummary(item, today);
                  const photo = photos[item.key];
                  const lifted = liftedIds.has(item.key);
                  const isPicked = picked?.id === item.key || ghost?.id === item.key;
                  return (
                    <StaggerItem as="li" key={item.key} data-expiry={state} data-lifted={lifted ? 'true' : undefined}>
                      {/* A recipe lifts the tile off the shelf (H08): the card and its picture rise, the controls' hit areas stay put. */}
                      <div className="relative">
                      {/* Visual layer: tilt, glow and frost change only this, never the controls. */}
                      <div
                        aria-hidden
                        className={cn(
                          'pointer-events-none absolute inset-0 rounded-xl border bg-background transition-[transform,box-shadow,opacity,border-color] duration-200 ease-out',
                          location === 'Freezer' && 'shadow-[inset_0_0_0_2px_hsl(var(--info)/0.35),inset_0_6px_10px_-6px_hsl(var(--info)/0.6)]',
                          EXPIRY_VISUAL[state],
                          lifted && '-translate-y-2 shadow-overlay ring-2 ring-primary',
                          isPicked && 'opacity-40',
                        )}
                      />
                      <div className="relative flex min-h-[9.5rem] flex-col items-center gap-1 p-3 text-center">
                        <button
                          type="button"
                          className="flex w-full flex-1 flex-col items-center gap-1 rounded-lg disabled:cursor-default"
                          onClick={() => canEdit && onEdit(item.batches[0])}
                          disabled={!canEdit}
                          aria-label={`${item.name}, ${summary}${label ? `, ${label}` : ''}${lifted ? ', used in the recipe' : ''}${canEdit ? '. Edit' : ''}`}
                        >
                          <span className={cn('flex h-14 w-14 items-center justify-center overflow-hidden rounded-lg text-4xl transition-transform duration-200 ease-out', state === 'expired' && 'opacity-60', lifted && '-translate-y-2')} aria-hidden>
                            {photo ? (
                              <Image src={photo} alt="" width={56} height={56} unoptimized className="h-14 w-14 object-cover" />
                            ) : (
                              pantryEmoji(item.name, item.location)
                            )}
                          </span>
                          <span className="line-clamp-2 break-words text-sm font-medium leading-tight">{item.name}</span>
                          <span className="text-xs text-muted-foreground" data-testid="pantry-tile-summary">{summary}</span>
                        </button>
                        {(label || lifted) && (
                          <span
                            className={cn(
                              'rounded-full px-2 py-0.5 text-[11px] font-medium',
                              lifted ? 'bg-primary/15 text-primary'
                                : state === 'expired' ? 'bg-destructive/15 text-destructive'
                                  : state === 'soon' ? 'bg-warning/15 text-warning' : 'text-muted-foreground',
                            )}
                          >
                            {lifted ? 'In the recipe' : label}
                          </span>
                        )}
                        {canEdit && (
                          <div className="mt-1 flex items-center gap-1">
                            <Button variant="outline" size="icon" className="h-9 w-9" aria-label={`Used one ${item.name}`} onClick={() => onUseOne(item)}>
                              <Minus className="h-4 w-4" aria-hidden />
                            </Button>
                            <Button variant="outline" size="icon" className="h-9 w-9" aria-label={`One more ${item.name}`} onClick={() => onAddOne(item)}>
                              <Plus className="h-4 w-4" aria-hidden />
                            </Button>
                          </div>
                        )}
                        {(canEdit || canDelete) && (
                          <div className="absolute right-1 top-1 flex flex-col">
                            <TabDropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <Button variant="ghost" size="icon" className="h-7 w-7" aria-label={`More actions for ${item.name}`}>
                                  <MoreVertical className="h-4 w-4" aria-hidden />
                                </Button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="end">
                                {canEdit && (item.batches.length === 1 ? (
                                  <DropdownMenuItem onClick={() => onEdit(item.batches[0])}><Edit className="mr-2 h-4 w-4" aria-hidden /> Edit</DropdownMenuItem>
                                ) : item.batches.map((batch) => (
                                  <DropdownMenuItem key={batch.id} onClick={() => onEdit(batch)}>
                                    <Edit className="mr-2 h-4 w-4" aria-hidden /> Edit {batchAmountLabel(batch)}{batch.expiryDate ? ` (${batch.expiryDate})` : ''}
                                  </DropdownMenuItem>
                                )))}
                                {canEdit && (
                                  <DropdownMenuItem onClick={() => onOutOfThis(item)}><PackageX className="mr-2 h-4 w-4" aria-hidden /> Out of this</DropdownMenuItem>
                                )}
                                {canEdit && (
                                  <>
                                    <DropdownMenuLabel className="text-xs text-muted-foreground">Move to</DropdownMenuLabel>
                                    {PANTRY_LOCATIONS.filter((target) => target !== item.location).map((target) => (
                                      <DropdownMenuItem key={target} onClick={() => drop(item, target)}>
                                        <ArrowRightLeft className="mr-2 h-4 w-4" aria-hidden /> {target}
                                      </DropdownMenuItem>
                                    ))}
                                  </>
                                )}
                                {onAddToList && canEdit && (
                                  <DropdownMenuItem onClick={() => onAddToList(item)}><ShoppingCart className="mr-2 h-4 w-4" aria-hidden /> Put on a shopping list</DropdownMenuItem>
                                )}
                                {canDelete && (
                                  <>
                                    <DropdownMenuSeparator />
                                    <DropdownMenuItem className="text-destructive" onClick={() => onDelete(item)}><Trash2 className="mr-2 h-4 w-4" aria-hidden /> Delete</DropdownMenuItem>
                                  </>
                                )}
                              </DropdownMenuContent>
                            </TabDropdownMenu>
                            {canEdit && (
                              <Button
                                variant={picked?.id === item.key ? 'secondary' : 'ghost'}
                                size="icon"
                                className="h-7 w-7 cursor-grab touch-none active:cursor-grabbing"
                                aria-label={`Move ${item.name}`}
                                aria-pressed={picked?.id === item.key}
                                onClick={() => handleHandleClick(item)}
                                onKeyDown={(event) => handleKeyDown(event, item)}
                                onPointerDown={(event) => onPointerDown(event, item)}
                                onPointerMove={onPointerMove}
                                onPointerUp={(event) => endPointerDrag(event, true)}
                                onPointerCancel={(event) => endPointerDrag(event, false)}
                              >
                                <GripVertical className="h-4 w-4" aria-hidden />
                              </Button>
                            )}
                          </div>
                        )}
                      </div>
                      </div>
                    </StaggerItem>
                  );
                })}
              </Stagger>
            )}
            {/* The shelf board the tiles stand on. */}
            <div aria-hidden className="mt-3 h-2 rounded-full bg-secondary shadow-raised" />
          </section>
        );
      })}

      {ghost && ghostItem && (
        <div
          aria-hidden
          className="pointer-events-none fixed left-0 top-0 z-[90] flex items-center gap-2 rounded-xl border bg-popover px-3 py-2 text-sm font-medium shadow-overlay"
          style={{ transform: `translate(${ghost.x + 12}px, ${ghost.y + 12}px)` }}
        >
          <span className="text-2xl">{photos[ghostItem.key] ? '📦' : pantryEmoji(ghostItem.name, ghostItem.location)}</span>
          {ghostItem.name}
        </div>
      )}
    </div>
  );
}
