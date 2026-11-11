'use client';

import { useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useToast } from '@/hooks/use-toast';
import { ToastAction } from '@/components/ui/toast';
import { isBrowserOffline } from '@/lib/firestore-offline';
import { lookupErrorMiss, lookupMissCopy, type LookupMiss } from '@/lib/barcode/lookup-outcome';
import { saveToLibraryHref } from '@/lib/barcode/library-writes';

/**
 * Toasts for a barcode lookup without a product (BL-9), shared by Shopping and
 * Pantry. "Not found" keeps the scanned code and offers "Save to library", which
 * opens the library's Add dialog with the code filled in (`/library?add=`). A
 * lookup that could not answer says so and offers no save (the product may well
 * be known once the lookup answers again).
 */
export function useLookupFeedback() {
  const { toast, toastError } = useToast();
  const router = useRouter();

  const reportMiss = useCallback((miss: LookupMiss, barcode: string, { fallback, canSave }: { fallback: string; canSave: boolean }) => {
    const offerSave = miss.kind === 'not-found' && canSave;
    const copy = lookupMissCopy(miss, fallback, offerSave);
    toast({
      variant: miss.kind === 'not-found' ? 'destructive' : 'default',
      title: copy.title,
      description: copy.description,
      action: offerSave
        ? <ToastAction altText={`Save barcode ${barcode} to the library`} onClick={() => router.push(saveToLibraryHref(barcode))}>Save to library</ToastAction>
        : undefined,
      holdsAction: false,
    });
  }, [router, toast]);

  /** A thrown lookup: capacity and connection problems read as "unavailable"; others keep their error copy. */
  const reportError = useCallback((error: unknown, barcode: string, options: { fallback: string; canSave: boolean }) => {
    const miss = lookupErrorMiss(error, isBrowserOffline());
    if (miss) reportMiss(miss, barcode, options);
    else toastError(error, 'Barcode lookup failed');
  }, [reportMiss, toastError]);

  return { reportMiss, reportError };
}
