'use client';

import { useCallback, useState } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { useToast } from '@/hooks/use-toast';
import { isBrowserOffline } from '@/lib/firestore-offline';
import { lookupErrorMiss, lookupMissCopy, type LookupMiss } from '@/lib/barcode/lookup-outcome';
import { saveToLibraryHref } from '@/lib/barcode/library-writes';

export type ScanMiss = { miss: LookupMiss; barcode: string };

/**
 * A lookup miss inside a modal dialog (Add Item, the pantry item dialog). A toast
 * would sit outside the modal, where its "Save to library" action can be neither
 * clicked nor reached with the keyboard, so the miss is shown inline in the
 * dialog instead (BL-9). `reportError` keeps sign-in and permission errors as a
 * `toastError`.
 */
export function useScanMiss() {
  const { toastError } = useToast();
  const [scanMiss, setScanMiss] = useState<ScanMiss | null>(null);
  const reportMiss = useCallback((miss: LookupMiss, barcode: string) => setScanMiss({ miss, barcode }), []);
  const reportError = useCallback((error: unknown, barcode: string) => {
    const miss = lookupErrorMiss(error, isBrowserOffline());
    if (miss) setScanMiss({ miss, barcode });
    else toastError(error, 'Barcode lookup failed');
  }, [toastError]);
  const clear = useCallback(() => setScanMiss(null), []);
  return { scanMiss, reportMiss, reportError, clear };
}

export function LookupMissNotice({ scanMiss, fallback, canSave }: { scanMiss: ScanMiss | null; fallback: string; canSave: boolean }) {
  if (!scanMiss) return null;
  const offerSave = scanMiss.miss.kind === 'not-found' && canSave;
  const copy = lookupMissCopy(scanMiss.miss, fallback, offerSave);
  return (
    <div role="alert" className="space-y-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm">
      <p className="font-medium">{copy.title}</p>
      <p className="text-muted-foreground">{copy.description}</p>
      {offerSave && (
        <Button asChild variant="outline" size="sm" className="min-h-11 [@media(pointer:coarse)]:min-h-12">
          <Link href={saveToLibraryHref(scanMiss.barcode)}>Save to library</Link>
        </Button>
      )}
    </div>
  );
}
