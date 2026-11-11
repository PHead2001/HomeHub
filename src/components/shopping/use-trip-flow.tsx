'use client';

import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { getAiActionContext } from '@/ai/client';
import { putAwayAndClear, undoTrip } from '@/app/shopping/actions';
import { ToastAction } from '@/components/ui/toast';
import { useAuth } from '@/hooks/use-auth';
import { useToast } from '@/hooks/use-toast';
import { isBrowserOffline } from '@/lib/firestore-offline';
import { UNDO_WINDOW_MS } from '@/lib/undo-window';
import type { QuickAddEntry } from '@/lib/shopping/items';
import { purchasesAlreadyPutAway, rememberAfterTrip, useAfterTripPreference, useShoppingUsuals } from '@/lib/shopping/trip-live';
import { tripGroup, tripOutcomeText, usualSuggestions, type AfterTrip, type TripChoice, type TripMode } from '@/lib/shopping/trip-plan';
import type { TripUndo, UndoEntry } from '@/lib/shopping/undo';
import { createRequestGate } from '@/lib/shopping/request-gate';
import { useHouseholdToday } from '@/lib/shopping/use-household-today';
import type { ShoppingList, ShoppingListItem } from '@/lib/types';
import { PutAwayDialog } from './put-away-dialog';
import { useOnTabDeactivate } from './tab-activity';
import { TripHistoryButton } from './trip-history';
import { UsualChips } from './usual-chips';
import type { SnackbarEntry } from './undo-snackbar';

type PutAwayTarget = {
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
  onQuickAdd: (entries: QuickAddEntry[]) => Promise<unknown>;
  closeReceipt: () => void;
}) {
  const { household } = useAuth();
  const { toast, toastError } = useToast();
  const today = useHouseholdToday(household?.timeZone ?? null);
  const isGrocery = list?.type === 'Grocery';
  const afterTrip = useAfterTripPreference(householdId);
  const usuals = useShoppingUsuals(isGrocery && canEdit ? householdId : null);
  const [putAway, setPutAway] = useState<PutAwayTarget | null>(null);
  // Openings that wait for a lookup: leaving the tab (or a newer opening) makes a pending one stale.
  const [openGate] = useState(createRequestGate);
  // The put-away dialog is portaled outside the tab panel: it closes with the tab,
  // and an opening still waiting for its lookup never shows it afterwards.
  const tabActive = useOnTabDeactivate(() => {
    openGate.invalidate();
    setPutAway(null);
  });

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
    setPutAway({ mode, householdId, listId, listName, items: group.items, shelvedIds: group.shelvedIds, left: group.left });
  }, [householdId, list, openGate, purchasedItems, toast]);

  const confirm = async (target: PutAwayTarget, tripId: string, choices: TripChoice[]): Promise<boolean> => {
    if (isBrowserOffline()) {
      toast({ title: OFFLINE_TITLE, description: 'Put the trip away once you are back online.' });
      return false;
    }
    try {
      const result = await putAwayAndClear({
        ...(await getAiActionContext(target.householdId)),
        listId: target.listId,
        tripId,
        mode: target.mode,
        items: choices,
      });
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
      if (trip.applied && uid) {
        addUndo({
          group: 'shopping-trip',
          uid,
          householdId: target.householdId,
          listId: target.listId,
          itemId: trip.tripId,
          name: target.listName,
          opId: trip.tripId,
          expiresAt: Date.now() + UNDO_WINDOW_MS,
        });
      }
      if (trip.cleared.length > 0) onCleared(target.listId);
      return true;
    } catch (error) {
      // A lost response may still have applied it: the dialog keeps its trip id,
      // so trying again never puts the same purchases away twice.
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
    ? <UsualChips suggestions={suggestions} onAdd={(name) => void onQuickAdd([{ name, quantity: 1 }])} />
    : null;

  const dialog: ReactNode = putAway && tabActive && householdId === putAway.householdId && list?.id === putAway.listId ? (
    <PutAwayDialog
      open
      onOpenChange={(open) => { if (!open) setPutAway(null); }}
      items={putAway.items}
      shelvedIds={putAway.shelvedIds}
      left={putAway.left}
      mode={putAway.mode}
      today={today}
      offline={!online}
      onConfirm={(tripId, choices) => confirm(putAway, tripId, choices)}
    />
  ) : null;

  const history: ReactNode = householdId && isGrocery ? (
    <TripHistoryButton
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
    history,
  };
}
