'use client';

import { useCallback, useLayoutEffect, useMemo, useState, type ReactNode } from 'react';
import { getAiActionContext } from '@/ai/client';
import { putAwayAndClear, undoTrip } from '@/app/shopping/actions';
import { ToastAction } from '@/components/ui/toast';
import { useAuth } from '@/hooks/use-auth';
import { useToast } from '@/hooks/use-toast';
import { isBrowserOffline } from '@/lib/firestore-offline';
import { UNDO_WINDOW_MS } from '@/lib/undo-window';
import type { QuickAddEntry } from '@/lib/shopping/items';
import { addAndReportDetached, type QuickAddOutcome } from '@/lib/shopping/quick-add-outcome';
import { purchasesAlreadyPutAway, rememberAfterTrip, useAfterTripPreference, useShoppingUsuals } from '@/lib/shopping/trip-live';
import { tripGroup, tripOutcomeText, tripUndoAfterAnswer, usualSuggestions, type AfterTrip, type TripChoice, type TripMode } from '@/lib/shopping/trip-plan';
import { browserJournalStorage, pushJournal, type TripUndo, type UndoEntry } from '@/lib/shopping/undo';
import { closeIfCurrent, createRequestGate } from '@/lib/shopping/request-gate';
import { useHouseholdToday } from '@/lib/shopping/use-household-today';
import type { ShoppingList, ShoppingListItem } from '@/lib/types';
import { PutAwayDialog } from './put-away-dialog';
import { useOnTabDeactivate } from './tab-activity';
import { TripHistoryButton } from './trip-history';
import { UsualChips } from './usual-chips';
import type { SnackbarEntry } from './undo-snackbar';

type PutAwayTarget = {
  /** The opening's ticket: the dialog's key and identity. */
  openingId: number;
  mode: TripMode;
  householdId: string;
  listId: string;
  listName: string;
  items: ShoppingListItem[];
  /** Items whose purchase is already on the shelves (cleared, never credited again). */
  shelvedIds: ReadonlySet<string>;
  /** Purchases not in this trip (more than one trip carries): they stay on the list for another. */
  left: number;
};

const OFFLINE_TITLE = 'You are offline';

/**
 * The after-trip flow of an open list (S5: SH-2, SH-17, SH-30, SH-32), kept out
 * of `ShoppingListClient`: the receipt's two actions and the remembered choice,
 * the put-away dialog and its server action (`putAwayAndClear`, idempotent by
 * the dialog's trip id), the trip's 10-second Undo in the shared snackbar and
 * journal (group `shopping-trip`, so it survives a reload) on top of the
 * server's 15-minute window (`undoTrip`, also offered in the trip history), the
 * usual chips above quick add, and the history button.
 */
