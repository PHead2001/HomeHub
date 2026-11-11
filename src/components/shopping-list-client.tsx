'use client';

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import { AnimatePresence, motion } from 'motion/react';
import { collection, doc, getDocFromCache, updateDoc, deleteDoc, setDoc, type DocumentReference } from 'firebase/firestore';
import { ArchiveX, ArrowLeft, Loader2, Minus, Plus, PlusCircle, ScanBarcode, Settings, X } from 'lucide-react';
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
import { FieldError, fieldErrorProps } from '@/components/field-error';
import { useToast } from '@/hooks/use-toast';
import { UNDO_WINDOW_MS } from '@/lib/undo-window';
import { useAuth } from '@/hooks/use-auth';
import { db, getLocalPersistence } from '@/lib/firebase';
import { slugify, cn } from '@/lib/utils';
import { playFeedback } from '@/lib/feedback';
import { awaitWriteUnlessOffline, isBrowserOffline } from '@/lib/firestore-offline';
import { addItemsToList, type AddEntry, type CategorizationReport, type EntryOutcome } from '@/lib/shopping/add-items';
import { categorizationNotice, createSubmissionGuard, dialogAfterSave, isPendingState, isSettledForInput, newSubmissionId, offlineTickNote, once, saveStateLabel, settledTickFollowUp, summarizeStates, tickFollowUp, trackWrite, type DialogDraft } from '@/lib/shopping/save-status';
import { scanToShoppingEntry } from '@/lib/shopping/scan';
import { groupItemsByAisle, normalizeItemName, pluralize, restoreItemData, type QuickAddEntry } from '@/lib/shopping/items';
import { editUpdate, restoreDocument, restoreIfAbsent, untickUpdate } from '@/lib/shopping/item-writes';
import { notUndoneNotice, planTick, tickShoppingItem, undoShoppingTick, type TickCurrent } from '@/lib/shopping/tick';
import { shoppingTickIO } from '@/lib/shopping/tick-firestore';
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
import type { ItemEditChanges } from '@/lib/shopping/edit';
import { countAllOnServer, countNeededOnServer, useLiveListCategories, useLiveListCounts, useLiveListItems, useLiveShoppingLists } from '@/lib/shopping/live';
import { clearIdsFor, deletionSettled, isListLinkMissing, isOpenListDeleted, listsConfirmed, quickAddDecision, type ClearTarget } from '@/lib/shopping/live-state';
import { useOnTabDeactivate } from './shopping/tab-activity';
import { deleteShoppingList } from '@/app/shopping/actions';
import { listTint } from '@/lib/shopping/list-style';
import type { PantryHandoffChoice } from '@/lib/shopping/pantry';
import { addPurchasesToPantry } from '@/lib/shopping/pantry-writes';
import { deleteStillPurchasedItems } from '@/lib/shopping/item-transactions';
import type { ShoppingListItem, ShoppingListCategory, ShoppingList, BarcodeLibraryItem } from '@/lib/types';
import { BarcodeScanner } from './barcode-scanner';
import { ListCard } from './shopping/list-card';
import { ListCardsSkeleton } from './shopping/shopping-skeletons';
import { ListDialog, type ListFormValues } from './shopping/list-dialog';
import { renderListIcon } from './shopping/list-icons';
import { ShoppingItemRow } from './shopping/shopping-item-row';
import { ItemEditSheet } from './shopping/item-edit-sheet';
import { UndoSnackbar, type SnackbarEntry } from './shopping/undo-snackbar';
import { CartIndicator } from './shopping/cart-indicator';
import { useCartFlight } from './shopping/cart-flight';
import { QuickAddBar, type QuickAddOutcome } from './shopping/quick-add-bar';
import { TripReceiptDialog } from './shopping/trip-receipt-dialog';
import { PantryHandoffDialog } from './shopping/pantry-handoff-dialog';
import { useInPageMorph } from './shopping/use-in-page-morph';
import { NumberTicker } from '@/components/motion/number-ticker';
import { Stagger, StaggerItem } from '@/components/motion/stagger';
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

