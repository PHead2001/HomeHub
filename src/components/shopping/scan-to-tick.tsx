'use client';

import { useEffect, useRef, useState } from 'react';
import { ScanLine } from 'lucide-react';
import { getAiActionContext, unwrapAiActionResult } from '@/ai/client';
import { lookupBarcode } from '@/ai/flows/lookup-barcode-flow';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ToastAction } from '@/components/ui/toast';
import { useToast } from '@/hooks/use-toast';
import { matchByBarcode, scanTickDecision, type ScanTickDecision } from '@/lib/shopping/scan-tick';
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
  items,
  onTick,
  onAdd,
}: {
  householdId: string;
  items: readonly ShoppingListItem[];
  onTick: (item: ShoppingListItem) => void | Promise<void>;
  onAdd: (entry: ScanEntry, extras: { libraryItem?: BarcodeLibraryItem | null; barcode: string }) => void | Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  // The latest items: a lookup takes a moment, and someone may tick meanwhile.
  const itemsRef = useRef(items);
  useEffect(() => {
    itemsRef.current = items;
  }, [items]);
  useOnTabDeactivate(() => setOpen(false));
  const { toast } = useToast();
  const lookupFeedback = useLookupFeedback();
  const options = { fallback: 'tick it by hand', canSave: true };

  const act = (decision: ScanTickDecision<ShoppingListItem>, barcode: string, libraryItem?: BarcodeLibraryItem | null) => {
    switch (decision.kind) {
      case 'tick':
        void onTick(decision.item);
        return;
      case 'in-cart':
        toast({ title: 'Already in the cart', description: `${decision.item.name} is already ticked on this list.` });
        return;
      case 'offer-add': {
        const { entry } = decision;
        toast({
          title: 'Not on this list',
          description: `${entry.name} is not needed on this list.`,
          action: <ToastAction altText={`Add ${entry.name} to this list`} onClick={() => void onAdd(entry, { libraryItem, barcode })}>Add</ToastAction>,
          holdsAction: false,
        });
        return;
      }
      case 'miss':
        lookupFeedback.reportMiss(decision.miss, barcode, options);
    }
  };

  const handleScan = async (barcode: string) => {
    setOpen(false);
    // An item added by scanning this code ticks without a lookup (works offline).
    const local = matchByBarcode(itemsRef.current, barcode);
    if (local) {
      act(local, barcode);
      return;
    }
    try {
      const result = unwrapAiActionResult(await lookupBarcode({ barcode }, await getAiActionContext(householdId)));
      // Decided against the items as they are NOW (not as they were before the lookup).
      act(scanTickDecision(itemsRef.current, barcode, result), barcode, result.libraryItem);
    } catch (error) {
      lookupFeedback.reportError(error, barcode, options);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button type="button" variant="outline" className="w-full sm:w-auto [@media(pointer:coarse)]:min-h-12" onClick={() => setOpen(true)}>
        <ScanLine className="mr-2" aria-hidden /> Scan to tick
      </Button>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Scan to tick</DialogTitle>
          <DialogDescription>Scan a product to tick it off this list.</DialogDescription>
        </DialogHeader>
        {open && <BarcodeScanner onScan={handleScan} />}
      </DialogContent>
    </Dialog>
  );
}
