'use client';

import { useEffect, useRef, useState } from 'react';
import { ScanLine } from 'lucide-react';
import { getAiActionContext, unwrapAiActionResult } from '@/ai/client';
import { lookupBarcode } from '@/ai/flows/lookup-barcode-flow';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ToastAction } from '@/components/ui/toast';
import { useToast } from '@/hooks/use-toast';
import { matchByBarcode, scanStillApplies, scanTickDecision, type ScanListIdentity, type ScanTickDecision } from '@/lib/shopping/scan-tick';
import type { ScanEntry } from '@/lib/shopping/scan';
import type { BarcodeLibraryItem, ShoppingListItem } from '@/lib/types';
import { BarcodeScanner } from '../barcode-scanner';
import { useLookupFeedback } from '../barcode/use-lookup-feedback';
import { useOnTabDeactivate } from './tab-activity';

/**
 * "Scan to tick" on an open list (SH-33f). A scanned product that matches a
 * needed item (same scanned barcode, or the looked-up name) is ticked through the
 * list's own tick (`onTick`, which shows its 10 s Undo); a product that is not on
 * the list is offered as an Add; an unknown code offers "Save to library"; a
 * lookup that cannot answer says so. The scanner closes after each scan and when
 * the Shopping tab is hidden (releasing the camera).
 */
export function ScanToTick({
  householdId,
  listId,
  items,
  onTick,
  onAdd,
  open: openProp,
  onOpenChange,
  showTrigger = true,
  onCloseAutoFocus,
}: {
  householdId: string;
  /** The open list `items`, `onTick` and `onAdd` belong to. */
  listId: string;
  items: readonly ShoppingListItem[];
  onTick: (item: ShoppingListItem) => void | Promise<void>;
  onAdd: (entry: ScanEntry, extras: { libraryItem?: BarcodeLibraryItem | null; barcode: string }) => void | Promise<void>;
  /** Controlled open state (the open list's overflow menu opens it, S8b). */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Draws the "Scan to tick" button (off when a menu item opens the scanner instead). */
  showTrigger?: boolean;
  /** Where focus goes when the dialog closes (opened from a menu, it has no trigger to return to). */
  onCloseAutoFocus?: (event: Event) => void;
}) {
  const [ownOpen, setOwnOpen] = useState(false);
  const open = openProp ?? ownOpen;
  const setOpen = (next: boolean) => (onOpenChange ? onOpenChange(next) : setOwnOpen(next));
  // The latest list, items and callbacks, kept together: a lookup takes a
  // moment, someone may tick meanwhile, and the member may open another list.
  // A result is only acted on for the list its scan started on (and never after
  // this scanner unmounts).
  const latest = useRef<{ list: ScanListIdentity | null; items: readonly ShoppingListItem[]; onTick: typeof onTick; onAdd: typeof onAdd }>(
    { list: { householdId, listId }, items, onTick, onAdd },
  );
  useEffect(() => {
    latest.current = { list: { householdId, listId }, items, onTick, onAdd };
  }, [householdId, listId, items, onTick, onAdd]);
  useEffect(() => () => {
    latest.current = { ...latest.current, list: null };
  }, []);
  useOnTabDeactivate(() => setOpen(false));
  const { toast } = useToast();
  const lookupFeedback = useLookupFeedback();
  const options = { fallback: 'tick it by hand', canSave: true };

  const act = (decision: ScanTickDecision<ShoppingListItem>, barcode: string, libraryItem?: BarcodeLibraryItem | null) => {
    switch (decision.kind) {
      case 'tick':
        void latest.current.onTick(decision.item);
        return;
      case 'in-cart':
        toast({ title: 'Already in the cart', description: `${decision.item.name} is already ticked on this list.` });
        return;
      case 'offer-add': {
        const { entry } = decision;
        toast({
          title: 'Not on this list',
          description: `${entry.name} is not needed on this list.`,
          action: <ToastAction altText={`Add ${entry.name} to this list`} onClick={() => void add(entry, { libraryItem, barcode })}>Add</ToastAction>,
          holdsAction: false,
        });
        return;
      }
      case 'miss':
        lookupFeedback.reportMiss(decision.miss, barcode, options);
    }
  };

  // The Add offered in a toast still belongs to the scan's list.
  const add = (entry: ScanEntry, extras: { libraryItem?: BarcodeLibraryItem | null; barcode: string }) => {
    if (scanStillApplies({ householdId, listId }, latest.current.list)) void latest.current.onAdd(entry, extras);
  };

  const handleScan = async (barcode: string) => {
    setOpen(false);
    const started: ScanListIdentity = { householdId, listId };
    // An item added by scanning this code ticks without a lookup (works offline).
    const local = matchByBarcode(latest.current.items, barcode);
    if (local) {
      act(local, barcode);
      return;
    }
    try {
      const result = unwrapAiActionResult(await lookupBarcode({ barcode }, await getAiActionContext(householdId)));
      // Another list is open now (or the scanner is gone): drop the result.
      if (!scanStillApplies(started, latest.current.list)) return;
      // Decided against the items as they are NOW (not as they were before the lookup).
      act(scanTickDecision(latest.current.items, barcode, result), barcode, result.libraryItem);
    } catch (error) {
      if (!scanStillApplies(started, latest.current.list)) return;
      lookupFeedback.reportError(error, barcode, options);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {showTrigger && (
        <Button type="button" variant="outline" className="w-full sm:w-auto [@media(pointer:coarse)]:min-h-12" onClick={() => setOpen(true)}>
          <ScanLine className="mr-2" aria-hidden /> Scan to tick
        </Button>
      )}
      <DialogContent phoneSheet onCloseAutoFocus={onCloseAutoFocus}>
        <DialogHeader>
          <DialogTitle>Scan to tick</DialogTitle>
          <DialogDescription>Scan a product to tick it off this list.</DialogDescription>
        </DialogHeader>
        {open && <BarcodeScanner onScan={handleScan} />}
      </DialogContent>
    </Dialog>
  );
}