export function useTripFlow({
  householdId,
  uid,
  list,
  purchasedItems,
  neededItems,
  canEdit,
  canDelete,
  online,
  now,
  memberNames,
  addUndo,
  dropUndo,
  onCleared,
  onOpenPantry,
  onQuickAdd,
  closeReceipt,
  historyCloseAutoFocus,
}: {
  householdId: string | null;
  uid: string | null;
  list: ShoppingList | null;
  purchasedItems: ShoppingListItem[];
  neededItems: ShoppingListItem[];
  canEdit: boolean;
  canDelete: boolean;
  online: boolean;
  now: number;
  memberNames: ReadonlyMap<string, string>;
  addUndo: (entry: UndoEntry) => void;
  dropUndo: (opId: string) => void;
  /** After a trip cleared items from `listId` (the empty-list check). */
  onCleared: (listId: string) => void;
  onOpenPantry?: () => void;
  onQuickAdd: (entries: QuickAddEntry[]) => Promise<QuickAddOutcome>;
  closeReceipt: () => void;
  /** Where focus goes when the trip history closes (it opens from the list's menu). */
  historyCloseAutoFocus?: (event: Event) => void;
}) {
  const { household } = useAuth();
  const { toast, toastError } = useToast();
  const today = useHouseholdToday(household?.timeZone ?? null);
  const isGrocery = list?.type === 'Grocery';
  const afterTrip = useAfterTripPreference(householdId);
  const usuals = useShoppingUsuals(isGrocery && canEdit ? householdId : null);
  const [putAway, setPutAway] = useState<PutAwayTarget | null>(null);
  // The trip history, opened from the open list's overflow menu (S8b).
  const [historyOpen, setHistoryOpen] = useState(false);
  // Openings that wait for a lookup: leaving the tab (or a newer opening) makes a pending one stale.
  const [openGate] = useState(createRequestGate);
  // The put-away dialog is portaled outside the tab panel: it closes with the tab,
  // and an opening still waiting for its lookup never shows it afterwards.
  const tabActive = useOnTabDeactivate(() => {
    openGate.invalidate();
    setPutAway(null);
  });
  // Another household or list (the overview, another list) cancels a pending opening and
  // drops a dialog of the previous list (in the render that sees the change); so does
  // unmounting. The layout effect runs in the same commit as the change, before a
  // lookup's answer can be handled.
  const scope = `${householdId ?? ''}/${list?.id ?? ''}`;
  const [shownScope, setShownScope] = useState(scope);
  if (shownScope !== scope) {
    setShownScope(scope);
    setPutAway(null);
  }
  useLayoutEffect(() => {
    openGate.setScope(scope);
    return () => openGate.invalidate();
  }, [openGate, scope]);

  /** Put away & clear needs both permissions the rules ask for; members who cannot delete put away only. */
  const putAwayMode: TripMode | null = isGrocery && canEdit ? (canDelete ? 'putAwayAndClear' : 'putAway') : null;

  // Always written: until the stored preference has loaded, `afterTrip` is only the default.
  const remember = useCallback((choice: AfterTrip) => {
    if (!canEdit || !householdId) return;
    void rememberAfterTrip(householdId, choice).catch(() => undefined);
  }, [canEdit, householdId]);

  const openPutAway = useCallback(async (mode: TripMode) => {
    if (!householdId || !list) return;
    const listId = list.id;
    const listName = list.name;
    const items = purchasedItems;
    const ticket = openGate.begin();
    // A purchase already in the pantry: by its credit stamp, or by an earlier trip
    // that credited its purchase id (a deleted and restored item has no stamp).
    const credited = await purchasesAlreadyPutAway(householdId, items.flatMap((item) => (item.purchaseOpId ? [item.purchaseOpId] : [])));
    if (!openGate.isCurrent(ticket)) return;
    const group = tripGroup(items, mode, credited);
    if (group.items.length === 0) {
      toast({ title: 'Already put away', description: 'These purchases are already on the pantry shelves.' });
      return;
    }
    setPutAway({ openingId: ticket, mode, householdId, listId, listName, items: group.items, shelvedIds: group.shelvedIds, left: group.left });
  }, [householdId, list, openGate, purchasedItems, toast]);

  const confirm = async (target: PutAwayTarget, tripId: string, choices: TripChoice[]): Promise<boolean> => {
    if (isBrowserOffline()) {
      toast({ title: OFFLINE_TITLE, description: 'Put the trip away once you are back online.' });
      return false;
    }
    const undoEntry = (): TripUndo | null => (uid ? {
      group: 'shopping-trip', uid, householdId: target.householdId, listId: target.listId, itemId: tripId, name: target.listName, opId: tripId,
      expiresAt: Date.now() + UNDO_WINDOW_MS,
    } : null);
    // Journaled (not shown) before the request: a reload while the answer is on its way
    // still re-offers this trip's Undo once the page is back (`tripUndoAfterAnswer`).
    const early = undoEntry();
    if (early) pushJournal(browserJournalStorage(), early, Date.now());
    const settle = (answer: Parameters<typeof tripUndoAfterAnswer>[0]) => {
      const next = tripUndoAfterAnswer(answer);
      const entry = undoEntry();
      if (next === 'show' && entry) addUndo(entry);
      else if (next === 'drop') dropUndo(tripId);
    };
    try {
      const result = await putAwayAndClear({
        ...(await getAiActionContext(target.householdId)),
        listId: target.listId,
        tripId,
        mode: target.mode,
        items: choices,
      });
      settle(result.ok ? { ok: true, applied: result.trip.applied } : { ok: false });
      if (!result.ok) {
        toast({ variant: 'destructive', title: 'Could not put the trip away', description: result.message });
        // The list is gone: nothing more can be done in this dialog.
        return result.code === 'list_missing';
      }
      const trip = result.trip;
      const text = tripOutcomeText({
        mode: trip.mode, credited: trip.credited, cleared: trip.cleared.length, skipped: trip.skipped, remaining: target.left + trip.deferred.length,
      });
      toast({
        title: text.title,
        description: text.description,
        action: onOpenPantry && trip.credited > 0 ? <ToastAction altText="View the pantry" onClick={onOpenPantry}>View pantry</ToastAction> : undefined,
      });
      if (trip.cleared.length > 0) onCleared(target.listId);
      return true;
    } catch (error) {
      // A lost response may still have applied it: the dialog keeps its trip id,
      // so trying again never puts the same purchases away twice; the journaled
      // Undo stays for a reload (the server says if there is nothing to undo).
      settle('lost');
      toastError(error, 'Could not put the trip away');
      return false;
    }
  };

  const undo = useCallback(async (targetHouseholdId: string, tripId: string, journalOpId?: string) => {
    if (isBrowserOffline()) {
      toast({ title: OFFLINE_TITLE, description: 'Undoing a trip needs a connection. It can be undone for 15 minutes from Trips.' });
      return;
    }
    if (journalOpId) dropUndo(journalOpId);
    try {
      const result = await undoTrip({ ...(await getAiActionContext(targetHouseholdId)), tripId });
      if (!result.ok) {
        toast({ variant: 'destructive', title: 'Could not undo the trip', description: result.message });
        return;
      }
      const { undo: summary } = result;
      if (summary.alreadyUndone) {
        toast({ title: 'Trip already undone' });
        return;
      }
      const notes: string[] = [];
      if (summary.restored > 0) notes.push(`${summary.restored} back on the list.`);
      if (summary.clamped > 0) notes.push('Some of it was already used, so less was taken off the shelves.');
      if (summary.kept.length > 0) notes.push(`Kept ${summary.kept.join(', ')} on the shelves: changed on another device.`);
      toast({ title: 'Trip undone', description: notes.join(' ') || undefined });
    } catch (error) {
      toastError(error, 'Could not undo the trip');
    }
  }, [dropUndo, toast, toastError]);

  const snackbarEntry = (entry: TripUndo): SnackbarEntry => ({
    key: entry.opId,
    message: `${entry.name} put away`,
    undoLabel: `Undo putting away ${entry.name}`,
    onUndo: () => void undo(entry.householdId, entry.itemId, entry.opId),
    onDismiss: () => dropUndo(entry.opId),
  });

  const suggestions = useMemo(
    () => usualSuggestions(usuals.value, neededItems.map((item) => item.name), now),
    [usuals.value, neededItems, now],
  );

  const chips: ReactNode = isGrocery && canEdit && suggestions.length > 0
    // No field to put a failure back into: what was not added is said in a toast (the chip stays, so a tap retries).
    ? <UsualChips suggestions={suggestions} onAdd={(name) => void addAndReportDetached(list?.name ?? 'the list', [{ name, quantity: 1 }], onQuickAdd, toast)} />
    : null;

  // Keyed and closed by its own opening: an earlier dialog's slow submission that
  // finishes after it was unmounted reports its trip but never closes a newer dialog.
  const opening = putAway;
  const dialog: ReactNode = opening && tabActive && householdId === opening.householdId && list?.id === opening.listId ? (
    <PutAwayDialog
      key={opening.openingId}
      open
      onOpenChange={(open) => { if (!open) setPutAway((current) => closeIfCurrent(current, opening)); }}
      items={opening.items}
      shelvedIds={opening.shelvedIds}
      left={opening.left}
      mode={opening.mode}
      today={today}
      offline={!online}
      onConfirm={(tripId, choices) => confirm(opening, tripId, choices)}
    />
  ) : null;

  const history: ReactNode = householdId && isGrocery ? (
    <TripHistoryButton
      showTrigger={false}
      open={historyOpen}
      onOpenChange={setHistoryOpen}
      onCloseAutoFocus={historyCloseAutoFocus}
      householdId={householdId}
      memberNames={memberNames}
      currentUid={uid}
      canUndo={canEdit && online}
      onUndo={(tripId) => undo(householdId, tripId)}
    />
  ) : null;

  return {
    afterTrip,
    putAwayMode,
    putAwayLabel: putAwayMode === 'putAway' ? 'Put away' : 'Put away & clear',
    remember,
    openPutAway,
    /** Receipt "Put away & clear": remembered, then the put-away dialog. */
    receiptPutAway: putAwayMode ? () => {
      remember('putAwayAndClear');
      closeReceipt();
      void openPutAway(putAwayMode);
    } : undefined,
    /** Receipt "Done": remembered; the list stays as it is. */
    receiptDone: () => {
      remember('done');
      closeReceipt();
    },
    snackbarEntry,
    chips,
    dialog,
    /** The trip history dialog (rendered with the list; no button of its own). */
    history,
    /** Opens the trip history (Grocery lists), or null where there is none. */
    openHistory: history ? () => setHistoryOpen(true) : null,
  };
}
