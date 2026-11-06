'use client';

import { useEffect } from 'react';
import { format } from 'date-fns';
import { motion, useAnimationControls } from 'motion/react';
import { ArchiveX, Archive } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import type { ShoppingListItem } from '@/lib/types';
import { useReducedMotion } from '@/hooks/use-reduced-motion';
import { pluralize } from '@/lib/shopping/items';

/** How long the receipt takes to print (celebration budget: ≤ 1.5 s, skippable). */
const PRINT_SECONDS = 0.9;

/**
 * "Trip complete" (H07): when the last needed item is ticked, a receipt prints
 * out of a slot summarising the trip. Any key or pointer press finishes the print
 * at once; reduced motion shows the printed receipt immediately. The receipt is
 * always in the DOM, so screen readers get it straight away.
 */
export function TripReceiptDialog({
  open,
  onOpenChange,
  listName,
  items,
  onSendToPantry,
  onClearPurchased,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  listName: string;
  items: ShoppingListItem[];
  /** Offered for Grocery lists to members who can edit, while online. */
  onSendToPantry?: () => void;
  /** Offered to members who can delete. */
  onClearPurchased?: () => void;
}) {
  const controls = useAnimationControls();
  const reduced = useReducedMotion();
  const totalUnits = items.reduce((sum, item) => sum + (Number(item.quantity) || 0), 0);
  const sorted = [...items].sort((a, b) => a.name.localeCompare(b.name));

  useEffect(() => {
    if (!open) return;
    if (reduced) {
      controls.set({ y: '0%' });
      return;
    }
    void controls.start({ y: '0%', transition: { duration: PRINT_SECONDS, ease: [0.3, 0, 0.2, 1] } });
  }, [open, reduced, controls]);

  const finishPrint = () => {
    controls.stop();
    controls.set({ y: '0%' });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm" onPointerDownCapture={finishPrint} onKeyDownCapture={finishPrint}>
        <DialogHeader>
          <DialogTitle className="font-headline">Trip complete</DialogTitle>
          <DialogDescription>Everything on {listName} is in the cart.</DialogDescription>
        </DialogHeader>

        <div className="relative">
          {/* The printer slot. */}
          <div aria-hidden className="relative z-10 h-3 rounded-full border bg-muted shadow-raised" />
          <div className="-mt-1.5 overflow-hidden px-3 pb-1">
            <motion.div
              animate={controls}
              initial={{ y: reduced ? '0%' : '-100%' }}
              className="max-h-[45vh] overflow-y-auto rounded-b-md border border-t-0 bg-popover px-4 pb-4 pt-5 font-mono text-sm text-popover-foreground shadow-raised"
            >
              <p className="text-center font-semibold uppercase tracking-widest">{listName}</p>
              <p className="text-center text-xs text-muted-foreground">{format(new Date(), 'PPp')}</p>
              <div aria-hidden className="my-3 border-t border-dashed border-border" />
              <ul className="space-y-1" aria-label="Items bought">
                {sorted.map((item) => (
                  <li key={item.id} className="flex justify-between gap-3">
                    <span className="min-w-0 break-words">{item.name}</span>
                    <span className="shrink-0 tabular-nums">x{item.quantity}</span>
                  </li>
                ))}
              </ul>
              <div aria-hidden className="my-3 border-t border-dashed border-border" />
              <p className="flex justify-between font-semibold">
                <span>{pluralize(items.length, 'item')}</span>
                <span className="tabular-nums">{pluralize(totalUnits, 'unit')}</span>
              </p>
              <p className="mt-3 text-center text-xs text-muted-foreground">Thanks for shopping. See you next trip.</p>
            </motion.div>
          </div>
        </div>

        <DialogFooter className="gap-2 sm:flex-wrap sm:justify-end">
          <Button variant="secondary" onClick={() => onOpenChange(false)}>Done</Button>
          {onClearPurchased && (
            <Button variant="outline" onClick={onClearPurchased}>
              <ArchiveX className="mr-2 h-4 w-4" aria-hidden /> Clear purchased
            </Button>
          )}
          {onSendToPantry && (
            <Button onClick={onSendToPantry}>
              <Archive className="mr-2 h-4 w-4" aria-hidden /> Add to pantry
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
