'use client';

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import { AnimatePresence } from 'motion/react';
import { collection, doc, getDocFromCache, updateDoc, deleteDoc, setDoc, type DocumentReference } from 'firebase/firestore';
import { ArchiveX, ArrowLeft, History as HistoryIcon, Loader2, Minus, Plus, PlusCircle, ScanBarcode, ScanLine, Settings } from 'lucide-react';
import { getAiActionContext, unwrapAiActionResult } from '@/ai/client';
import { lookupBarcode } from '@/ai/flows/lookup-barcode-flow';
import { Button, buttonVariants } from '@/components/ui/button';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { ToastAction } from '@/components/ui/toast';
import { EmptyState } from '@/components/empty-state';
import { useToast } from '@/hooks/use-toast';
import { UNDO_WINDOW_MS } from '@/lib/undo-window';
import { useAuth } from '@/hooks/use-auth';
import { db, getLocalPersistence } from '@/lib/firebase';
import { slugify } from '@/lib/utils';
import { playFeedback } from '@/lib/feedback';
import { awaitWriteUnlessOffline, isBrowserOffline } from '@/lib/firestore-offline';
import { addItemsToList, type AddEntry, type CategorizationReport, type EntryOutcome } from '@/lib/shopping/add-items';
import { categorizationNotice, createSubmissionGuard, dialogAfterSave, isPendingState, isSettledForInput, newSubmissionId, offlineTickNote, once, pendingSaveStatus, saveStateLabel, settledTickFollowUp, summarizeStates, tickFollowUp, trackWrite, type DialogDraft } from '@/lib/shopping/save-status';
import { scanToShoppingEntry, type ScanEntry } from '@/lib/shopping/scan';
import { currentItemForToggle } from '@/lib/shopping/scan-tick';
import { addScannedProduct, createScanAddGuard, dialogAfterScan, scanAddKey, withScanGuard } from '@/lib/shopping/scan-add';
import { lookupMiss } from '@/lib/barcode/lookup-outcome';
import { useLookupFeedback } from './barcode/use-lookup-feedback';
import { LookupMissNotice, useScanMiss } from './barcode/lookup-miss-notice';
import { ScanToTick } from './shopping/scan-to-tick';
import { TripHeader } from './shopping/trip-header';
import { TripNeededGroups } from './shopping/trip-needed-groups';
import { useTripMode } from './shopping/use-trip-mode';
import { neededFocusOrder, scopeToList, withSectionOpen, type ListScoped } from '@/lib/shopping/trip-mode';
import tripStyles from './shopping/trip-mode.module.css';
import { useLibraryPhotos } from '@/lib/barcode/use-library-photos';
import { rowPhoto } from '@/lib/shopping/row-photo';
import { getManagedBarcodeImagePath } from '@/lib/barcode-storage';
import { normalizeItemName, pluralize, restoreItemData, type QuickAddEntry } from '@/lib/shopping/items';
import { editUpdate, restoreDocument, restoreIfAbsent, untickUpdate } from '@/lib/shopping/item-writes';
import { notUndoneNotice, planTick, tickShoppingItem, undoShoppingTick, type TickCurrent } from '@/lib/shopping/tick';
import { localTicksWriteFailed, shoppingTickIO } from '@/lib/shopping/tick-firestore';
import {
  browserJournalStorage,
  dropJournal,
  fromJournalData,
  journalFor,
  newOpId,
  nextFocusId,
  planRemoveUndo,
  pushJournal,
  readJournal,
  remainingMs,
  toJournalData,
  type KnownItem,
  type UndoEntry,
} from '@/lib/shopping/undo';
import { attributionLabel } from '@/lib/shopping/attribution';
import { useMemberNames } from '@/lib/shopping/member-names';
import type { ItemEditChanges, ItemSaveResult } from '@/lib/shopping/edit';
import { countAllOnServer, countNeededOnServer, useLiveCategoryConfig, useLiveListCounts, useLiveListItems, useLiveShoppingLists, useLiveShoppingPreferences, useLiveStores } from '@/lib/shopping/live';
import { browserStorage, chooseOverviewList, neededAisleGroups, neededEmptyCopy, preferencesKnown, writeWait, writeWaitText, readLocalTicks, readRecentGrocery, rememberRecentGrocery, syncLocalTicks } from '@/lib/shopping/overview';
import { assignedStore, storesListed } from '@/lib/shopping/assigned-store';
import { clearIdsFor, deletionSettled, isListLinkMissing, isOpenListDeleted, listsConfirmed, quickAddDecision, type ClearTarget } from '@/lib/shopping/live-state';
import { useOnTabDeactivate } from './shopping/tab-activity';
import { deleteShoppingList } from '@/app/shopping/actions';
import { listTint } from '@/lib/shopping/list-style';
import { offerEmptyListDelete } from '@/lib/shopping/trip-plan';
import { deleteStillPurchasedItems } from '@/lib/shopping/item-transactions';
import type { ShoppingListItem, ShoppingList, BarcodeLibraryItem, PantryItem } from '@/lib/types';
import { BarcodeScanner } from './barcode-scanner';
import { ListCard } from './shopping/list-card';
import { ListCardsSkeleton } from './shopping/shopping-skeletons';
import { ListDialog, groceriesTemplateValues, type ListFormValues } from './shopping/list-dialog';
import { ShoppingOverview } from './shopping/shopping-overview';
import { ExpiringChips } from './shopping/expiring-chips';
import { CategoriesDialog } from './shopping/categories-dialog';
import { listSaveData, rejectedCreateView, shouldOpenCreatedList } from '@/lib/shopping/list-save';
import { listDialogVisible, rejectedDraftRestore } from '@/lib/shopping/save-line';
import { renderListIcon } from './shopping/list-icons';
import { ShoppingItemRow } from './shopping/shopping-item-row';
import { ItemEditSheet } from './shopping/item-edit-sheet';
import { UndoSnackbar, type SnackbarEntry } from './shopping/undo-snackbar';
import { CartIndicator } from './shopping/cart-indicator';
import { useCartFlight } from './shopping/cart-flight';
import { QuickAddBar, type QuickAddOutcome } from './shopping/quick-add-bar';
import { TripReceiptDialog } from './shopping/trip-receipt-dialog';
import { useTripFlow } from './shopping/use-trip-flow';
import { useInPageMorph } from './shopping/use-in-page-morph';
import { NumberTicker } from '@/components/motion/number-ticker';
import { StaggerItem } from '@/components/motion/stagger';
import { useReducedMotion } from '@/hooks/use-reduced-motion';
import { morphStyle, sharedId, staggerDelay } from '@/lib/motion';
import { ShortcutHint } from '@/components/ui/shortcut-hint';

const itemSchema = z.object({
  name: z.string().trim().min(1, 'Item name is required.').max(120, 'Keep the name under 120 characters.'),
  quantity: z.coerce.number<number>().int('Use a whole number.').min(1, 'Quantity must be at least 1.').max(999, 'Quantity must be 999 or less.'),
  category: z.string().optional(),
});

