'use client';

import { useCallback, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { ListPlus, Loader2, PackageMinus, PackagePlus } from 'lucide-react';
import { getAiActionContext, unwrapAiActionResult } from '@/ai/client';
import { lookupBarcode } from '@/ai/flows/lookup-barcode-flow';
import { Button } from '@/components/ui/button';
import { ToastAction } from '@/components/ui/toast';
import { useAuth } from '@/hooks/use-auth';
import { useToast } from '@/hooks/use-toast';
import { isBrowserOffline } from '@/lib/firestore-offline';
import { useLibraryPhotos } from '@/lib/barcode/use-library-photos';
import { libraryOfferFor, localLibraryLookup } from '@/lib/barcode/library-fill';
import { countLibraryScan } from '@/lib/barcode/library-save';
import { lookupErrorMiss, lookupMissCopy, type LookupMiss } from '@/lib/barcode/lookup-outcome';
import { saveToLibraryHref } from '@/lib/barcode/library-writes';
import { onListCopy, putOnList, restockOne, takeOneOf, undoPackageChanges, type ListTarget, type PackageDelta } from '@/lib/barcode/product-stock';
import { restockLine, STATION_MODES, stationModeFrom, stationProduct, usedUpLine, type StationMode, type StationProduct } from '@/lib/barcode/station';
import { USED_UP_UNDO_MS, packageChangeToast } from '@/lib/shopping/pantry-batches';
import type { ShoppingList } from '@/lib/types';
import { cn } from '@/lib/utils';
import { BarcodeScanner } from '../barcode-scanner';
import { LibrarySaveOffer, useLibrarySaveOffer } from './library-save-offer';

const MODE_ICON: Record<StationMode, typeof PackageMinus> = { used: PackageMinus, restock: PackagePlus, list: ListPlus };

type Line = { tone: 'ok' | 'warn'; text: string };

/**
 * The kitchen scan station on a personal account (BL-20, BL-21): the camera stays
 * on and scans continuously (a repeat of the same code within 3 s is ignored),
 * and each product scanned gets the selected action: Used up (one package out of
 * the pantry, soonest expiry first; at zero "Add to list?"), Restock (one package
 * in) or Add to list. Writes go through the pantry's and list's own paths
 * (`product-stock.ts`), with the pantry's 10 s Undo. Members without
 * `shopping.edit` are told they cannot change stock.
 */
export function KitchenScanStation() {
  const { currentUser, household, permissions } = useAuth();
  const { toast, toastError } = useToast();
  const householdId = currentUser?.householdId ?? null;
  const uid = currentUser?.uid ?? null;
  const canEdit = Boolean(permissions['shopping.edit']);
  const library = useLibraryPhotos(householdId);
  const librarySave = useLibrarySaveOffer(householdId, uid);
  // The address picks the starting action (`/library/scan?mode=restock`); the station renders only once signed in, on the client.
  const [mode, setMode] = useState<StationMode>(() => (typeof window === 'undefined' ? 'used' : stationModeFrom(window.location.search)));
  const [busy, setBusy] = useState(false);
  const [line, setLine] = useState<Line | null>(null);
  const [miss, setMiss] = useState<{ miss: LookupMiss; barcode: string } | null>(null);
  const [askAdd, setAskAdd] = useState<string | null>(null);
  const [notStocked, setNotStocked] = useState<StationProduct | null>(null);
  const [pick, setPick] = useState<{ name: string; lists: ShoppingList[] } | null>(null);
  const undoDismiss = useRef<(() => void) | null>(null);
  // Scans are handled one after another, in order (a quick second scan waits its turn).
  const queue = useRef<Promise<void>>(Promise.resolve());

  const timeZone = household?.timeZone ?? null;
  const context = useMemo(() => (householdId && uid
    ? { householdId, uid, timeZone, onLateError: (error: unknown) => toastError(error, 'Could not sync the change') }
    : null), [householdId, uid, timeZone, toastError]);

  const offerUndo = useCallback((title: string, description: string, outcome: 'saved' | 'queued', changes: PackageDelta[], undoable: boolean) => {
    const shown = packageChangeToast(outcome, title, description);
    if (!context || !shown.offerUndo || !undoable || changes.length === 0) {
      toast({ title: shown.title, description: shown.description });
      return;
    }
    const handle = toast({
      title: shown.title,
      description: shown.description,
      duration: USED_UP_UNDO_MS,
      action: (
        <ToastAction altText={`Undo: ${title}`} onClick={() => {
          undoDismiss.current?.();
          setAskAdd(null);
          void undoPackageChanges(changes, context).catch((error: unknown) => toastError(error, 'Could not undo'));
        }}>
          Undo
        </ToastAction>
      ),
    });
    undoDismiss.current = handle.dismiss;
  }, [context, toast, toastError]);

  const addToList = useCallback(async (name: string, list?: ListTarget) => {
    if (!context) return;
    const answer = await putOnList(name, { ...context, list });
    if (answer.kind === 'pick') {
      setPick({ name, lists: answer.lists });
      return;
    }
    setPick(null);
    const copy = onListCopy(name, answer.result);
    toast(copy);
    setLine({ tone: 'ok', text: copy.description });
  }, [context, toast]);

  const apply = useCallback(async (product: StationProduct, action: StationMode) => {
    if (!context) return;
    if (action === 'list') {
      await addToList(product.name);
      return;
    }
    if (action === 'restock') {
      const result = await restockOne({ barcode: product.barcode, name: product.name }, context);
      const text = restockLine(result.name, result.merged);
      setLine({ tone: 'ok', text });
      offerUndo(`Restocked ${result.name}`, text, result.outcome, result.changes, result.undoable);
      return;
    }
    const used = await takeOneOf({ barcode: product.barcode, name: product.name }, context);
    const text = usedUpLine(used.kind === 'used' ? { ...used } : used, product.name);
    if (used.kind !== 'used') {
      setLine({ tone: 'warn', text });
      if (used.kind === 'not-stocked') setNotStocked(product);
      return;
    }
    setLine({ tone: 'ok', text });
    offerUndo(`Used one ${used.name}`, text, used.outcome, used.changes, used.undoable);
    // D-8: ask, never add by itself.
    if (used.askAddToList) setAskAdd(used.name);
  }, [context, addToList, offerUndo]);

  const handleOne = useCallback(async (barcode: string) => {
    if (!householdId || !canEdit) return;
    setBusy(true);
    setMiss(null);
    setAskAdd(null);
    setNotStocked(null);
    setPick(null);
    librarySave.clear();
    try {
      const result = localLibraryLookup(library, barcode)
        ?? unwrapAiActionResult(await lookupBarcode({ barcode }, await getAiActionContext(householdId)));
      const found = stationProduct(result, barcode);
      if (found.kind === 'miss') {
        setMiss({ miss: found.miss, barcode });
        setLine(null);
        return;
      }
      if (result.source === 'household' && result.libraryItem) countLibraryScan(householdId, result.libraryItem.id);
      const offer = libraryOfferFor(result, barcode, householdId);
      if (offer) librarySave.setOffer(offer);
      await apply(found.product, mode);
    } catch (error) {
      const lookup = lookupErrorMiss(error, isBrowserOffline());
      if (lookup) setMiss({ miss: lookup, barcode });
      else toastError(error, 'Could not finish that scan');
    } finally {
      setBusy(false);
    }
  }, [householdId, canEdit, library, librarySave, apply, mode, toastError]);

  const handleScan = useCallback((barcode: string) => {
    queue.current = queue.current.then(() => handleOne(barcode));
  }, [handleOne]);

  if (!canEdit) {
    return <p className="rounded-xl border border-dashed p-6 text-muted-foreground">The scan station changes the pantry and the shopping list. Ask a household admin for shopping access.</p>;
  }

  const missCopy = miss ? lookupMissCopy(miss.miss, 'try another product', miss.miss.kind === 'not-found') : null;

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]" data-testid="scan-station">
      <div className="space-y-3">
        <BarcodeScanner onScan={handleScan} continuous />
      </div>
      <div className="space-y-4">
        <div role="radiogroup" aria-label="What a scan does" className="grid grid-cols-3 gap-2">
          {STATION_MODES.map((option) => {
            const Icon = MODE_ICON[option.id];
            const selected = option.id === mode;
            return (
              <button
                key={option.id}
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() => setMode(option.id)}
                className={cn(
                  'flex min-h-20 flex-col items-center justify-center gap-1 rounded-xl border-2 px-2 text-base font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  selected ? 'border-primary bg-primary text-primary-foreground' : 'border-border bg-card',
                )}
              >
                <Icon className="h-6 w-6" aria-hidden />
                {option.label}
              </button>
            );
          })}
        </div>
        <p className="text-sm text-muted-foreground">{STATION_MODES.find((option) => option.id === mode)?.hint}</p>
        <div aria-live="polite" className="min-h-12" data-testid="scan-station-line">
          {busy ? (
            <p className="flex items-center gap-2 text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Working…</p>
          ) : line ? (
            <p className={cn('text-lg font-medium', line.tone === 'warn' && 'text-muted-foreground')}>{line.text}</p>
          ) : (
            <p className="text-muted-foreground">Scan a product.</p>
          )}
        </div>
        {askAdd && (
          <div role="alert" className="space-y-2 rounded-xl border p-4" data-testid="scan-station-ask">
            <p className="font-medium">That was the last {askAdd}. Add to list?</p>
            <div className="flex gap-2">
              <Button className="min-h-12 flex-1" onClick={() => { const name = askAdd; setAskAdd(null); void addToList(name).catch((error: unknown) => toastError(error, 'Could not add to the shopping list')); }}>Add</Button>
              <Button variant="outline" className="min-h-12 flex-1" onClick={() => setAskAdd(null)}>Not now</Button>
            </div>
          </div>
        )}
        {notStocked && (
          <div className="flex gap-2">
            <Button variant="outline" className="min-h-12 flex-1" onClick={() => { const product = notStocked; setNotStocked(null); void apply(product, 'restock').catch((error: unknown) => toastError(error, 'Could not add to the pantry')); }}>Restock instead</Button>
            <Button variant="outline" className="min-h-12 flex-1" onClick={() => { const product = notStocked; setNotStocked(null); void addToList(product.name).catch((error: unknown) => toastError(error, 'Could not add to the shopping list')); }}>Add to list</Button>
          </div>
        )}
        {pick && (
          <div className="space-y-2">
            <p className="font-medium">Which list for {pick.name}?</p>
            {pick.lists.map((list) => (
              <Button key={list.id} variant="outline" className="min-h-12 w-full justify-start" onClick={() => void addToList(pick.name, list).catch((error: unknown) => toastError(error, 'Could not add to the shopping list'))}>
                {list.name}
              </Button>
            ))}
          </div>
        )}
        {missCopy && miss && (
          <div role="alert" className="space-y-2 rounded-xl border border-destructive/40 bg-destructive/5 p-4 text-sm">
            <p className="font-medium">{missCopy.title}</p>
            <p className="text-muted-foreground">{missCopy.description}</p>
            {miss.miss.kind === 'not-found' && (
              <Button asChild variant="outline" className="min-h-12">
                <Link href={saveToLibraryHref(miss.barcode)}>Save to library</Link>
              </Button>
            )}
          </div>
        )}
        <LibrarySaveOffer offer={librarySave.offer} saving={librarySave.saving} onSave={(offer) => void librarySave.save(offer)} />
      </div>
    </div>
  );
}
