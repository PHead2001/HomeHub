'use client';

import { formatPackageSize } from '@/lib/shopping/scan';
import { forwardRef, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react';
import Image from 'next/image';
import { motion, useMotionValue, useTransform, type PanInfo } from 'motion/react';
import { Check, ChevronRight, ExternalLink } from 'lucide-react';
import { PeekCard } from '@/components/dashboard/peek-card';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import type { ShoppingListItem } from '@/lib/types';
import { normalizeSourceUrl } from '@/lib/shopping-items';
import { cn } from '@/lib/utils';
import { DURATION, EASE } from '@/lib/motion';

/** Distance (px) a phone swipe must travel to tick an item. */
const SWIPE_TICK_DISTANCE = 72;
/** A touch held this long (ms) without moving opens the edit sheet (SH-8b). */
const LONG_PRESS_MS = 500;
/** Movement (px) that turns a press into a swipe or scroll. */
const LONG_PRESS_SLOP = 10;

function ItemSourceLink({ item }: { item: ShoppingListItem }) {
  // Re-validate on render: stored data is not trusted to be http(s).
  const href = normalizeSourceUrl(item.sourceUrl);
  if (!href) return null;
  // Peek (H26): what the link is before it opens a new tab.
  const peek = (
    <div className="space-y-1">
      <p className="font-headline font-semibold">{item.name}</p>
      <p className="text-muted-foreground">{[`x${item.quantity}`, item.category].filter(Boolean).join(' · ')}</p>
      <p className="truncate text-xs text-muted-foreground">Opens {hostOf(href)}</p>
    </div>
  );
  return (
    <PeekCard peek={peek} className="shrink-0">
      <Button asChild variant="ghost" size="icon" className="h-11 w-11 shrink-0 [@media(pointer:coarse)]:h-12 [@media(pointer:coarse)]:w-12">
        <a href={href} target="_blank" rel="noopener noreferrer" aria-label={`Open saved link for ${item.name}`}>
          <ExternalLink className="h-4 w-4 text-muted-foreground" aria-hidden />
        </a>
      </Button>
    </PeekCard>
  );
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
  /** The row ticks (members with `shopping.edit`). */
  canToggle: boolean;
  /** Shows the trailing Edit control and long-press (members who can edit or delete). */
  canOpenEditor: boolean;
  onToggle: (item: ShoppingListItem) => void;
  onEdit: (item: ShoppingListItem) => void;
  /** "Sam added · 2d" (SH-28b), or null. */
  attribution?: string | null;
  /** Seconds: set on the rows of a freshly opened list for the staggered entrance (H12). */
  enterDelay?: number;
};

/**
 * One item row (S3, SH-13a/b, SH-8b). The whole row is the tick target: a label
 * for the 24 px circle that is at least 44 px tall (48 px on touch), so tapping the
 * name, the attribution or the empty space ticks. On touch the row can also be
 * swiped right to tick (it follows the finger over a green "In the cart" strip; the
 * circle stays put). Editing is a separate control: the trailing 48 px "Edit
 * {item}" button, or a long-press on touch; Delete lives in the edit sheet, so
 * there is no bare trash button beside each row. Leaving the Needed list draws a
 * strike-through across the name before the row fades; purchased rows drop in
 * from above. Reduced motion shows every end state at once (MotionConfig).
 */
export const ShoppingItemRow = forwardRef<HTMLDivElement, RowProps>(function ShoppingItemRow(
  { item, canToggle, canOpenEditor, onToggle, onEdit, attribution, enterDelay },
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

  // Long-press on touch opens the editor; the click that ends it must not tick.
  const pressRef = useRef<{ timer: number; x: number; y: number } | null>(null);
  const longPressedRef = useRef(false);
  const clearPress = () => {
    if (pressRef.current) window.clearTimeout(pressRef.current.timer);
    pressRef.current = null;
  };
  useEffect(() => () => {
    if (pressRef.current) window.clearTimeout(pressRef.current.timer);
  }, []);
  const onPointerDown = (event: ReactPointerEvent) => {
    longPressedRef.current = false;
    if (!canOpenEditor || event.pointerType === 'mouse') return;
    clearPress();
    const timer = window.setTimeout(() => {
      pressRef.current = null;
      longPressedRef.current = true;
      onEdit(item);
    }, LONG_PRESS_MS);
    pressRef.current = { timer, x: event.clientX, y: event.clientY };
  };
  const onPointerMove = (event: ReactPointerEvent) => {
    const press = pressRef.current;
    if (press && Math.hypot(event.clientX - press.x, event.clientY - press.y) > LONG_PRESS_SLOP) clearPress();
  };
  const swallowLongPressClick = (event: ReactMouseEvent) => {
    if (!longPressedRef.current) return;
    longPressedRef.current = false;
    event.preventDefault();
    event.stopPropagation();
  };

  // A scanned package size is a note, never the count (BL-1).
  const packageNote = formatPackageSize(item.size, item.sizeUnit);
  const text = (
    <span className="min-w-0 text-left">
      <span className="relative block break-words text-sm font-medium leading-snug">
        <span data-item-name className={cn(purchased && 'text-muted-foreground line-through')}>{item.name}</span>{' '}
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
      {attribution && <span className="block text-xs text-muted-foreground" data-testid="item-attribution">{attribution}</span>}
    </span>
  );
  const image = item.imageUrl && (
    <Image
      src={item.imageUrl}
      alt=""
      width={40}
      height={40}
      sizes="40px"
      className={cn('h-10 w-10 shrink-0 rounded-md object-cover', purchased && 'opacity-50')}
    />
  );
  const rowTarget = 'flex min-h-11 min-w-0 flex-1 items-center gap-3 px-2 py-1.5 [@media(pointer:coarse)]:min-h-12';

  return (
    <motion.div
      ref={ref}
      layout="position"
      initial={enterDelay !== undefined ? { opacity: 0, y: 6 } : purchased ? { opacity: 0, y: -8 } : false}
      animate={{ opacity: 1, y: 0, transition: { duration: DURATION.ui, ease: EASE.standard, delay: enterDelay ?? 0 } }}
      exit={{ opacity: 0, pointerEvents: 'none', transition: { duration: 0.12, delay: DURATION.micro, ease: EASE.exit } }}
      className="relative overflow-hidden rounded-md"
      data-testid={`shopping-item-${item.id}`}
      data-row-id={item.id}
      data-row-section={purchased ? 'purchased' : 'needed'}
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
        onDragStart={clearPress}
        onDragEnd={swipeEnabled ? handleDragEnd : undefined}
        className="relative flex items-center gap-1 rounded-md bg-card transition-colors hover:bg-secondary"
      >
        {canToggle ? (
          <label
            htmlFor={checkboxId}
            className={cn(rowTarget, 'cursor-pointer select-none')}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={clearPress}
            onPointerCancel={clearPress}
            onPointerLeave={clearPress}
            onClickCapture={swallowLongPressClick}
            onContextMenu={(event) => { if (coarse && canOpenEditor) event.preventDefault(); }}
          >
            {/* The visual circle is 24 px; the whole row (this label) is the target. */}
            <Checkbox
              id={checkboxId}
              checked={purchased}
              onCheckedChange={() => onToggle(item)}
              className="h-6 w-6 rounded-full"
            />
            {image}
            {text}
          </label>
        ) : (
          <span className={rowTarget}>
            <span
              className={cn('flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-border', purchased && 'border-primary bg-primary text-primary-foreground')}
              aria-hidden
            >
              {purchased && <Check className="h-4 w-4" />}
            </span>
            {image}
            {text}
          </span>
        )}
        <ItemSourceLink item={item} />
        {canOpenEditor && (
          <Button
            variant="ghost"
            size="icon"
            aria-label={`Edit ${item.name}`}
            aria-haspopup="dialog"
            className="h-11 w-11 shrink-0 [@media(pointer:coarse)]:h-12 [@media(pointer:coarse)]:w-12"
            onClick={() => onEdit(item)}
          >
            <ChevronRight className="h-5 w-5 text-muted-foreground" aria-hidden />
          </Button>
        )}
      </motion.div>
    </motion.div>
  );
});