/** The open list's categories (live: the listener shows a save at once, and another member's edits as they land). */
function ManageCategoriesDialog({ categories, householdId, listId }: { categories: ShoppingListCategory[], householdId: string, listId: string }) {
  const { toastError } = useToast();
  const [newCategory, setNewCategory] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isCategoryDialogOpen, setIsCategoryDialogOpen] = useState(false);
  // Closed when the Shopping Lists tab is hidden (its portal is outside the panel).
  useOnTabDeactivate(() => setIsCategoryDialogOpen(false));

  const categoriesDocRef = doc(db, 'households', householdId, 'shopping-lists', listId, 'config', 'categories');

  const addCategory = async () => {
    const name = newCategory.replace(/\s+/g, ' ').trim();
    if (!name) {
      setError('Type a category name.');
      return;
    }
    if (name.length > 40) {
      setError('Keep the name under 40 characters.');
      return;
    }
    if (categories.some(c => c.toLowerCase() === name.toLowerCase())) {
      setError(`${name} is already a category.`);
      return;
    }
    setError(null);
    const updatedCategories = [...categories, name].sort((a, b) => a.localeCompare(b));
    try {
      await setDoc(categoriesDocRef, { list: updatedCategories });
      setNewCategory('');
    } catch (cause) {
      toastError(cause, 'Could not add the category');
    }
  };

  const removeCategory = async (categoryToRemove: string) => {
    if (categoryToRemove === 'Other') return;
    const updatedCategories = categories.filter(c => c !== categoryToRemove);
    try {
      await setDoc(categoriesDocRef, { list: updatedCategories });
    } catch (cause) {
      toastError(cause, 'Could not remove the category');
    }
  };

  return (
    <Dialog open={isCategoryDialogOpen} onOpenChange={(open) => { setIsCategoryDialogOpen(open); if (!open) setError(null); }}>
      <DialogTrigger asChild>
        <Button variant="outline" className="w-full sm:w-auto"><Settings className="mr-2 h-4 w-4" aria-hidden /> Manage Categories</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="font-headline">Manage Categories</DialogTitle>
          <DialogDescription>Items are grouped by category in the order you walk a store. &apos;Other&apos; cannot be removed.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="space-y-1.5">
            <label htmlFor="new-category" className="sr-only">New category name</label>
            <div className="flex gap-2">
              <Input
                value={newCategory}
                onChange={(e) => { setNewCategory(e.target.value); if (error) setError(null); }}
                placeholder="New category name"
                maxLength={40}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void addCategory(); } }}
                {...fieldErrorProps('new-category', error)}
              />
              <Button onClick={() => void addCategory()}>Add</Button>
            </div>
            <FieldError id="new-category">{error}</FieldError>
          </div>
          <div className="space-y-2">
            <h3 className="font-medium">Existing Categories</h3>
            <ul className="flex flex-wrap gap-2">
              {categories.map(category => (
                <li key={category} className="flex items-center gap-1 rounded-full bg-secondary px-3 py-1 text-sm text-secondary-foreground">
                  {category}
                  {category !== 'Other' && (
                    <button aria-label={`Remove ${category} category`} onClick={() => void removeCategory(category)} className="-my-2 -mr-2 ml-0.5 flex h-11 w-11 items-center justify-center rounded-full hover:bg-muted [@media(pointer:coarse)]:h-12 [@media(pointer:coarse)]:w-12">
                      <X className="h-4 w-4" aria-hidden />
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </div>
        </div>
        <DialogFooter>
          <Button variant="secondary" onClick={() => setIsCategoryDialogOpen(false)}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
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
}) {
  const { currentUser, permissions } = useAuth();
  const { toast, toastError } = useToast();
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
  const itemsState = useLiveListItems(householdId, selectedListId);
  const categoriesState = useLiveListCategories(householdId, selectedListId);
  const listItems = itemsState.value;
  const categories = categoriesState.value;
  const loadingItems = Boolean(selectedListId) && (itemsState.status === 'loading' || categoriesState.status === 'loading');
  const counts = useLiveListCounts(householdId, lists.map((list) => list.id), selectedListId ?? '');

  const [isAddItemDialogOpen, setIsAddItemDialogOpen] = useState(false);
  const [isScannerOpen, setIsScannerOpen] = useState(false);
  const [isListDialogOpen, setIsListDialogOpen] = useState(false);
  const [listToEdit, setListToEdit] = useState<ShoppingList | null>(null);
  const [listToDelete, setListToDelete] = useState<ShoppingList | null>(null);
  const [isClearAlertOpen, setIsClearAlertOpen] = useState(false);
  const [isArchiveAlertOpen, setIsArchiveAlertOpen] = useState(false);
  const [openSections, setOpenSections] = useState<string[]>(['needed']);
  const [isReceiptOpen, setIsReceiptOpen] = useState(false);
  const [handoffMode, setHandoffMode] = useState<null | 'pantry' | 'then-clear'>(null);
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
  useOnTabDeactivate(() => {
    setIsAddItemDialogOpen(false);
    setIsScannerOpen(false);
    setIsListDialogOpen(false);
    setListToDelete(null);
    setIsClearAlertOpen(false);
    setIsArchiveAlertOpen(false);
    setIsReceiptOpen(false);
    setHandoffMode(null);
    setEditingItemId(null);
  });

  // The Add Item scanner is nested in the Add Item dialog: it never outlives it
  // (otherwise reopening Add Item would bring the camera back).
  if (!isAddItemDialogOpen && isScannerOpen) setIsScannerOpen(false);

  const offlineNoticeShownRef = useRef(false);
  const selectedListIdRef = useRef<string | null>(null);
  const householdIdRef = useRef<string | null>(null);
  const listItemsRef = useRef<ShoppingListItem[]>([]);
  const purchasedSectionRef = useRef<HTMLDivElement>(null);

  const selectedList = useMemo(() => lists.find((list) => list.id === selectedListId) ?? null, [lists, selectedListId]);
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
    const error = listsState.error ?? itemsState.error ?? categoriesState.error;
    if (!error || reportedErrorRef.current === error) return;
    reportedErrorRef.current = error;
    toastError(error, listsState.error ? 'Could not load shopping lists' : 'Could not load list items');
  }, [listsState.error, itemsState.error, categoriesState.error, toastError]);

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
      setIsAddItemDialogOpen(true);
    } else if (quickAddKind === 'choose') {
      toast({ title: 'Choose a list', description: 'Open the list you want, then tap Add Item.' });
    }
  }, [quickAddKind, quickAddListId, onQuickAddHandled, selectedListId, toast]);

  // --- List CRUD ---

  const handleSaveList = async (data: ListFormValues, id?: string) => {
    const listsCollection = getListsCollectionRef();
    if (!listsCollection) return;
    const listId = id || slugify(data.name);
    try {
      await setDoc(doc(listsCollection, listId), { ...data, name: data.name.trim() }, { merge: true });
      toast({ title: id ? 'List updated' : 'List created' });
    } catch (error) {
      toastError(error, 'Could not save the list');
    }
  };

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
  ): Promise<EntryOutcome[] | null> => {
    const list = selectedList;
    if (!householdId || !list) return null;
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
      active: () => ({ householdId: householdIdRef.current, listId: selectedListIdRef.current }),
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
      if (!outcomes) return;
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
        setDialogStatus(`${saveStateLabel(outcome.state)} ${outcome.name} is not confirmed yet.`);
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
  const onQuickAdd = async (entries: QuickAddEntry[]): Promise<QuickAddOutcome> => {
    try {
      const outcomes = await addEntries(entries);
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
  const handleBarcodeScan = async (barcode: string) => {
    if (!currentUser?.householdId) return;
    setIsScannerOpen(false);
    toast({ title: 'Barcode scanned', description: 'Looking up the product…' });
    try {
      const result = unwrapAiActionResult(await lookupBarcode(
        { barcode },
        await getAiActionContext(currentUser.householdId)
      ));
      const entry = scanToShoppingEntry(result);
      if (entry) {
        await onAddItemSubmit(
          { name: entry.name, quantity: entry.quantity, category: getValues('category') },
          { libraryItem: result.libraryItem, barcode, size: entry.size, sizeUnit: entry.sizeUnit },
        );
      } else {
        toast({ variant: 'destructive', title: 'Product not found', description: 'No product matches that barcode. You can add it to your Barcode Library.' });
      }
    } catch (error) {
      toastError(error, 'Barcode lookup failed');
    }
  };

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
    if (entry.householdId !== householdIdRef.current || entry.listId !== selectedListIdRef.current || !itemsReadyRef.current) return undefined;
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
      if (!checkboxId) document.querySelector<HTMLElement>('[data-testid="open-list"] [data-testid="cart-indicator"]')?.focus({ preventScroll: true });
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

  const toggleItemStatus = async (item: ShoppingListItem) => {
      if (!householdId || !selectedList) return;

      const isCheckingOff = item.status === 'needed';
      const newStatus = isCheckingOff ? 'purchased' : 'needed';
      const list = selectedList;
      // The write always targets the item's own list; the screen is only touched while
      // that list is still the open one.
      const isListOpen = () => selectedListIdRef.current === list.id;
      // The item as the open list's listener shows it now (not as the row last rendered
      // it): a tick never lands on an item already purchased (or deleted) meanwhile.
      const current: TickCurrent = isListOpen() && itemsReadyRef.current
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
      const itemRef = doc(db, 'households', householdId, 'shopping-lists', list.id, 'items', item.id);
      const ticked = isCheckingOff
        ? tickShoppingItem(shoppingTickIO, { path: { householdId, listId: list.id, itemId: item.id }, uid, current })
        : null;
      if (ticked && ticked.status !== 'ticked') return;
      const purchaseOpId = ticked ? ticked.opId : null;
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
  // editedByUid and the server's editedAt. Closes once sent (it queues offline).
  const saveItemEdit = async (item: ShoppingListItem, changes: ItemEditChanges): Promise<boolean> => {
    const list = selectedList;
    if (!householdId || !list || !uid) return false;
    const itemRef = doc(db, 'households', householdId, 'shopping-lists', list.id, 'items', item.id);
    return sendWrite(updateDoc(itemRef, editUpdate(uid, changes)), (error) => toastError(error, `Could not save ${changes.name ?? item.name}`));
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

  const snackbarEntries: SnackbarEntry[] = undoEntries.map((entry) => entry.group === 'shopping-tick'
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
    const remaining = await countAllOnServer(householdId, list.id).catch(() => null);
    if (remaining === 0 && selectedListIdRef.current === list.id) {
      setListToDelete(list);
      setIsArchiveAlertOpen(true);
    }
  };

  // `shownIds` are the purchased items listed in the dialog (ticked or not): with
  // "then clear", exactly those are cleared after the pantry write succeeds.
  const sendToPantry = async (choices: PantryHandoffChoice[], shownIds: string[]): Promise<boolean> => {
    if (!householdId) return false;
    if (isBrowserOffline()) {
      toast({ title: 'You are offline', description: 'Add items to the pantry once you are back online.' });
      return false;
    }
    const list = selectedList;
    // "Then clear" only clears the list on screen (the ids came from it).
    const thenClear = handoffMode === 'then-clear' && list !== null && selectedListIdRef.current === list.id;
    try {
      // One transaction: with "then clear" the pantry writes and the clear succeed or
      // fail together, so a retry can never add the same purchases twice.
      if (!list) return false;
      // Only purchases the transaction confirms are credited (and, with "then clear",
      // deleted in the same commit), so concurrent handoffs never double-credit.
      const { written, cleared, skipped } = await addPurchasesToPantry(
        householdId,
        list.id,
        choices,
        thenClear ? { clearItemIds: shownIds } : undefined,
      );
      toast({
        title: thenClear ? 'Added to the pantry and cleared' : 'Added to the pantry',
        description: `${pluralize(written, 'item')} on the shelves.${skipped.length > 0 ? ` Skipped ${skipped.join(', ')}: no longer bought or already cleared.` : ''}`,
        action: onOpenPantry ? <ToastAction altText="View the pantry" onClick={onOpenPantry}>View pantry</ToastAction> : undefined,
      });
      setIsReceiptOpen(false);
      if (thenClear && cleared.length > 0) await afterCleared(list);
      return true;
    } catch (error) {
      toastError(error, 'Could not add to the pantry');
      return false;
    }
  };

  const archiveList = async () => {
    setIsArchiveAlertOpen(false);
    await handleDeleteList(listToDelete);
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

  // The open list was deleted elsewhere: say so, with the way back and nothing to write with.
  if (deletedList) {
    return (
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
    );
  }

  // View for showing the selected list's items
  if (selectedList) {
    const listMorphName = sharedId('list', selectedList.id);
    const staggerRows = !reduced && !loadingItems && enteredRowsRef.current !== selectedList.id;
    const neededItems = listItems.filter(i => i.status === 'needed');
    const purchasedItems = listItems.filter(i => i.status === 'purchased').sort((a, b) => a.name.localeCompare(b.name));
    const groups = groupItemsByAisle(neededItems, categories);
    rowOrderRef.current = { needed: groups.flatMap((group) => group.items.map((item) => item.id)), purchased: purchasedItems.map((item) => item.id) };
    const tint = listTint(selectedList);
    const canHandoff = selectedList.type === 'Grocery' && canEdit && online;

    return (
        <>
            {cartFlight.layer}
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
                      <AlertDialogAction onClick={() => setHandoffMode('then-clear')}>
                        Add to pantry, then clear
                      </AlertDialogAction>
                    )}
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
            <AlertDialog open={isArchiveAlertOpen} onOpenChange={setIsArchiveAlertOpen}>
                <AlertDialogContent>
                    <AlertDialogHeader>
                    <AlertDialogTitle>Delete Empty List?</AlertDialogTitle>
                    <AlertDialogDescription>
                       This shopping list is now empty. Would you like to delete it?
                    </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                    <AlertDialogCancel onClick={() => setListToDelete(null)}>No, keep it</AlertDialogCancel>
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
              onSendToPantry={canHandoff ? () => { setIsReceiptOpen(false); setHandoffMode('pantry'); } : undefined}
              onClearPurchased={canDelete ? () => { setIsReceiptOpen(false); openClear(); } : undefined}
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
            {handoffMode !== null && (
            <PantryHandoffDialog
              open
              onOpenChange={(open) => { if (!open) setHandoffMode(null); }}
              items={purchasedItems}
              confirmLabel={handoffMode === 'then-clear' ? 'Add and clear' : 'Add to pantry'}
              onConfirm={sendToPantry}
            />
            )}
            <div
              className="rounded-xl border bg-card text-card-foreground shadow-raised"
              data-testid="open-list"
              data-from-cache={itemsState.fromCache ? 'true' : 'false'}
              data-pending-writes={itemsState.hasPendingWrites ? 'true' : 'false'}
              style={morphStyle(listMorph.morphName === listMorphName ? listMorphName : null)}
            >
                <div className="flex flex-col items-stretch gap-4 p-4 sm:flex-row sm:items-center sm:justify-between sm:p-6">
                    <div className="min-w-0">
                        <Button variant="ghost" onClick={(event) => listMorph.run(listMorphName, () => onSelectList(null), { event })} className="mb-3 pl-1">
                           <ArrowLeft className="mr-2" aria-hidden /> Back to all lists
                        </Button>
                        <div className="flex items-center gap-3">
                          <span className={cn('flex h-10 w-10 shrink-0 items-center justify-center rounded-xl', tint.classes.softChip)}>
                            {renderListIcon(selectedList, { className: 'h-5 w-5' })}
                          </span>
                          <h2 className="min-w-0 break-words font-headline text-2xl font-semibold leading-tight">{selectedList.name}</h2>
                          <CartIndicator ref={cartFlight.cartRef} count={purchasedItems.length} inFlight={cartFlight.inFlight} onClick={openPurchased} className="ml-auto sm:ml-2" />
                        </div>
                    </div>
                    {canEdit && (
                    <div className="flex w-full flex-col gap-2 min-[400px]:flex-row sm:w-auto sm:items-center">
                        {householdId && <ManageCategoriesDialog categories={categories} householdId={householdId} listId={selectedList.id} />}
                        <Dialog open={isAddItemDialogOpen} onOpenChange={setIsAddItemDialogOpen}>
                        <ShortcutHint shortcut="add-item" label="Add an item from anywhere">
                        <DialogTrigger asChild>
                            <Button className="w-full sm:w-auto"><PlusCircle className="mr-2" aria-hidden /> Add Item</Button>
                        </DialogTrigger>
                        </ShortcutHint>
                        <DialogContent>
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
                                        <DialogContent>
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
                                </form>
                            </Form>
                        </DialogContent>
                        </Dialog>
                    </div>
                    )}
                </div>
                <div className="px-4 pb-4 sm:px-6 sm:pb-6">
                    {loadingItems ? (
                      <div className="space-y-2" role="status" aria-label="Loading items">
                        <Skeleton className="h-6 w-32" />
                        <Skeleton className="h-11 w-full" />
                        <Skeleton className="h-11 w-full" />
                        <Skeleton className="h-11 w-full" />
                      </div>
                    ) : (
                      <>
                         <Accordion type="multiple" value={openSections} onValueChange={setOpenSections} className="w-full">
                            <AccordionItem value="needed">
                            <AccordionTrigger className="font-headline text-lg"><span>Needed (<NumberTicker value={neededItems.length} animateOnMount={false} />)</span></AccordionTrigger>
                            <AccordionContent>
                                {neededItems.length === 0 ? (
                                  <EmptyState
                                    compact
                                    kind="lists"
                                    headingLevel={3}
                                    title={listItems.length === 0 ? 'This list is empty' : 'Nothing left to buy'}
                                    description={canEdit ? 'Type items into the field below, like "milk, eggs, 2 bread".' : 'Everything on this list is in the cart.'}
                                  />
                                ) : (
                                <div>
                                  <AnimatePresence initial={false}>
                                    {groups.flatMap((group, groupIndex) => [
                                      <motion.h3
                                        key={`aisle:${group.category}`}
                                        layout="position"
                                        exit={{ opacity: 0, transition: { duration: 0.12, delay: 0.15 } }}
                                        className={cn('mb-1 mt-4 px-2 text-sm font-semibold uppercase tracking-wide first:mt-0', tint.classes.text)}
                                      >
                                        {group.category}
                                      </motion.h3>,
                                      ...group.items.map((item, itemIndex) => (
                                        <ShoppingItemRow
                                          key={`item:${item.id}`}
                                          enterDelay={staggerRows ? rowDelay(groups, groupIndex, itemIndex, neededItems.length) : undefined}
                                          item={item}
                                          canToggle={canEdit}
                                          canOpenEditor={canEdit || canDelete}
                                          onToggle={toggleItemStatus}
                                          onEdit={openEditor}
                                          attribution={attributionFor(item)}
                                        />
                                      )),
                                    ])}
                                  </AnimatePresence>
                                </div>
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
                                    <Button variant="ghost" size="sm" onClick={() => setHandoffMode('pantry')} className="text-muted-foreground">
                                        Add to pantry
                                    </Button>
                                )}
                            </div>
                            <AccordionContent>
                                <div className="space-y-0.5">
                                <AnimatePresence initial={false}>
                                {purchasedItems.map((item) => (
                                    <ShoppingItemRow
                                      key={item.id}
                                      item={item}
                                      canToggle={canEdit}
                                      canOpenEditor={canEdit || canDelete}
                                      onToggle={toggleItemStatus}
                                      onEdit={openEditor}
                                      attribution={attributionFor(item)}
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
                            above={snackbarEntries.length > 0 ? <UndoSnackbar entries={snackbarEntries} /> : undefined}
                          />
                        )}
                      </>
                    )}
                </div>
            </div>
        </>
    );
  }

  // Main view for showing all lists
  return (
    <>
      {/* An Undo from a list that was open a moment ago stays reachable here. */}
      {snackbarEntries.length > 0 && <UndoSnackbar floating entries={snackbarEntries} />}
      <ListDialog
        isOpen={isListDialogOpen}
        onOpenChange={setIsListDialogOpen}
        onSave={handleSaveList}
        listToEdit={listToEdit}
      />
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

      {lists.length === 0 ? (
        <EmptyState
          kind="lists"
          title="No shopping lists yet"
          description={canEdit ? 'Start with groceries, a hardware run or anything else you shop for.' : 'Lists your household creates will show up here.'}
          action={canEdit ? { label: 'Create a list', icon: <PlusCircle className="mr-2 h-4 w-4" aria-hidden />, onClick: () => { setListToEdit(null); setIsListDialogOpen(true); } } : undefined}
          className="rounded-xl border border-dashed"
        />
      ) : (
        <>
          {canEdit && (
            <div className="mb-4 flex justify-end">
              <Button onClick={() => { setListToEdit(null); setIsListDialogOpen(true); }}>
                <PlusCircle className="mr-2" aria-hidden /> Create New List
              </Button>
            </div>
          )}
          <Stagger className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
            {lists.map(list => {
              const morph = sharedId('list', list.id);
              return (
                <StaggerItem key={list.id}>
                  <ListCard
                    list={list}
                    counts={counts[list.id]}
                    style={morphStyle(listMorph.morphName === morph ? morph : null)}
                    onSelect={(event) => listMorph.run(morph, () => onSelectList(list.id), { event })}
                    onEdit={canEdit ? () => { setListToEdit(list); setIsListDialogOpen(true); } : undefined}
                    onDelete={canDelete ? () => setListToDelete(list) : undefined}
                  />
                </StaggerItem>
              );
            })}
          </Stagger>
        </>
      )}
    </>
  );
}
