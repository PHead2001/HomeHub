'use client';

import { useCallback, useState } from 'react';
import { BookmarkPlus, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ToastAction } from '@/components/ui/toast';
import { useToast } from '@/hooks/use-toast';
import { saveOfferToLibrary } from '@/lib/barcode/library-save';
import type { LibraryOffer } from '@/lib/barcode/library-fill';

/**
 * "Save to library" after an Open Food Facts find (BL-19): inline in a modal
 * dialog that stays open (a toast's action would sit behind the modal), or as a
 * toast once no modal is in the way. Offered to members with `shopping.edit`.
 */
export function useLibrarySaveOffer(householdId: string | null, uid: string | null) {
  const { toast, toastError } = useToast();
  const [offer, setOffer] = useState<LibraryOffer | null>(null);
  const [saving, setSaving] = useState(false);

  const save = useCallback(async (target: LibraryOffer) => {
    if (!householdId || !uid) return;
    setSaving(true);
    try {
      const outcome = await saveOfferToLibrary(householdId, uid, target);
      toast(outcome === 'saved'
        ? { title: 'Saved to your library', description: `${target.name} will fill in at once next time.` }
        : { title: 'Already in your library', description: 'Someone saved this barcode meanwhile.' });
      setOffer((current) => (current?.barcode === target.barcode ? null : current));
    } catch (error) {
      toastError(error, 'Could not save to the library');
    } finally {
      setSaving(false);
    }
  }, [householdId, uid, toast, toastError]);

  const offerToast = useCallback((target: LibraryOffer) => {
    toast({
      title: 'Save to your library?',
      description: `${target.name} came from Open Food Facts. Save it so the next scan fills in at once, even offline.`,
      action: <ToastAction altText={`Save ${target.name} to the library`} onClick={() => void save(target)}>Save</ToastAction>,
      // An offer, not a pending decision: newer toasts may replace it.
      holdsAction: false,
    });
  }, [toast, save]);

  const clear = useCallback(() => setOffer(null), []);
  return { offer, setOffer, clear, save, saving, offerToast };
}

export function LibrarySaveOffer({ offer, saving, onSave }: { offer: LibraryOffer | null; saving: boolean; onSave: (offer: LibraryOffer) => void }) {
  if (!offer) return null;
  return (
    <div className="space-y-2 rounded-md border border-primary/30 bg-primary/5 p-3 text-sm" data-testid="library-save-offer">
      <p>
        <span className="font-medium">{offer.name}</span> came from Open Food Facts. Save it to your library so the next scan fills in at once.
      </p>
      <Button type="button" variant="outline" size="sm" className="min-h-11 [@media(pointer:coarse)]:min-h-12" disabled={saving} onClick={() => onSave(offer)}>
        {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden /> : <BookmarkPlus className="mr-2 h-4 w-4" aria-hidden />}
        Save to library
      </Button>
    </div>
  );
}