/** Tracks `navigator.onLine`; the pantry handoff is only offered online. */
function useOnline() {
  const [online, setOnline] = useState(true);
  useEffect(() => {
    const update = () => setOnline(!isBrowserOffline());
    update();
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, []);
  return online;
}

/** Entrance delay of one needed row, in walk order across the aisle groups (≤ 30 ms each, ≤ 400 ms total). */
const rowDelay = (groups: Array<{ items: unknown[] }>, groupIndex: number, itemIndex: number, total: number) => {
  const before = groups.slice(0, groupIndex).reduce((sum, group) => sum + group.items.length, 0);
  return (before + itemIndex) * staggerDelay(total);
};

const fallbackReasonText = (reason?: string) => reason === 'timeout'
  ? 'Automatic sorting timed out.'
  : reason === 'rate_limited'
    ? 'Automatic sorting is receiving too many requests.'
    : reason === 'configuration'
      ? 'Automatic sorting is not configured.'
      : 'Automatic sorting was unavailable.';

export function ShoppingListClient({
  selectedListId,
  onSelectList,
  onOpenPantry,
  quickAddRequested = false,
  onQuickAddHandled,
  pantryItems,
  onOpenPantryItem,
}: {
  /** The open list's id (from `?list=`), or null for the overview. */
  selectedListId: string | null;
  onSelectList: (listId: string | null) => void;
  /** Switches to the Pantry tab (used by the "View pantry" toast action). */
  onOpenPantry?: () => void;
  /** `?quickAdd=1` is in the URL (home-screen shortcut or an in-app link). */
  quickAddRequested?: boolean;
  /** Consumes the quick-add request (removes it from the URL), opening `listId` if given. */
  onQuickAddHandled?: (listId: string | null) => void;
  /** The pantry (the page's pantry listener), for the overview's expiring chips (SH-11c). */
  pantryItems?: readonly PantryItem[];
  /** Opens the Pantry Inventory tab on one item (an expiring chip). */
  onOpenPantryItem?: (itemId: string) => void;
}) {
  const { currentUser, permissions } = useAuth();
  const { toast, toastError } = useToast();
  const lookupFeedback = useLookupFeedback();
  // A miss from the scanner inside Add Item is shown in that dialog (a toast's
  // action would be unreachable behind the modal).
  const addScanMiss = useScanMiss();
  const canEdit = Boolean(permissions['shopping.edit']);
  const canDelete = Boolean(permissions['shopping.delete']);
  const online = useOnline();
  const cartFlight = useCartFlight();
  const reduced = useReducedMotion();
  // List card -> open list shared-element morph (H12); both live on /shopping.
  const listMorph = useInPageMorph();
  const { settle: settleListMorph } = listMorph;
  useEffect(() => {
    settleListMorph();
  }, [selectedListId, settleListMorph]);
  // The list whose rows already played their staggered entrance.
  const enteredRowsRef = useRef<string | null>(null);

  const householdId = currentUser?.householdId ?? null;
  // Live data (SH-1): the lists, the open list's items and categories, and the card
  // counts are listeners. Each is keyed by household (and list), so a list switch
  // or household change shows loading, never another list's items.
  const listsState = useLiveShoppingLists(householdId);
  const lists = listsState.value;
  const loading = listsState.status !== 'ready';
  // The overview shows the household's Grocery list inline (S8a, SH-11a): the
  // default from the shopping preferences, else the only Grocery list, else the
  // one this device used last; a switcher pick wins for this visit. The page's
  // one items and categories listener follows the open list, or on the overview
  // that Grocery list (so opening it from the overview re-reads nothing).
  const preferencesState = useLiveShoppingPreferences(householdId);
  const [pickedGrocery, setPickedGrocery] = useState<{ householdId: string; listId: string } | null>(null);
  const [recentGroceryId, setRecentGroceryId] = useState<string | null>(null);
  useEffect(() => {
    setRecentGroceryId(readRecentGrocery(browserStorage(), householdId));
  }, [householdId]);
  const overviewChoice = chooseOverviewList({
    lists,
    defaultListId: preferencesState.value.defaultGroceryListId,
    defaultKnown: preferencesKnown({
      status: preferencesState.status,
      fromCache: preferencesState.fromCache,
      offline: isBrowserOffline(),
      defaultListId: preferencesState.value.defaultGroceryListId,
    }),
    pickedId: pickedGrocery?.householdId === householdId ? pickedGrocery.listId : null,
    recentId: recentGroceryId,
  });
  const overviewList = selectedListId ? null : overviewChoice.list;
  const itemsListId = selectedListId ?? overviewList?.id ?? null;
  const itemsState = useLiveListItems(householdId, itemsListId);
  const categoriesState = useLiveCategoryConfig(householdId, itemsListId);
  const storesState = useLiveStores(householdId);
  const listItems = itemsState.value;
  const categoryConfig = categoriesState.value;
  const categories = categoryConfig.list;
  const loadingItems = Boolean(selectedListId) && (itemsState.status === 'loading' || categoriesState.status === 'loading');
  const counts = useLiveListCounts(householdId, lists.map((list) => list.id), selectedListId ?? '');
  // Rows show the Barcode Library's current photo for scanned items (one source of truth).
  const libraryPhotos = useLibraryPhotos(householdId);
  const photoFor = (item: ShoppingListItem) => rowPhoto(item, libraryPhotos,
    (url) => Boolean(householdId && getManagedBarcodeImagePath({ householdId, imageUrl: url })));

  const [isAddItemDialogOpen, setIsAddItemDialogOpen] = useState(false);
  const [isScannerOpen, setIsScannerOpen] = useState(false);
  // A scan from inside Add Item that is not confirmed yet (or refused as a repeat
  // of one still being added), shown under the form like the typed add's status.
  const [scanStatus, setScanStatus] = useState<{ key: string; text: string } | null>(null);
  const [isListDialogOpen, setIsListDialogOpen] = useState(false);
  const [listToEdit, setListToEdit] = useState<ShoppingList | null>(null);
  // A list form whose save was rejected, shown again (`rejectedDraftRestore`).
  const [listDraft, setListDraft] = useState<ListFormValues | null>(null);
  const isListDialogOpenRef = useRef(false);
  isListDialogOpenRef.current = isListDialogOpen;
  // The lists as shown now (read when a list save is rejected later).
  const listsRef = useRef<ShoppingList[]>([]);
  // Counts list creations; only the latest one opens its list when saved.
  const createRequestRef = useRef(0);
  // The list save, for the quick-add shortcut's "Create Groceries" toast action (SH-10h).
  const handleSaveListRef = useRef<((data: ListFormValues, id?: string) => Promise<void>) | null>(null);
  listsRef.current = lists;
  const [listToDelete, setListToDelete] = useState<ShoppingList | null>(null);
  const [isClearAlertOpen, setIsClearAlertOpen] = useState(false);
  // The "Delete empty list?" prompt's list (SH-3): cleared whenever the prompt closes.
  const [emptyList, setEmptyList] = useState<ShoppingList | null>(null);
  const [openSections, setOpenSections] = useState<string[]>(['needed']);
  const [isReceiptOpen, setIsReceiptOpen] = useState(false);
  // The purchased items shown when Clear was pressed, with the household and list
  // they came from: exactly those are cleared, even if the live list changes while
  // the dialog is open, and never on another list (`clearIdsFor`).
  const [clearTarget, setClearTarget] = useState<ClearTarget | null>(null);
  const clearIds = clearIdsFor(clearTarget, householdId, selectedListId) ?? [];
  // The list this device is deleting, so its own deletion never reads as "deleted elsewhere".
  const [deletingListId, setDeletingListId] = useState<string | null>(null);
  // The open list as last seen in this household's lists snapshot (shown when it is
  // deleted elsewhere). Scoped by household, so another household's list never shows.
  const [seen, setSeen] = useState<{ householdId: string; list: ShoppingList } | null>(null);
  const uid = currentUser?.uid ?? null;
  // Display names for "Sam added · 2d" (SH-28b); never emails.
  const memberNames = useMemberNames(householdId);
  // The item whose edit sheet is open (SH-8a/b), by id so the sheet follows live changes.
  const [editingItemId, setEditingItemId] = useState<string | null>(null);
  // The Undo snackbar's entries (one per group), mirrored in the journal.
  const [undoEntries, setUndoEntries] = useState<UndoEntry[]>([]);
  // Where focus goes when the edit sheet closes after a delete (a checkbox id; '' = the cart).
  const focusAfterSheetRef = useRef<string | null>(null);
  // The item whose Edit control (or long-press) opened the sheet: Save, Escape and
  // Close return focus to that row's Edit control (the sheet has no DialogTrigger).
  const editOpenerRef = useRef<string | null>(null);
  const itemsReadyRef = useRef(false);
  // Row ids in screen order, per section (for focus after a tick or delete).
  const rowOrderRef = useRef<{ needed: string[]; purchased: string[] }>({ needed: [], purchased: [] });
  // "2d" in attributions; refreshed every minute.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  // After a reload (or a sign-in or household switch), re-offer what is left of
  // this member's Undo windows in this household (SH-15, UNDO-10s).
  useEffect(() => {
    setUndoEntries(journalFor(readJournal(browserJournalStorage(), Date.now()), uid, householdId));
  }, [uid, householdId]);
  // Each Undo leaves when its window ends (timed from when it was scheduled, so a
  // frozen clock cannot keep it forever).
  useEffect(() => {
    if (undoEntries.length === 0) return;
    const start = Date.now();
    const delay = Math.max(50, Math.min(...undoEntries.map((entry) => remainingMs(entry, start))));
    const timer = window.setTimeout(() => {
      const deadline = start + delay + 50;
      setUndoEntries((current) => current.filter((entry) => entry.expiresAt > deadline));
    }, delay);
    return () => window.clearTimeout(timer);
  }, [undoEntries]);

  // Every portaled overlay of this tab closes when the tab is hidden (a tab click or
  // browser Back to `?tab=pantry`), so none stays on screen or traps focus there.
  const tabActive = useOnTabDeactivate(() => {
    setIsAddItemDialogOpen(false);
    setIsScannerOpen(false);
    setIsListDialogOpen(false);
    setListToDelete(null);
    setIsClearAlertOpen(false);
    setEmptyList(null);
    setIsReceiptOpen(false);
    setEditingItemId(null);
  });

  // Dialogs and sheets of the open list belong to that opening of it: leaving it
  // (Back to all lists, browser Back with one open, another list) closes them all,
  // so none reopens when a list opens next. Their state lives here, above the open
  // list, so it is reset in the render that sees the change. The one exception is
  // Add Item opened by the quick-add shortcut for the list being opened
  // (`addItemFor`), which must survive that list's arrival.
  const [shownListId, setShownListId] = useState(selectedListId);
  const [addItemFor, setAddItemFor] = useState<string | null>(null);
  if (shownListId !== selectedListId) {
    setShownListId(selectedListId);
    if (addItemFor !== selectedListId || selectedListId === null) setIsAddItemDialogOpen(false);
    setAddItemFor(null);
    setIsScannerOpen(false);
    setIsClearAlertOpen(false);
    setEmptyList(null);
    setIsReceiptOpen(false);
    setEditingItemId(null);
  }

  // The Add Item scanner is nested in the Add Item dialog: it never outlives it
  // (otherwise reopening Add Item would bring the camera back).
  if (!isAddItemDialogOpen && isScannerOpen) setIsScannerOpen(false);
  if (!isAddItemDialogOpen && addScanMiss.scanMiss) addScanMiss.clear();
  if (!isAddItemDialogOpen && scanStatus) setScanStatus(null);

  const offlineNoticeShownRef = useRef(false);
  const selectedListIdRef = useRef<string | null>(null);
  // The list the items listener follows: the open list, or the overview's Grocery list.
  const itemsListIdRef = useRef<string | null>(null);
  itemsListIdRef.current = itemsListId;
  // Ticks made on this device: they are never "someone is shopping" (SH-28c).
  // Kept in device storage for the activity window, so a reload or a return to
  // /shopping still knows them (`shoppingTickIO` records every tick of the shared path,
  // the dashboard tile's too).
  const localPurchaseOpsRef = useRef<Set<string>>(new Set());
  const [localTicksVersion, setLocalTicksVersion] = useState(0);
  // Re-read on a list switch, every minute (pruning) and after each own tick.
  const localTicks = useMemo(
    () => readLocalTicks(browserStorage(), householdId, itemsListId, now),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [householdId, itemsListId, now, localTicksVersion],
  );
  // Each items snapshot settles this device's own ticks on that list: a pending one
  // whose server purchasedAt has arrived starts ageing (also after a reload, when no
  // write promise is left), and one whose purchase is gone is dropped (`syncLocalTicks`).
  const itemsForSync = itemsState.status === 'ready' ? itemsState.value : null;
  useEffect(() => {
    if (!itemsForSync) return;
    if (syncLocalTicks(browserStorage(), householdId, itemsListId, itemsForSync, Date.now())) setLocalTicksVersion((version) => version + 1);
  }, [itemsForSync, householdId, itemsListId]);
  // Overview writes wait until the listener follows the target list and has answered (`overviewWriteReady`).
  const itemsStatusRef = useRef(itemsState.status);
  itemsStatusRef.current = itemsState.status;
  const categoriesStatusRef = useRef(categoriesState.status);
  categoriesStatusRef.current = categoriesState.status;
  const writeWaitFor = (listId: string | null | undefined) => writeWait({
    targetListId: listId,
    itemsListId: itemsListIdRef.current,
    itemsStatus: itemsStatusRef.current,
    categoriesStatus: categoriesStatusRef.current,
  });
  // Adds and ticks need the items from a snapshot: a listener that failed before
  // its first one leaves them unknown, and merges would be missed (duplicates).
  const writeReadyFor = (listId: string | null | undefined) => writeWaitFor(listId) === null;
  const householdIdRef = useRef<string | null>(null);
  const listItemsRef = useRef<ShoppingListItem[]>([]);
  const purchasedSectionRef = useRef<HTMLDivElement>(null);

  const selectedList = useMemo(() => lists.find((list) => list.id === selectedListId) ?? null, [lists, selectedListId]);
  // Opening a Grocery list makes it this device's most recently used one (the overview's fallback).
  const openGroceryId = selectedList?.type === 'Grocery' ? selectedList.id : null;
  useEffect(() => {
    if (!openGroceryId || !householdId) return;
    rememberRecentGrocery(browserStorage(), householdId, openGroceryId);
    setRecentGroceryId(openGroceryId);
  }, [openGroceryId, householdId]);
  if (selectedList && householdId && (seen?.list !== selectedList || seen.householdId !== householdId)) setSeen({ householdId, list: selectedList });
  const seenList = seen && seen.householdId === householdId ? seen.list : null;
  const listIds = useMemo(() => lists.map((list) => list.id), [lists]);
  // The marker covers only the deletion in flight: once this device has left the
  // list and the snapshot no longer holds it, it is cleared.
  if (deletionSettled({ deletingListId, selectedListId, listIds })) setDeletingListId(null);
  // Deleted while open (here: by another member or device): the list's document is
  // gone from the snapshot. Its screen says so and offers no write controls (SH-1e).
  const deletedList = isOpenListDeleted({
    listId: selectedListId,
    seenListId: seenList?.id ?? null,
    listIds,
    listsReady: !loading,
    deletingListId,
  }) ? seenList : null;
  // After the first render of a loaded list, later rows (added, re-sorted) enter without the stagger.
  useEffect(() => {
    if (!selectedListId) enteredRowsRef.current = null;
    else if (!loadingItems && selectedList) enteredRowsRef.current = selectedListId;
  });
  listItemsRef.current = listItems;
  itemsReadyRef.current = itemsState.status === 'ready';
  const editingItem = editingItemId ? listItems.find((listItem) => listItem.id === editingItemId) ?? null : null;
  // The item left (deleted here or elsewhere): the sheet closes and stays closed.
  useEffect(() => {
    if (editingItemId && itemsState.status === 'ready' && !editingItem) setEditingItemId(null);
  }, [editingItemId, editingItem, itemsState.status]);

  // The open list's id (from the URL), so async results for another list are never shown.
  selectedListIdRef.current = selectedListId;
  householdIdRef.current = householdId;

  const getListsCollectionRef = useCallback(() => {
    if (!householdId) return null;
    return collection(db, 'households', householdId, 'shopping-lists');
  }, [householdId]);

  // A listener that cannot load says so once (it keeps retrying with backoff).
  const reportedErrorRef = useRef<unknown>(null);
  useEffect(() => {
    const error = listsState.error ?? itemsState.error ?? categoriesState.error ?? storesState.error;
    if (!error || reportedErrorRef.current === error) return;
    reportedErrorRef.current = error;
    toastError(error, listsState.error ? 'Could not load shopping lists' : storesState.error && error === storesState.error ? 'Could not load stores' : 'Could not load list items');
  }, [listsState.error, itemsState.error, categoriesState.error, storesState.error, toastError]);

  useEffect(() => {
    setOpenSections(['needed']);
    setIsReceiptOpen(false);
    // A Clear confirmation belongs to the list it was opened on.
    setIsClearAlertOpen(false);
    setClearTarget(null);
  }, [selectedListId]);

  // A `?list=` link to a list that no longer exists falls back to the overview.
  // Decided from a snapshot the server confirmed (or, offline, from the cache), and
  // never for a list this screen saw (that one shows "This list was deleted").
  const confirmed = listsConfirmed({ listsReady: !loading, fromCache: listsState.fromCache, offline: isBrowserOffline() });
  const linkMissing = isListLinkMissing({
    listId: selectedListId,
    listIds,
    listsReady: !loading,
    fromCache: listsState.fromCache,
    offline: isBrowserOffline(),
  }) && !deletedList && deletingListId !== selectedListId;
  useEffect(() => {
    if (!linkMissing) return;
    onSelectList(null);
    toast({ title: 'List not found', description: 'That list was deleted or you no longer have access to it.' });
  }, [linkMissing, onSelectList, toast]);

  // The home-screen shortcut "Add to shopping" opens /shopping?quickAdd=1: open
  // the add-item dialog on the only list, or else on the first Grocery list.
  // The request comes from the URL on every render (useSearchParams), so it works
  // for a fresh load and for in-app navigation alike; handling it removes it.
  // Cached lists are drawn at once, but the one-shot choice waits for lists the
  // server confirmed (or the cache offline), so a cached Grocery list deleted
  // elsewhere is never opened and the request is not lost.
  const quickAdd = quickAddDecision({ requested: quickAddRequested, confirmed, canEdit, lists });
  const quickAddKind = quickAdd?.kind ?? null;
  const quickAddListId = quickAdd?.kind === 'open' ? quickAdd.listId : null;
  useEffect(() => {
    if (!quickAddKind || quickAddKind === 'wait') return;
    onQuickAddHandled?.(quickAddListId ?? selectedListId);
    if (quickAddKind === 'open') {
      setAddItemFor(quickAddListId);
      setIsAddItemDialogOpen(true);
    } else if (quickAddKind === 'choose') {
      toast({ title: 'Choose a list', description: 'Open the list you want, then tap Add Item.' });
    } else if (quickAddKind === 'empty') {
      // SH-10h: never a silent no-op. One tap creates a Groceries list and opens it.
      toast({
        title: 'No shopping lists yet',
        description: 'Create a Groceries list to add items to.',
        action: <ToastAction altText="Create a Groceries list" onClick={() => void handleSaveListRef.current?.(groceriesTemplateValues())}>Create Groceries</ToastAction>,
      });
    } else if (quickAddKind === 'read-only') {
      toast({ title: 'You can view the lists only', description: 'Ask a household admin for permission to edit shopping lists.' });
    }
  }, [quickAddKind, quickAddListId, onQuickAddHandled, selectedListId, toast]);

  // --- List CRUD ---

  // Creating a list opens it (SH-20a) once the write is saved, or queued and still
  // on its way; a refused write opens nothing. The toast says which (S2 save path).
  const handleSaveList = async (data: ListFormValues, id?: string) => {
    const listsCollection = getListsCollectionRef();
    if (!listsCollection) return;
    const listId = id || slugify(data.name);
    const failTitle = id ? `Could not save ${data.name.trim()}` : `Could not create ${data.name.trim()}`;
    // What was on screen at submit, so a slow save never pulls the member away
    // from a list they opened meanwhile, and only the latest creation opens.
    const request = id ? 0 : ++createRequestRef.current;
    const selectionAtSubmit = selectedListIdRef.current;
    // A rejected form (at once, or later when it was queued or slow) opens again
    // with what was submitted, unless the list dialog is in use again by then.
    const rejected = (error: unknown) => {
      toastError(error, failTitle);
      // A refused creation whose list is open (it was opened while the save was
      // still waiting) leaves that list for the overview, where its form returns.
      if (rejectedCreateView({ createdListId: id ? null : listId, openListId: selectedListIdRef.current }) === 'overview') onSelectList(null);
      const listGone = Boolean(id) && !listsRef.current.some((entry) => entry.id === id);
      const householdChanged = householdIdRef.current !== householdId;
      if (!rejectedDraftRestore({ dialogOpen: isListDialogOpenRef.current, listGone, householdChanged })) return;
      setListToEdit(id ? listsRef.current.find((entry) => entry.id === id) ?? null : null);
      setListDraft(data);
      setIsListDialogOpen(true);
    };
    // An edit is an update, so it fails on a list deleted meanwhile instead of
    // re-creating a partial list document; a create is a merge on a fresh id.
    const listRef = doc(listsCollection, listId);
    const tracked = await trackWrite(
      id ? updateDoc(listRef, listSaveData(data, { isNew: false, uid })) : setDoc(listRef, listSaveData(data, { isNew: true, uid }), { merge: true }),
      { kind: 'write', persistence: getLocalPersistence, offline: isBrowserOffline },
    );
    if (tracked.state === 'failed') {
      rejected(tracked.error);
      return;
    }
    const done = id ? 'List updated' : 'List created';
    toast({ title: tracked.state === 'saved' ? done : `${done}: ${saveStateLabel(tracked.state)}` });
    if (tracked.state !== 'saved') {
      void tracked.settled.then((final) => {
        if (final.state === 'failed') rejected(final.error);
      });
    }
    if (!id && shouldOpenCreatedList({
      request,
      latestRequest: createRequestRef.current,
      selectionAtSubmit,
      selectionNow: selectedListIdRef.current,
      householdAtSubmit: householdId,
      householdNow: householdIdRef.current,
    })) onSelectList(listId);
  };
  handleSaveListRef.current = handleSaveList;

  /**
   * Deletes a list for real (SH-9): the server action removes the list document,
   * its items and its categories in one recursive delete. It needs a connection.
   */
  const handleDeleteList = async (list: ShoppingList | null = listToDelete) => {
    if (!list || !householdId) return;
    if (isBrowserOffline()) {
      toast({ title: 'You are offline', description: 'Delete the list once you are back online.' });
      return;
    }
    setDeletingListId(list.id);
    try {
      const result = await deleteShoppingList({ ...(await getAiActionContext(householdId)), listId: list.id });
      if (!result.ok) {
        setDeletingListId(null);
        toast({ variant: 'destructive', title: 'Could not delete the list', description: result.message });
        return;
      }
      toast({ title: 'List deleted', description: `${list.name} and its items are gone.` });
      setListToDelete(null);
      if (selectedListIdRef.current === list.id) onSelectList(null);
    } catch (error) {
      setDeletingListId(null);
      toastError(error, 'Could not delete the list');
    }
  };

  // --- List Item CRUD ---

  const form = useForm<z.infer<typeof itemSchema>>({
    resolver: zodResolver(itemSchema),
    defaultValues: { name: '', quantity: 1, category: '' },
  });
  const { watch, setValue, getValues } = form;
  const currentQuantity = watch('quantity');

  // Which opening of Add Item this is and how often its draft changed, so a save
  // confirmed late never wipes or closes a newer draft (`dialogAfterSave`).
  const addDialogSessionRef = useRef(0);
  const addDraftRevisionRef = useRef(0);
  const addDialogOpenRef = useRef(false);
  addDialogOpenRef.current = isAddItemDialogOpen;
  useEffect(() => {
    addDialogSessionRef.current += 1;
  }, [isAddItemDialogOpen]);
  useEffect(() => {
    return form.subscribe({
      formState: { values: true },
      callback: () => {
        addDraftRevisionRef.current += 1;
      },
    });
  }, [form]);
  const currentDialogDraft = () => ({
    session: addDialogSessionRef.current,
    listId: selectedListIdRef.current,
    revision: addDraftRevisionRef.current,
  });
  // After a confirmed save: clear and close only what still belongs to it.
  const finishDialogSave = (submitted: DialogDraft) => {
    const { reset, close } = dialogAfterSave(submitted, { ...currentDialogDraft(), open: addDialogOpenRef.current });
    if (reset) form.reset({ name: '', quantity: 1, category: '' });
    if (close) setIsAddItemDialogOpen(false);
  };

  // One dialog submission at a time (SH-4c): a second Enter while it is sending is ignored.
  const dialogGuardRef = useRef(createSubmissionGuard());
  const [dialogStatus, setDialogStatus] = useState<string | null>(null);
  // A save that was still pending and later failed says so once.
  const reportLateFailure = useCallback((name: string, error: unknown) => {
    toastError(error, `Could not save ${name}`);
  }, [toastError]);

  /**
   * Adds entries to the open list through the shared save path (`addItemsToList`):
   * each saves at once with a remembered or local category, merges into a
   * still-needed item of the same name online, and is classified honestly
   * (save-status.ts). One batched AI call then sorts the `pending` ones; its late
   * answers only touch items that are unchanged and still on the active list.
   */
  const addEntries = async (
    entries: AddEntry[],
    { selectedCategory, libraryItem, barcode }: { selectedCategory?: string; libraryItem?: BarcodeLibraryItem | null; barcode?: string } = {},
    // The open list, or the overview's Grocery list (S8a, SH-11b).
    target: ShoppingList | null = selectedList,
  ): Promise<EntryOutcome[] | null> => {
    const list = target;
    if (!householdId || !list) return null;
    // Merges look only at the known items: never add against an unloaded or another list's items.
    if (!writeReadyFor(list.id)) return null;
    const { outcomes, categorization } = await addItemsToList({
      householdId,
      listId: list.id,
      uid: currentUser?.uid,
      entries,
      categories,
      knownItems: listItemsRef.current,
      selectedCategory,
      imageUrl: libraryItem?.imageUrl,
      barcode,
      active: () => ({ householdId: householdIdRef.current, listId: itemsListIdRef.current }),
      onLateError: reportLateFailure,
    });
    if (outcomes.some((outcome) => outcome.state !== 'failed')) playFeedback('add');
    void categorization.then(reportCategorization);
    // No re-read (SH-27a): the listener already shows whatever was saved.
    return outcomes;
  };

  // "Saved to Other" only for entries the server confirmed; the rest were only not sorted.
  const reportCategorization = (report: CategorizationReport) => {
    const notice = categorizationNotice(
      { savedNames: report.unavailable, unconfirmedNames: report.unconfirmed },
      fallbackReasonText(report.reason),
    );
    if (notice) toast(notice);
  };

  // Only what is known: "Saved, will sync" needs the durable cache to show the write.
  const reportAddResults = (outcomes: EntryOutcome[]) => {
    const done = outcomes.filter((outcome) => isSettledForInput(outcome.state));
    if (done.length === 0) return;
    const local = done.some((outcome) => outcome.state === 'stored-locally');
    if (done.length === 1) {
      const [result] = done;
      toast(local
        ? { title: 'Saved, will sync', description: `${result.name} is saved on this device and syncs when the connection is back.` }
        : result.merged
          ? { title: 'Quantity updated', description: `${result.name} was already on the list, so its quantity went up.` }
          : { title: 'Item Added', description: `${result.name} was added to the ${result.category} category.` });
    } else {
      const merged = done.filter((outcome) => outcome.merged).length;
      toast({
        title: local ? 'Saved, will sync' : `${pluralize(done.length, 'item')} added`,
        description: local
          ? `${pluralize(done.length, 'item')} saved on this device; they sync when the connection is back.`
          : merged > 0 ? `${pluralize(merged, 'item')} already on the list had the quantity raised.` : undefined,
      });
    }
  };

  // An add the open list refused because its items are not known yet (`writeWait`) says so.
  const sayWriteWait = () => {
    const list = selectedList;
    const wait = list ? writeWaitFor(list.id) : null;
    if (wait && list) toast({ title: 'Not added yet', description: writeWaitText(wait, list.name) });
  };

  const onAddItemSubmit = async (
    values: z.infer<typeof itemSchema>,
    extras: { libraryItem?: BarcodeLibraryItem | null; barcode?: string; size?: number; sizeUnit?: string } = {},
  ) => {
    const submissionId = newSubmissionId();
    const guard = dialogGuardRef.current;
    if (!guard.begin(submissionId)) return;
    const name = normalizeItemName(values.name);
    const submittedDraft = currentDialogDraft();
    let keepGuard = false;
    try {
      const outcomes = await addEntries(
        [{ name, quantity: values.quantity, size: extras.size, sizeUnit: extras.sizeUnit }],
        { selectedCategory: values.category, libraryItem: extras.libraryItem, barcode: extras.barcode },
      );
      if (!outcomes) {
        // Not a silent no-op: the dialog keeps its values and says why.
        sayWriteWait();
        return;
      }
      const [outcome] = outcomes;
      if (outcome.state === 'failed') {
        // Nothing was saved: keep the dialog and its values for a retry.
        setDialogStatus(null);
        toastError(outcome.error, 'Could not add the item');
        return;
      }
      if (isPendingState(outcome.state)) {
        // Not known yet: the values stay, Add stays blocked for this submission,
        // and the answer decides (other adds, such as quick add, keep working).
        keepGuard = true;
        setDialogStatus(pendingSaveStatus(outcome.state, outcome.name));
        void outcome.settled.then((final) => {
          guard.end(submissionId);
          setDialogStatus(null);
          if (final === 'saved') {
            // Reported even when the member has moved on to another draft or list.
            reportAddResults([{ ...outcome, state: 'saved' }]);
            finishDialogSave(submittedDraft);
          }
          // A late failure was reported by onLateError; the values are still in the dialog.
        });
        return;
      }
      setDialogStatus(null);
      reportAddResults(outcomes);
      finishDialogSave(submittedDraft);
    } catch (error) {
      toastError(error, 'Could not add the item');
    } finally {
      if (!keepGuard) guard.end(submissionId);
    }
  };

  // Saved entries are reported; failed ones go back into the field with an inline
  // message naming them (QuickAddBar), so a retry only adds what is missing.
  // Entries without an answer yet stay in a "Still sending" chip until they settle.
  const onQuickAdd = async (entries: QuickAddEntry[], target: ShoppingList | null = selectedList): Promise<QuickAddOutcome> => {
    try {
      const outcomes = await addEntries(entries, {}, target);
      if (!outcomes) return null;
      reportAddResults(outcomes);
      const failed = outcomes.filter((outcome) => outcome.state === 'failed').map((outcome) => outcome.entry);
      const pending = outcomes.filter((outcome) => isPendingState(outcome.state));
      if (pending.length === 0) return { failed };
      const pendingState = summarizeStates(pending.map((outcome) => outcome.state)) ?? 'sending';
      return {
        failed,
        pending: {
          entries: pending.map((outcome) => outcome.entry),
          label: saveStateLabel(pendingState),
          settled: Promise.all(pending.map(async (outcome) => ((await outcome.settled) === 'failed' ? outcome.entry : null)))
            .then((late) => late.filter((entry): entry is AddEntry => entry !== null)),
        },
      };
    } catch (error) {
      toastError(error, 'Could not add the items');
      return null;
    }
  };

  // A scan adds ONE package (BL-1): the package size is a note on the row, never the count.
  // It is its own submission: it uses the category chosen when the scan started,
  // never consumes or resets the typed draft, and closes only that same opening
  // of Add Item (`dialogAfterScan`). A save not confirmed in time shows the typed
  // add's "Still sending…" / "Checking…" line, and the scan stays outstanding until
  // it settles: scanning the same product on the same list again meanwhile (here
  // or through Scan to tick) is refused instead of queuing a second addition.
  const scanGuardRef = useRef(createScanAddGuard());
  const handleBarcodeScan = async (barcode: string) => {
    if (!currentUser?.householdId) return;
    const householdForLookup = currentUser.householdId;
    const started = currentDialogDraft();
    const category = getValues('category');
    const key = scanAddKey(started.listId, barcode);
    addScanMiss.clear();
    setIsScannerOpen(false);
    const inSameDialog = () => addDialogOpenRef.current && addDialogSessionRef.current === started.session;
    // Inline in the same opening of Add Item when it is still open, else a toast.
    const showMiss = (show: () => void, toastInstead: () => void) => {
      if (inSameDialog()) show();
      else toastInstead();
    };
    const showStatus = (text: string) => {
      if (inSameDialog()) setScanStatus({ key, text });
      else toast({ description: text });
    };
    const clearStatus = () => setScanStatus((current) => (current?.key === key ? null : current));
    await withScanGuard(scanGuardRef.current, key, async (notePending) => {
      toast({ title: 'Barcode scanned', description: 'Looking up the product…' });
      try {
        const result = unwrapAiActionResult(await lookupBarcode(
          { barcode },
          await getAiActionContext(householdForLookup)
        ));
        const entry = scanToShoppingEntry(result);
        const miss = result.libraryItem ? null : lookupMiss(result);
        if (entry && !miss) {
          const final = await addScannedProduct(entry, { libraryItem: result.libraryItem, barcode, selectedCategory: category }, {
            ...scanAddDeps,
            pending: (status) => {
              notePending(status);
              showStatus(status);
            },
          });
          if (final === 'saved' && dialogAfterScan(started, { ...currentDialogDraft(), open: addDialogOpenRef.current }).close) {
            setIsAddItemDialogOpen(false);
          }
        } else {
          // BL-9: "not found" keeps the code for "Save to library"; an outage says so.
          const found = miss ?? { kind: 'not-found' as const };
          showMiss(() => addScanMiss.reportMiss(found, barcode),
            () => lookupFeedback.reportMiss(found, barcode, { fallback: 'type the name instead', canSave: canEdit }));
        }
      } catch (error) {
        showMiss(() => addScanMiss.reportError(error, barcode),
          () => lookupFeedback.reportError(error, barcode, { fallback: 'type the name instead', canSave: canEdit }));
      } finally {
        clearStatus();
      }
    }, showStatus);
  };
  const scanAddDeps = {
    add: async (...args: Parameters<typeof addEntries>) => {
      const outcomes = await addEntries(...args);
      if (!outcomes) sayWriteWait();
      return outcomes;
    },
    report: reportAddResults,
    fail: (error: unknown) => toastError(error, 'Could not add the item'),
  };
  // Scan to tick's "Add": outside the Add Item form entirely (no draft, no category
  // from it); its pending status and a refused repeat are toasts.
  const addScannedEntry = (entry: ScanEntry, extras: { libraryItem?: BarcodeLibraryItem | null; barcode: string }) =>
    withScanGuard(scanGuardRef.current, scanAddKey(selectedListIdRef.current, extras.barcode), (notePending) =>
      addScannedProduct(entry, extras, {
        ...scanAddDeps,
        pending: (status) => {
          notePending(status);
          toast({ description: status });
        },
      }),
    (copy) => toast({ description: copy }),
    ).then(() => undefined, (error: unknown) => { toastError(error, 'Could not add the item'); });

  // --- Undo (S3: SH-15a/b, UNDO-10s) ---
  // One 10 s Undo per group (the latest tick, the latest delete), shown in the
  // snackbar above the quick-add bar. Each is journaled in localStorage, so a
  // reload re-offers what is left of its window; the Undo itself is an ordinary
  // queued write (works offline) that the rules accept only while nobody else has
  // changed the item meanwhile (purchaseOpId / restore-if-absent).
  const addUndo = useCallback((entry: UndoEntry) => {
    setUndoEntries((current) => [...current.filter((existing) => existing.group !== entry.group), entry]);
    pushJournal(browserJournalStorage(), entry, Date.now());
  }, []);
  const dropUndo = useCallback((opId: string) => {
    setUndoEntries((current) => current.filter((entry) => entry.opId !== opId));
    dropJournal(browserJournalStorage(), opId, Date.now());
  }, []);

  // What this screen knows about an Undo's item: from the open list's listener when
  // it is that list (null = gone), otherwise unknown (the rules decide).
  const knownItem = (entry: UndoEntry): KnownItem => {
    if (entry.householdId !== householdIdRef.current || entry.listId !== itemsListIdRef.current || !itemsReadyRef.current) return undefined;
    return listItemsRef.current.find((listItem) => listItem.id === entry.itemId) ?? null;
  };

  // Sends a write without waiting on a weak connection (at most ~4 s, not at all
  // offline); a rejection now or later goes to `onFail`.
  const sendWrite = async (write: Promise<unknown>, onFail: (error: unknown) => void) => {
    const tracked = await trackWrite(write, { kind: 'write', persistence: getLocalPersistence, offline: isBrowserOffline });
    if (tracked.state === 'failed') {
      onFail(tracked.error);
      return false;
    }
    if (isPendingState(tracked.state)) {
      void tracked.settled.then((final) => {
        if (final.state === 'failed') onFail(final.error);
      });
    }
    return true;
  };

  const notUndone = (name: string, error?: unknown) => {
    const notice = notUndoneNotice(name, error);
    if (notice) toast(notice);
    else toastError(error, `Could not undo ${name}`);
  };

  const undoTick = async (entry: UndoEntry) => {
    dropUndo(entry.opId);
    // The shared Undo (tick.ts, also the dashboard's): only the status and the purchase
    // stamps, never a copy of the item, accepted only while this tick's purchaseOpId stands.
    const started = undoShoppingTick(shoppingTickIO, {
      path: { householdId: entry.householdId, listId: entry.listId, itemId: entry.itemId },
      opId: entry.opId,
      known: knownItem(entry),
    });
    if (started.status === 'already') return;
    if (started.status === 'refused') {
      notUndone(entry.name);
      return;
    }
    if (entry.listId === selectedListIdRef.current) setIsReceiptOpen(false);
    await sendWrite(started.write, (error) => notUndone(entry.name, error));
    focusRowWhenShown(`item-needed-${entry.itemId}`);
  };

  const undoRemove = async (entry: UndoEntry) => {
    if (entry.group !== 'shopping-remove') return;
    dropUndo(entry.opId);
    // Re-created only if absent: an item that is back already is left alone (and
    // the rules refuse a restore over an existing item).
    if (planRemoveUndo(knownItem(entry)) === 'already') return;
    const itemRef = doc(db, 'households', entry.householdId, 'shopping-lists', entry.listId, 'items', entry.itemId);
    const data = fromJournalData(entry.data);
    if (isBrowserOffline()) {
      // Queued; the rules accept it only as a create (restoredAt makes a replay a refused update).
      await sendWrite(setDoc(itemRef, restoreDocument(data)), (error) => notUndone(entry.name, error));
    } else {
      // Online, a transaction: re-created only if the item is still absent.
      try {
        const result = await restoreIfAbsent(db, itemRef, data);
        if (result === 'exists') return;
      } catch (error) {
        notUndone(entry.name, error);
        return;
      }
    }
    focusRowWhenShown(`item-${entry.data.status === 'purchased' ? 'purchased' : 'needed'}-${entry.itemId}`);
  };

  // --- Focus (SH-26a) ---
  // After a tick or delete the row leaves; focus goes to the next row of the same
  // section (else the previous one, else the cart), never to <body>.
  const focusRowWhenShown = (checkboxId: string | null, attempts = 10) => {
    requestAnimationFrame(() => {
      const target = checkboxId ? document.getElementById(checkboxId) : null;
      if (target) {
        target.focus({ preventScroll: true });
        return;
      }
      if (attempts > 0 && checkboxId) {
        focusRowWhenShown(checkboxId, attempts - 1);
        return;
      }
      if (checkboxId) return;
      // No row left to focus. While the open list's find field holds text (a filter
      // whose last match was just ticked), back to that field; otherwise the cart
      // (or the overview's focus target).
      const findField = document.querySelector<HTMLInputElement>('[data-testid="open-list"] form[aria-label^="Quick add to "] input');
      if (findField?.value.trim()) {
        findField.focus({ preventScroll: true });
        return;
      }
      document.querySelector<HTMLElement>('[data-testid="open-list"] [data-testid="cart-indicator"], [data-testid="grocery-overview"] [data-overview-focus]')?.focus({ preventScroll: true });
    });
  };
  const nextRowFocusId = (item: ShoppingListItem) => {
    const section = item.status === 'purchased' ? 'purchased' : 'needed';
    const next = nextFocusId(rowOrderRef.current[section], item.id);
    return next ? `item-${section}-${next}` : null;
  };
  // Moves focus only when it was on this row (or nowhere), so a tick never steals
  // focus from a field the member is typing in.
  const moveFocusAfter = (item: ShoppingListItem) => {
    const active = document.activeElement;
    const row = document.querySelector(`[data-row-id="${CSS.escape(item.id)}"]`);
    if (active && active !== document.body && !(row && row.contains(active))) return;
    focusRowWhenShown(nextRowFocusId(item));
  };

  // `target`: the open list, or the overview's Grocery list (S8a: the same tick and Undo).
  const toggleItemStatus = async (staleItem: ShoppingListItem, target: ShoppingList | null = selectedList) => {
      if (!householdId || !target) return;
      // Decide from the listener's latest copy, never a stale one (a scan's lookup,
      // an old render): ticking an item someone else already bought would overwrite
      // their purchasedByUid, time and purchaseOpId (and void their Undo).
      const item = currentItemForToggle(staleItem, listItemsRef.current);
      if (!item) return;

      const isCheckingOff = item.status === 'needed';
      const newStatus = isCheckingOff ? 'purchased' : 'needed';
      const list = target;
      // The write always targets the item's own list; the screen is only touched while
      // that list is still the open one.
      const isListOpen = () => selectedListIdRef.current === list.id;
      // The item as the open list's listener shows it now (not as the row last rendered
      // it): a tick never lands on an item already purchased (or deleted) meanwhile.
      // (On the overview the listener follows the overview's Grocery list.)
      const current: TickCurrent = itemsListIdRef.current === list.id && itemsReadyRef.current
        ? listItemsRef.current.find((listItem) => listItem.id === item.id) ?? null
        : item;
      if (isCheckingOff && planTick(current) !== 'tick') return;
      const lastNeeded = isCheckingOff && isListOpen()
        && listItemsRef.current.filter(listItem => listItem.status === 'needed' && listItem.id !== item.id).length === 0;
      // A rejected write is rolled back by Firestore in the listener, so the screen
      // settles on the confirmed state (also when several ticks queued offline are
      // rejected together); only the toast is left to do here.
      const failToggle = () => {
        toast({ variant: 'destructive', title: 'Error', description: 'Could not update item status.' });
        // The receipt was opened optimistically on the last tick; a rejected tick
        // means the trip is not complete after all.
        if (isListOpen()) setIsReceiptOpen(false);
      };

      // Into the cart (H07): a copy of the name flies from the row (measured before
      // the row leaves) into the cart icon; skipped under reduced motion.
      if (isCheckingOff && isListOpen()) {
        const row = document.querySelector(`[data-testid="shopping-item-${CSS.escape(item.id)}"]`);
        cartFlight.launch(row?.querySelector('[data-item-name]') ?? row ?? null, item.name);
      }
      moveFocusAfter(item);

      // A tick is the shared operation (tick.ts, also used by the dashboard): its buyer,
      // the server's time and a fresh purchaseOpId (the one its Undo must match);
      // un-ticking from Purchased clears the purchase. The listener shows the write at
      // once; offline it waits in Firestore's queue and syncs when the connection returns.
      // `shoppingTickIO` also records the tick in this device's local-ticks store (SH-28c).
      const itemRef = doc(db, 'households', householdId, 'shopping-lists', list.id, 'items', item.id);
      const ticked = isCheckingOff
        ? tickShoppingItem(shoppingTickIO, { path: { householdId, listId: list.id, itemId: item.id }, uid, current })
        : null;
      if (ticked && ticked.status !== 'ticked') return;
      const purchaseOpId = ticked ? ticked.opId : null;
      if (purchaseOpId) {
        localPurchaseOpsRef.current.add(purchaseOpId);
        setLocalTicksVersion((version) => version + 1);
      }
      const write = ticked ? ticked.write : updateDoc(itemRef, untickUpdate());

      // Ticking never leaves the list: the pantry is offered at the end of the trip
      // (receipt) or when clearing purchased items, never per tick.
      if (isCheckingOff) playFeedback('complete');

      if (isBrowserOffline()) {
        // Offline the cache is all there is, so "list done" is judged from it.
        if (lastNeeded) {
          playFeedback('celebrate');
          setIsReceiptOpen(true);
        }
        write.catch(failToggle);
        // The first offline tick carries the offline note in its Undo (SH-7c); the
        // note says "saved on this device" only when the durable cache shows it.
        const firstOffline = !offlineNoticeShownRef.current;
        offlineNoticeShownRef.current = true;
        const stored = firstOffline && await (ticked ? ticked.storedLocally() : tickStoredLocally(itemRef, newStatus));
        const note = firstOffline ? offlineTickNote(stored) : undefined;
        if (purchaseOpId) showTickUndo(item, list.id, purchaseOpId, note);
        else if (note) toast({ title: 'You are offline', description: note });
        return;
      }

      if (purchaseOpId) showTickUndo(item, list.id, purchaseOpId);

      // Online, a weak signal can leave the write unanswered; the listener already
      // shows it, so only a rejection (now or later) is reported.
      const tracked = ticked ? await ticked.track() : await trackWrite(write, {
        kind: 'write',
        persistence: getLocalPersistence,
        offline: isBrowserOffline,
      });
      // Online, "trip complete" is decided by the server (another member may have
      // added an item a moment ago): one count query, not a re-read of the list.
      // It runs once the tick is acknowledged, also when that happens after the
      // timeout on a weak connection (never twice: `once`).
      const checkTripComplete = once(async () => {
        if (!isCheckingOff || !isListOpen()) return;
        const stillNeeded = await countNeededOnServer(householdId, list.id).catch(() => null);
        if (stillNeeded === 0 && isListOpen()) {
          playFeedback('celebrate');
          setIsReceiptOpen(true);
        }
      });
      const plan = tickFollowUp(tracked.state);
      if (plan === 'fail') {
        failToggle();
        return;
      }
      if (plan === 'check-after-settle') {
        void tracked.settled.then((final) => {
          if (settledTickFollowUp(final.state) === 'fail') failToggle();
          else void checkTripComplete();
        });
        return;
      }
      await checkTripComplete();
  };

  // Whether the durable cache already shows a tick queued offline.
  const tickStoredLocally = async (itemRef: DocumentReference, status: ShoppingListItem['status']) => {
    if (getLocalPersistence() !== 'durable') return false;
    try {
      const cached = await getDocFromCache(itemRef);
      return cached.exists() && cached.get('status') === status;
    } catch {
      return false;
    }
  };

  // "Milk is in the cart · Undo" for 10 seconds after a tick (replacing the
  // previous tick's Undo); the first offline tick adds the offline note.
  const showTickUndo = (item: ShoppingListItem, listId: string, purchaseOpId: string, note?: string) => {
    if (!uid || !householdId) return;
    addUndo({
      group: 'shopping-tick',
      uid,
      householdId,
      listId,
      itemId: item.id,
      name: item.name,
      opId: purchaseOpId,
      expiresAt: Date.now() + UNDO_WINDOW_MS,
      ...(note ? { note } : {}),
    });
  };

  // Deletes at once (from the edit sheet), with 10 seconds to undo: the Undo
  // re-creates the item only if it is absent, as it was read (keeping who added
  // it), with restoredByUid = the restorer and a fresh restoreOpId. The listener
  // removes and restores the row; a rejected write is rolled back there.
  const deleteItem = async (item: ShoppingListItem) => {
    const list = selectedList;
    if (!householdId || !list) return;
    focusAfterSheetRef.current = nextRowFocusId(item) ?? '';
    setEditingItemId(null);
    const itemRef = doc(db, 'households', householdId, 'shopping-lists', list.id, 'items', item.id);
    try {
      await awaitWriteUnlessOffline(deleteDoc(itemRef), (error) => {
        toastError(error, `Could not delete ${item.name}`);
      });
    } catch (error) {
      toastError(error, `Could not delete ${item.name}`);
      return;
    }
    if (!canEdit || !uid) {
      toast({ title: `${item.name} removed` });
      return;
    }
    const { id: _id, ...snapshot } = item;
    void _id;
    const restoreOpId = newOpId();
    addUndo({
      group: 'shopping-remove',
      uid,
      householdId,
      listId: list.id,
      itemId: item.id,
      name: item.name,
      opId: restoreOpId,
      expiresAt: Date.now() + UNDO_WINDOW_MS,
      data: toJournalData(restoreItemData(snapshot, uid, restoreOpId)),
    });
  };

  // An edit from the sheet (SH-8a): only the changed fields, signed with
  // editedByUid and the server's editedAt. The sheet closes only once the edit is
  // acknowledged or verified in the durable cache (`stored-locally`); otherwise it
  // keeps the draft until the final answer. A rejection, now or later, is a toast.
  const saveItemEdit = async (item: ShoppingListItem, changes: ItemEditChanges): Promise<ItemSaveResult> => {
    const list = selectedList;
    if (!householdId || !list || !uid) return { state: 'failed', settled: Promise.resolve('failed') };
    const itemRef = doc(db, 'households', householdId, 'shopping-lists', list.id, 'items', item.id);
    const label = `Could not save ${changes.name ?? item.name}`;
    const tracked = await trackWrite(updateDoc(itemRef, editUpdate(uid, changes)), {
      kind: 'write',
      persistence: getLocalPersistence,
      offline: isBrowserOffline,
      cacheReflectsWrite: async () => {
        const cached = await getDocFromCache(itemRef);
        return cached.exists() && Object.entries(changes).every(([key, value]) => cached.get(key) === value);
      },
    });
    if (tracked.state === 'failed') toastError(tracked.error, label);
    const settled = tracked.settled.then((final) => {
      if (final.state === 'failed' && tracked.state !== 'failed') toastError(final.error, label);
      return final.state;
    });
    return { state: tracked.state, settled };
  };

  const openEditor = (item: ShoppingListItem) => {
    focusAfterSheetRef.current = null;
    editOpenerRef.current = item.id;
    setEditingItemId(item.id);
  };

  // Back to the Edit control of the row that opened the sheet (it may re-render, for
  // example under a new category heading, so it is found again by row id). If the row
  // is gone (deleted elsewhere meanwhile), focus goes to the cart, never to <body>.
  const focusEditControlWhenShown = (itemId: string, attempts = 10) => {
    requestAnimationFrame(() => {
      const target = document.querySelector<HTMLElement>(`[data-row-id="${CSS.escape(itemId)}"] [data-edit-control]`);
      if (target) {
        target.focus({ preventScroll: true });
        return;
      }
      if (attempts > 0) focusEditControlWhenShown(itemId, attempts - 1);
      else focusRowWhenShown(null);
    });
  };

  const attributionFor = (item: ShoppingListItem) => attributionLabel({
    addedByUid: item.addedByUid,
    createdAt: item.createdAt,
    currentUid: uid,
    names: memberNames,
    now,
  });

  // The dialogs the open list's actions menu opens have no trigger of their own:
  // when one closes, focus goes back to the menu button (S8b), never to the page.
  const focusListMenu = (event: Event) => {
    const button = document.querySelector<HTMLElement>('[data-testid="open-list"] [data-testid="list-actions-menu"]');
    if (!button) return;
    event.preventDefault();
    button.focus({ preventScroll: true });
  };

  // After-trip flow (S5): receipt choice, put away, trip Undo, usual chips, history.
  const tripFlow = useTripFlow({
    householdId,
    uid,
    list: selectedList,
    purchasedItems: listItems.filter((item) => item.status === 'purchased'),
    neededItems: listItems.filter((item) => item.status === 'needed'),
    canEdit,
    canDelete,
    online,
    now,
    memberNames,
    addUndo,
    dropUndo,
    // Called after the put-away resolves, so `afterCleared` (below) is defined by then.
    onCleared: (listId) => {
      const list = lists.find((entry) => entry.id === listId);
      if (list) void afterCleared(list);
    },
    onOpenPantry,
    onQuickAdd,
    closeReceipt: () => setIsReceiptOpen(false),
    historyCloseAutoFocus: (event) => focusListMenu(event),
  });

  const snackbarEntries: SnackbarEntry[] = undoEntries.map((entry) => entry.group === 'shopping-trip'
    ? tripFlow.snackbarEntry(entry)
    : entry.group === 'shopping-tick'
    ? {
      key: entry.opId,
      message: `${entry.name} is in the cart`,
      note: entry.note,
      undoLabel: `Undo ticking ${entry.name}`,
      onUndo: () => void undoTick(entry),
      onDismiss: () => dropUndo(entry.opId),
    }
    : {
      key: entry.opId,
      message: `${entry.name} removed`,
      undoLabel: `Undo removing ${entry.name}`,
      onUndo: () => void undoRemove(entry),
      onDismiss: () => dropUndo(entry.opId),
    });

  /**
   * Deletes exactly `itemIds` (the purchased items the member confirmed, captured
   * when they pressed Clear), never "whatever is purchased now": an item ticked
   * while the dialog or the batch is pending stays. Afterwards only those ids leave
   * the screen, and "the list is empty, delete it?" is decided from a re-read of
   * the list (the confirmed state), not from a local status filter.
   */
  const clearPurchasedItems = async (target: ClearTarget | null) => {
    setIsClearAlertOpen(false);
    setClearTarget(null);
    if (!householdId || !selectedList) return;
    // Only clear the list that is on screen, and only with ids captured from it:
    // a confirmation left over from another list (or household) does nothing.
    if (selectedListIdRef.current !== selectedList.id) return;
    const itemIds = clearIdsFor(target, householdId, selectedList.id);
    if (!itemIds) return;
    const list = selectedList;
    const ids = [...new Set(itemIds)];
    if (ids.length === 0) {
      toast({ title: 'Nothing to clear' });
      return;
    }
    // Deleting from a stale status could remove an item another member un-ticked, so
    // clearing needs the server: it runs in a transaction that deletes only the ids
    // that are still purchased.
    if (isBrowserOffline()) {
      toast({ title: 'You are offline', description: 'Clear purchased items once you are back online.' });
      return;
    }
    try {
      const deleted = await deleteStillPurchasedItems(householdId, list.id, ids);
      toast({ title: deleted.length === ids.length ? 'Purchased items cleared' : `${pluralize(deleted.length, 'item')} cleared`, description: deleted.length === ids.length ? undefined : 'Items changed by someone else meanwhile were left on the list.' });
      await afterCleared(list);
    } catch (error) {
      toastError(error, 'Could not clear purchased items');
    }
  };

  // After a confirmed clear (the listener drops the deleted rows): "empty" is
  // decided by the server with one count query. Leaves another list's screen alone.
  const afterCleared = async (list: ShoppingList) => {
    if (selectedListIdRef.current !== list.id || !householdId) return;
    setIsReceiptOpen(false);
    // Never offered for Grocery lists (SH-3a): the weekly list is reused.
    if (list.type === 'Grocery') return;
    const remaining = await countAllOnServer(householdId, list.id).catch(() => null);
    if (offerEmptyListDelete(list.type, remaining) && selectedListIdRef.current === list.id) setEmptyList(list);
  };

  const archiveList = async () => {
    const list = emptyList;
    setEmptyList(null);
    await handleDeleteList(list);
  };

  const openClear = () => {
    if (!householdId || !selectedListId) return;
    setClearTarget({
      householdId,
      listId: selectedListId,
      ids: listItemsRef.current.filter(item => item.status === 'purchased').map(item => item.id),
    });
    setIsClearAlertOpen(true);
  };

  const adjustQuantity = (amount: number) => {
    const currentVal = Number(getValues('quantity')) || 1;
    const newVal = Math.min(999, Math.max(1, currentVal + amount));
    setValue('quantity', newVal, { shouldValidate: true });
  };

  const openPurchased = () => {
    setOpenSections(prev => (prev.includes('purchased') ? prev : [...prev, 'purchased']));
    requestAnimationFrame(() => purchasedSectionRef.current?.scrollIntoView({ block: 'nearest' }));
  };

  // Trip mode on the open list (S8b): the compact header's "n left" and aisle
  // chips, find-or-add, the wake lock on phones; the menu opens these dialogs.
  const trip = useTripMode({
    listId: selectedList?.id ?? null,
    active: tabActive,
    items: listItems,
    config: categoryConfig,
    store: selectedList ? assignedStore(selectedList.storeId, storesState).store : null,
  });
  // The dialog the actions menu opened, for this opening of this list only: going
  // back to all lists (also by browser Back) or to another list drops it, so it
  // never reopens on the next list (nor restarts the camera).
  const [listDialogState, setListDialogState] = useState<ListScoped<'scan' | 'categories' | null>>({ listId: selectedListId, value: null });
  const scopedListDialog = scopeToList(listDialogState, selectedListId, null);
  if (scopedListDialog !== listDialogState) setListDialogState(scopedListDialog);
  const listDialogOpen = scopedListDialog.value;
  const setListDialogOpen = (value: 'scan' | 'categories' | null) => setListDialogState({ listId: selectedListId, value });

  // --- Render Logic ---

  // The same skeleton as the route and the page (SH-25a); later snapshots never
  // bring it back (SH-25c).
  if (loading) {
    return (
      <div role="status" aria-label="Loading shopping lists">
        <ListCardsSkeleton />
      </div>
    );
  }

  // The list form (create and edit) is rendered on every screen below, so a
  // rejected form can open again wherever the member is.
  const listDialog = (
    <ListDialog
      isOpen={listDialogVisible({ open: isListDialogOpen, tabActive })}
      onOpenChange={(open) => {
        setIsListDialogOpen(open);
        if (!open) setListDraft(null);
      }}
      draft={listDraft}
      onSave={handleSaveList}
      listToEdit={listToEdit}
      lists={lists}
      onOpenList={(listId) => onSelectList(listId)}
    />
  );

  // The open list was deleted elsewhere: say so, with the way back and nothing to write with.
  if (deletedList) {
    return (
      <>
      {listDialog}
      <div className="rounded-xl border bg-card text-card-foreground shadow-raised" data-testid="open-list" data-list-deleted="true">
        <div className="p-4 sm:p-6">
          <Button variant="ghost" onClick={() => onSelectList(null)} className="mb-3 pl-1">
            <ArrowLeft className="mr-2" aria-hidden /> Back to all lists
          </Button>
          <h2 className="min-w-0 break-words font-headline text-2xl font-semibold leading-tight">{deletedList.name}</h2>
          <EmptyState
            compact
            kind="lists"
            headingLevel={3}
            title="This list was deleted"
            description="Someone in your household deleted this list, its items and its categories. Nothing more can be added or ticked here."
            className="mt-4"
          />
        </div>
        {snackbarEntries.length > 0 && <UndoSnackbar floating entries={snackbarEntries} />}
      </div>
      </>
    );
  }

  // View for showing the selected list's items
  if (selectedList) {
    const listMorphName = sharedId('list', selectedList.id);
    const staggerRows = !reduced && !loadingItems && enteredRowsRef.current !== selectedList.id;
    const neededItems = listItems.filter(i => i.status === 'needed');
    const purchasedItems = listItems.filter(i => i.status === 'purchased').sort((a, b) => a.name.localeCompare(b.name));
    // A list at a store follows the store's aisle order; a reordered list its own order (S6).
    // Until the stores listener has answered, a named store is "loading", never "no store".
    const assigned = assignedStore(selectedList.storeId, storesState);
    const store = assigned.store;
    const groups = trip.groups;
    // Focus after a tick follows the rows on screen: with a find filter, only the matches.
    rowOrderRef.current = { needed: neededFocusOrder(trip.shownGroups), purchased: purchasedItems.map((item) => item.id) };
    const tint = listTint(selectedList);
    const canHandoff = selectedList.type === 'Grocery' && canEdit && online;

    return (
        <>
            {cartFlight.layer}
            {listDialog}
            <AlertDialog open={isClearAlertOpen} onOpenChange={setIsClearAlertOpen}>
                <AlertDialogContent>
                    <AlertDialogHeader>
                    <AlertDialogTitle>Clear {pluralize(clearIds.length, 'purchased item')}?</AlertDialogTitle>
                    <AlertDialogDescription>
                        {canHandoff
                          ? 'They will be removed from this list. You can put them on the pantry shelves first.'
                          : 'They will be removed from this list. This cannot be undone.'}
                    </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter className="gap-2">
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction onClick={() => void clearPurchasedItems(clearTarget)} className={buttonVariants({ variant: canHandoff ? 'outline' : 'destructive' })}>
                        {canHandoff ? 'Clear only' : 'Clear Purchased'}
                    </AlertDialogAction>
                    {canHandoff && (
                      <AlertDialogAction onClick={() => tripFlow.openPutAway('putAwayAndClear')}>
                        Put away & clear
                      </AlertDialogAction>
                    )}
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
            <AlertDialog open={emptyList !== null} onOpenChange={(open) => { if (!open) setEmptyList(null); }}>
                <AlertDialogContent>
                    <AlertDialogHeader>
                    <AlertDialogTitle>Delete Empty List?</AlertDialogTitle>
                    <AlertDialogDescription>
                       This shopping list is now empty. Would you like to delete it?
                    </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                    <AlertDialogCancel>No, keep it</AlertDialogCancel>
                    <AlertDialogAction onClick={() => void archiveList()} className={buttonVariants({ variant: "destructive"})}>
                        Yes, delete it
                    </AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
            <TripReceiptDialog
              open={isReceiptOpen}
              onOpenChange={setIsReceiptOpen}
              listName={selectedList.name}
              items={purchasedItems}
              afterTrip={tripFlow.afterTrip}
              offline={!online}
              putAwayLabel={tripFlow.putAwayLabel}
              onPutAway={tripFlow.receiptPutAway}
              onClearPurchased={canDelete && !tripFlow.receiptPutAway ? () => { tripFlow.remember('putAwayAndClear'); setIsReceiptOpen(false); openClear(); } : undefined}
              onDone={tripFlow.receiptDone}
            />
            <ItemEditSheet
              item={editingItem}
              categories={categories}
              canEdit={canEdit}
              canDelete={canDelete}
              onOpenChange={(open) => { if (!open) setEditingItemId(null); }}
              onSave={saveItemEdit}
              onDelete={(item) => void deleteItem(item)}
              onCloseAutoFocus={(event) => {
                // After a delete the row's Edit button is gone: focus the next row (SH-26a).
                // Otherwise (Save, Escape, Close) focus returns to the opener's Edit control.
                const target = focusAfterSheetRef.current;
                const opener = editOpenerRef.current;
                focusAfterSheetRef.current = null;
                editOpenerRef.current = null;
                if (target !== null) {
                  event.preventDefault();
                  focusRowWhenShown(target || null);
                } else if (opener) {
                  event.preventDefault();
                  focusEditControlWhenShown(opener);
                }
              }}
            />
            {tripFlow.dialog}
            <div
              className={`${tripStyles.list} rounded-xl border bg-card text-card-foreground shadow-raised`}
              data-testid="open-list"
              data-from-cache={itemsState.fromCache ? 'true' : 'false'}
              data-pending-writes={itemsState.hasPendingWrites ? 'true' : 'false'}
              style={morphStyle(listMorph.morphName === listMorphName ? listMorphName : null)}
            >
                <TripHeader
                  icon={renderListIcon(selectedList, { className: 'h-5 w-5' })}
                  iconClass={tint.classes.softChip}
                  name={selectedList.name}
                  storeName={store?.name ?? null}
                  left={loadingItems ? null : trip.left}
                  chips={loadingItems ? [] : trip.chips}
                  onOpenNeeded={() => setOpenSections((current) => withSectionOpen(current, 'needed'))}
                  scopeKey={`${householdId ?? ''}/${selectedList.id}`}
                  onBack={(event) => listMorph.run(listMorphName, () => onSelectList(null), { event })}
                  cart={<CartIndicator ref={cartFlight.cartRef} count={purchasedItems.length} inFlight={cartFlight.inFlight} onClick={openPurchased} />}
                  actions={canEdit ? [
                    ...(householdId ? [{ key: 'scan', label: 'Scan to tick', icon: ScanLine, onSelect: () => setListDialogOpen('scan') }] : []),
                    ...(tripFlow.openHistory ? [{ key: 'trips', label: 'Trips', icon: HistoryIcon, onSelect: tripFlow.openHistory }] : []),
                    ...(householdId ? [{ key: 'categories', label: 'Manage Categories', icon: Settings, onSelect: () => setListDialogOpen('categories') }] : []),
                  ] : []}
                  addItem={canEdit ? (
                    <Dialog open={isAddItemDialogOpen} onOpenChange={setIsAddItemDialogOpen}>
                        <ShortcutHint shortcut="add-item" label="Add an item from anywhere">
                        <DialogTrigger asChild>
                            <Button variant="ghost" size="icon" aria-label="Add Item" className="h-11 w-11 shrink-0"><PlusCircle className="h-5 w-5" aria-hidden /></Button>
                        </DialogTrigger>
                        </ShortcutHint>
                        <DialogContent phoneSheet>
                            <DialogHeader>
                                <DialogTitle className="font-headline">Add Item to List</DialogTitle>
                                <DialogDescription>Enter an item name or scan a barcode. Names already on the list raise its quantity.</DialogDescription>
                            </DialogHeader>
                            <Form {...form}>
                                <form onSubmit={form.handleSubmit((v) => onAddItemSubmit(v))} className="space-y-4 py-4">
                                <FormField
                                    control={form.control}
                                    name="name"
                                    render={({ field }) => (
                                    <FormItem>
                                        <FormLabel>Item Name</FormLabel>
                                        <FormControl>
                                        <Input placeholder="e.g. Olive Oil" maxLength={120} {...field} />
                                        </FormControl>
                                        <FormMessage />
                                    </FormItem>
                                    )}
                                />
                                <FormField
                                  control={form.control}
                                  name="category"
                                  render={({ field }) => (
                                    <FormItem>
                                      <FormLabel>Category</FormLabel>
                                      <Select
                                        value={field.value || 'automatic'}
                                        onValueChange={(value) => field.onChange(value === 'automatic' ? '' : value)}
                                      >
                                        <FormControl>
                                          <SelectTrigger><SelectValue /></SelectTrigger>
                                        </FormControl>
                                        <SelectContent>
                                          <SelectItem value="automatic">Automatic</SelectItem>
                                          {categories.map((category) => (
                                            <SelectItem key={category} value={category}>{category}</SelectItem>
                                          ))}
                                        </SelectContent>
                                      </Select>
                                      <FormMessage />
                                    </FormItem>
                                  )}
                                />
                                <FormField
                                  control={form.control}
                                  name="quantity"
                                  render={({ field }) => (
                                    <FormItem>
                                      <FormLabel>Quantity</FormLabel>
                                      <div className="flex items-center gap-2">
                                            <Button type="button" variant="outline" size="icon" aria-label="Decrease item quantity" className="h-11 w-11 [@media(pointer:coarse)]:h-12 [@media(pointer:coarse)]:w-12" onClick={() => adjustQuantity(-1)} disabled={currentQuantity <= 1}>
                                                <Minus className="h-4 w-4" aria-hidden />
                                            </Button>
                                            <FormControl>
                                                <Input type="number" min={1} max={999} className="text-center" {...field} />
                                            </FormControl>
                                            <Button type="button" variant="outline" size="icon" aria-label="Increase item quantity" className="h-11 w-11 [@media(pointer:coarse)]:h-12 [@media(pointer:coarse)]:w-12" onClick={() => adjustQuantity(1)}>
                                                <Plus className="h-4 w-4" aria-hidden />
                                            </Button>
                                        </div>
                                      <FormMessage />
                                    </FormItem>
                                  )}
                                />
                                <DialogFooter className="justify-between gap-2 sm:justify-between">
                                      <Dialog open={isScannerOpen} onOpenChange={setIsScannerOpen}>
                                        <DialogTrigger asChild>
                                           <Button type="button" variant="outline"><ScanBarcode className="mr-2" aria-hidden /> Scan Barcode</Button>
                                        </DialogTrigger>
                                        <DialogContent phoneSheet>
                                            <DialogHeader>
                                                <DialogTitle>Scan Barcode</DialogTitle>
                                                <DialogDescription>Scan a product barcode to add it to this shopping list.</DialogDescription>
                                            </DialogHeader>
                                            <BarcodeScanner onScan={handleBarcodeScan} />
                                        </DialogContent>
                                      </Dialog>
                                    <Button type="submit" disabled={form.formState.isSubmitting || dialogStatus !== null}>
                                        {form.formState.isSubmitting || dialogStatus !== null ? ( <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden /> ) : ( "Add to List" )}
                                    </Button>
                                </DialogFooter>
                                {dialogStatus && <p role="status" className="text-sm text-muted-foreground">{dialogStatus}</p>}
                                {scanStatus && <p role="status" className="text-sm text-muted-foreground">{scanStatus.text}</p>}
                                <LookupMissNotice scanMiss={addScanMiss.scanMiss} fallback="type the name instead" canSave={canEdit} />
                                </form>
                            </Form>
                        </DialogContent>
                    </Dialog>
                  ) : null}
                />
                {canEdit && tripFlow.history}
                {canEdit && householdId && (
                  <CategoriesDialog
                    // One instance per list: a late answer for list A never fills list B's fields.
                    key={`${householdId}/${selectedList.id}`}
                    householdId={householdId}
                    list={selectedList}
                    config={categoryConfig}
                    stores={storesState.value}
                    assigned={assigned}
                    storesListed={storesListed(storesState)}
                    uid={uid}
                    online={online}
                    showTrigger={false}
                    open={listDialogOpen === 'categories'}
                    onOpenChange={(open) => setListDialogOpen(open ? 'categories' : null)}
                    onCloseAutoFocus={focusListMenu}
                  />
                )}
                {canEdit && householdId && (
                  <ScanToTick
                    // Distinct from the sibling CategoriesDialog's key (siblings never share a key).
                    key={`scan:${householdId}/${selectedList.id}`}
                    householdId={householdId}
                    listId={selectedList.id}
                    items={listItems}
                    onTick={toggleItemStatus}
                    onAdd={addScannedEntry}
                    showTrigger={false}
                    open={listDialogOpen === 'scan'}
                    onOpenChange={(open) => setListDialogOpen(open ? 'scan' : null)}
                    onCloseAutoFocus={focusListMenu}
                  />
                )}
                <div className="px-3 pb-4 sm:px-6 sm:pb-6">
                    {loadingItems || assigned.waitForStore ? (
                      <div className="space-y-2" role="status" aria-label="Loading items">
                        <Skeleton className="h-6 w-32" />
                        <Skeleton className="h-11 w-full" />
                        <Skeleton className="h-11 w-full" />
                        <Skeleton className="h-11 w-full" />
                      </div>
                    ) : (
                      <>
                         <Accordion type="multiple" value={openSections} onValueChange={setOpenSections} className="w-full">
                            <AccordionItem value="needed" className={tripStyles.needed}>
                            <AccordionTrigger className="font-headline text-lg"><span>Needed (<NumberTicker value={neededItems.length} animateOnMount={false} />)</span></AccordionTrigger>
                            <AccordionContent>
                                {neededItems.length === 0 ? (
                                  // One message (SH-10g): never "empty" and "in the cart" together.
                                  <EmptyState compact kind="lists" headingLevel={4} {...neededEmptyCopy({ total: listItems.length, canEdit })} />
                                ) : trip.shownGroups.length === 0 ? (
                                  <p className="px-2 py-4 text-sm text-muted-foreground" data-testid="trip-no-match">No needed item matches what you typed. Press Enter to add it.</p>
                                ) : (
                                  <TripNeededGroups
                                    groups={trip.shownGroups}
                                    headingClass={tint.classes.text}
                                    canToggle={canEdit}
                                    canOpenEditor={canEdit || canDelete}
                                    onToggle={toggleItemStatus}
                                    onEdit={openEditor}
                                    attributionFor={attributionFor}
                                    photoFor={photoFor}
                                    enterDelayFor={(groupIndex, itemIndex) => (staggerRows && !trip.filtering ? rowDelay(groups, groupIndex, itemIndex, neededItems.length) : undefined)}
                                  />
                                )}
                            </AccordionContent>
                            </AccordionItem>
                            <AccordionItem value="purchased" ref={purchasedSectionRef}>
                            <div className="flex items-center">
                                <AccordionTrigger className="flex-1 font-headline text-lg"><span>Purchased (<NumberTicker value={purchasedItems.length} animateOnMount={false} />)</span></AccordionTrigger>
                                {purchasedItems.length > 0 && canDelete && (
                                    <Button variant="ghost" size="sm" onClick={openClear} className="text-muted-foreground hover:text-destructive">
                                        <ArchiveX className="mr-2 h-4 w-4" aria-hidden /> Clear
                                    </Button>
                                )}
                                {purchasedItems.length > 0 && !canDelete && canHandoff && (
                                    <Button variant="ghost" size="sm" onClick={() => tripFlow.openPutAway('putAway')} className="text-muted-foreground">
                                        Put away
                                    </Button>
                                )}
                            </div>
                            <AccordionContent>
                                <div className="space-y-0.5">
                                <AnimatePresence initial={false}>
                                {purchasedItems.map((item) => (
                                    <ShoppingItemRow
                                      trip
                                      key={item.id}
                                      item={item}
                                      canToggle={canEdit}
                                      canOpenEditor={canEdit || canDelete}
                                      onToggle={toggleItemStatus}
                                      onEdit={openEditor}
                                      attribution={attributionFor(item)}
                                      photoUrl={photoFor(item)}
                                    />
                                ))}
                                </AnimatePresence>
                                {purchasedItems.length === 0 && <p className="py-4 text-center text-sm text-muted-foreground">Nothing in the cart yet. Tick items as you shop.</p>}
                                </div>
                            </AccordionContent>
                            </AccordionItem>
                        </Accordion>
                        {/* Keyed per list: a pending save's leftovers never land in another list's field. */}
                        {canEdit && (
                          <QuickAddBar
                            key={selectedList.id}
                            listName={selectedList.name}
                            onAdd={onQuickAdd}
                            // Find or add (SH-18c): one typed name filters the needed items; Enter adds it.
                            placeholder="Type to find or add"
                            onTextChange={trip.setFindText}
                            hint={trip.hint}
                            // Waits (with why) while the items are unknown: a listener that failed before its first snapshot.
                            loading={writeWaitFor(selectedList.id) !== null}
                            loadingText={writeWaitFor(selectedList.id) ? writeWaitText(writeWaitFor(selectedList.id)!, selectedList.name) : undefined}
                            above={tripFlow.chips || snackbarEntries.length > 0 ? (
                              <>
                                {tripFlow.chips}
                                {snackbarEntries.length > 0 && <UndoSnackbar entries={snackbarEntries} />}
                              </>
                            ) : undefined}
                          />
                        )}
                      </>
                    )}
                </div>
            </div>
        </>
    );
  }

  // The overview (S8a: SH-11a–c, SH-28c): the household's Grocery list inline
  // (ticks and adds go through the same tick, Undo and save paths as the open
  // list), the pantry's expiring chips and every list as a card.
  const overviewAssigned = overviewList ? assignedStore(overviewList.storeId, storesState) : null;
  const overviewGroups = overviewList ? neededAisleGroups(listItems, categoryConfig, overviewAssigned?.store ?? null) : [];
  rowOrderRef.current = { needed: overviewGroups.flatMap((group) => group.items.map((item) => item.id)), purchased: [] };
  const openCreateList = () => {
    setListToEdit(null);
    setIsListDialogOpen(true);
  };
  return (
    <>
      {listDialog}
      <AlertDialog open={!!listToDelete} onOpenChange={(open) => !open && setListToDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {listToDelete?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently deletes the list, its items and its categories for everyone in the household. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className={buttonVariants({ variant: "destructive" })}
              onClick={() => void handleDeleteList()}>
              Delete List
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      {/* An Undo from a list that was open a moment ago stays reachable here (the overview places it). */}
      <ShoppingOverview
        lists={lists}
        canEdit={canEdit}
        grocery={overviewList ? {
          list: overviewList,
          groceries: overviewChoice.groceries,
          onPick: (listId) => {
            if (!householdId) return;
            setPickedGrocery({ householdId, listId });
            rememberRecentGrocery(browserStorage(), householdId, listId);
            setRecentGroceryId(listId);
          },
          items: listItems,
          groups: overviewGroups,
          loading: itemsState.status === 'loading' || categoriesState.status === 'loading' || Boolean(overviewAssigned?.waitForStore),
          fromCache: itemsState.fromCache,
          hasPendingWrites: itemsState.hasPendingWrites,
          store: overviewAssigned?.store ?? null,
          attributionFor,
          // The page's one Barcode Library listener, as the open list's rows use it.
          photoFor,
          // Rows show only once loaded; a click racing a list switch is dropped.
          onToggle: (item) => {
            if (writeReadyFor(overviewList.id) && listItemsRef.current.some((entry) => entry.id === item.id)) void toggleItemStatus(item, overviewList);
          },
          writeWait: writeWaitFor(overviewList.id),
          onQuickAdd: (entries) => onQuickAdd(entries, overviewList),
          onOpen: () => onSelectList(overviewList.id),
        } : null}
        groceryWaiting={overviewChoice.waiting}
        uid={uid}
        memberNames={memberNames}
        localOpIds={new Set([...localTicks.opIds, ...localPurchaseOpsRef.current, ...undoEntries.map((entry) => entry.opId)])}
        selfKnown={localTicks.reliable && !localTicksWriteFailed()}
        now={now}
        expiring={pantryItems && onOpenPantryItem && onOpenPantry
          ? <ExpiringChips items={pantryItems} onOpenItem={onOpenPantryItem} onOpenPantry={onOpenPantry} />
          : undefined}
        snackbarEntries={snackbarEntries}
        onCreateList={openCreateList}
        renderListCard={(list, { compact }) => {
          const morph = sharedId('list', list.id);
          return (
            <StaggerItem key={list.id}>
              <ListCard
                list={list}
                compact={compact}
                counts={counts[list.id]}
                style={morphStyle(listMorph.morphName === morph ? morph : null)}
                onSelect={(event) => listMorph.run(morph, () => onSelectList(list.id), { event })}
                onEdit={canEdit ? () => { setListToEdit(list); setIsListDialogOpen(true); } : undefined}
                onDelete={canDelete ? () => setListToDelete(list) : undefined}
              />
            </StaggerItem>
          );
        }}
      />
    </>
  );
}
