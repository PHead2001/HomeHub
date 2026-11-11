'use client';

import { formatPackageSize } from '@/lib/shopping/scan';
import { forwardRef, useEffect, useState } from 'react';
import Image from 'next/image';
import { motion, useMotionValue, useTransform, type PanInfo } from 'motion/react';
import { Check, ExternalLink, Trash2 } from 'lucide-react';
import { PeekCard } from '@/components/dashboard/peek-card';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import type { ShoppingListItem } from '@/lib/types';
import { normalizeSourceUrl } from '@/lib/shopping-items';
import { cn } from '@/lib/utils';
import { DURATION, EASE } from '@/lib/motion';
import { useTabActive } from './tab-activity';

/** Distance (px) a phone swipe must travel to tick an item. */
const SWIPE_TICK_DISTANCE = 72;

function ItemSourceLink({ item }: { item: ShoppingListItem }) {
  // Re-validate on render: stored data is not trusted to be http(s).
  const href = normalizeSourceUrl(item.sourceUrl);
  // No peek card (a portal) while the tab is hidden.
  const tabActive = useTabActive();
  if (!href) return null;
  // Peek (H26): what the link is before it opens a new tab.
  const peek = (
    <div className="space-y-1">
      <p className="font-headline font-semibold">{item.name}</p>
      <p className="text-muted-foreground">{[`x${item.quantity}`, item.category].filter(Boolean).join(' · ')}</p>
      <p className="truncate text-xs text-muted-foreground">Opens {hostOf(href)}</p>
    </div>
  );
  const link = (
    <Button asChild variant="ghost" size="icon" className="h-8 w-8 shrink-0">
      <a href={href} target="_blank" rel="noopener noreferrer" aria-label={`Open saved link for ${item.name}`}>
        <ExternalLink className="h-4 w-4 text-muted-foreground" aria-hidden />
      </a>
    </Button>
  );
  return tabActive ? <PeekCard peek={peek} className="shrink-0">{link}</PeekCard> : link;
}

const hostOf = (href: string) => {
  try {
    return new URL(href).hostname.replace(/^www\./, '');
  } catch {
    return 'the saved link';
  }
};

/** True on touch-first devices, where rows can be swiped. */
function useCoarsePointer() {
  const [coarse, setCoarse] = useState(false);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia('(pointer: coarse)');
    const update = () => setCoarse(query.matches);
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  return coarse;
}

type RowProps = {
  item: ShoppingListItem;
  /** Shows the tick checkbox (members with `shopping.edit`). */
  canToggle: boolean;
  /** Shows the delete button (members with `shopping.delete`). */
  canDelete: boolean;
  onToggle: (item: ShoppingListItem) => void;
  onDelete: (item: ShoppingListItem) => void;
  /** Seconds: set on the rows of a freshly opened list for the staggered entrance (H12). */
  enterDelay?: number;
};

/**
 * One item row. Needed rows tick by checkbox anywhere, and by swiping right on
 * touch devices (the row follows the finger and a green "In the cart" strip shows
 * underneath; the checkbox stays put). Leaving the Needed list draws a
 * strike-through across the name before the row fades. Purchased rows drop in
 * from above. Reduced motion shows every end state at once (MotionConfig).
 */
export const ShoppingItemRow = forwardRef<HTMLDivElement, RowProps>(function ShoppingItemRow(
  { item, canToggle, canDelete, onToggle, onDelete, enterDelay },
  ref,
) {
  const purchased = item.status === 'purchased';
  const checkboxId = `item-${purchased ? 'purchased' : 'needed'}-${item.id}`;
  const coarse = useCoarsePointer();
  const swipeEnabled = coarse && canToggle && !purchased;
  const x = useMotionValue(0);
  const revealOpacity = useTransform(x, [0, SWIPE_TICK_DISTANCE], [0, 1]);

  const handleDragEnd = (_event: unknown, info: PanInfo) => {
    if (info.offset.x >= SWIPE_TICK_DISTANCE) onToggle(item);
  };

  // A scanned package size is a note, never the count (BL-1).
  const packageNote = formatPackageSize(item.size, item.sizeUnit);
  const label = (
    <span className="relative min-w-0 break-words text-sm font-medium leading-snug">
      <span className={cn(purchased && 'text-muted-foreground line-through')}>{item.name}</span>{' '}
      <span className="text-muted-foreground">(x{item.quantity})</span>
      {packageNote && <span className="text-muted-foreground"> · {packageNote}</span>}
      {!purchased && (
        // The strike-through that draws across when the item is ticked (exit only).
        <motion.span
          aria-hidden
          className="pointer-events-none absolute left-0 top-1/2 h-0.5 w-full origin-left rounded-full bg-foreground/70"
          initial={{ scaleX: 0 }}
          animate={{ scaleX: 0 }}
          exit={{ scaleX: 1, transition: { duration: DURATION.micro, ease: EASE.standard } }}
        />
      )}
    </span>
  );

  return (
    <motion.div
      ref={ref}
      layout="position"
      initial={enterDelay !== undefined ? { opacity: 0, y: 6 } : purchased ? { opacity: 0, y: -8 } : false}
      animate={{ opacity: 1, y: 0, transition: { duration: DURATION.ui, ease: EASE.standard, delay: enterDelay ?? 0 } }}
      exit={{ opacity: 0, pointerEvents: 'none', transition: { duration: 0.12, delay: DURATION.micro, ease: EASE.exit } }}
      className="relative overflow-hidden rounded-md"
      data-testid={`shopping-item-${item.id}`}
    >
      {swipeEnabled && (
        <motion.div
          aria-hidden
          style={{ opacity: revealOpacity }}
          className="absolute inset-0 flex items-center gap-2 rounded-md bg-success/15 pl-3 text-sm font-medium text-success"
        >
          <Check className="h-4 w-4" /> In the cart
        </motion.div>
      )}
      <motion.div
        style={swipeEnabled ? { x } : undefined}
        drag={swipeEnabled ? 'x' : false}
        dragDirectionLock
        dragConstraints={{ left: 0, right: 0 }}
        dragElastic={{ left: 0, right: 0.7 }}
        dragSnapToOrigin
        onDragEnd={swipeEnabled ? handleDragEnd : undefined}
        className="relative flex items-center justify-between gap-2 rounded-md bg-card p-2 transition-colors hover:bg-secondary"
      >
        <div className="flex min-w-0 items-center gap-3">
          {canToggle ? (
            <Checkbox id={checkboxId} checked={purchased} onCheckedChange={() => onToggle(item)} className="shrink-0" />
          ) : (
            <span
              className={cn('flex h-4 w-4 shrink-0 items-center justify-center rounded-sm border border-border', purchased && 'border-primary bg-primary text-primary-foreground')}
              aria-hidden
            >
              {purchased && <Check className="h-3 w-3" />}
            </span>
          )}
          {item.imageUrl && (
            <Image
              src={item.imageUrl}
              alt=""
              width={40}
              height={40}
              sizes="40px"
              className={cn('h-10 w-10 shrink-0 rounded-md object-cover', purchased && 'opacity-50')}
            />
          )}
          {canToggle ? <label htmlFor={checkboxId} className="min-w-0 cursor-pointer">{label}</label> : <span className="min-w-0">{label}</span>}
          <ItemSourceLink item={item} />
        </div>
        {canDelete && (
          <Button variant="ghost" size="icon" aria-label={`Delete ${item.name}`} className="h-8 w-8 shrink-0" onClick={() => onDelete(item)}>
            <Trash2 className="h-4 w-4 text-muted-foreground" aria-hidden />
          </Button>
        )}
      </motion.div>
    </motion.div>
  );
});
