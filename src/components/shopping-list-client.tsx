'use client';

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { onDataChanged } from '@/lib/data-changed';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import { AnimatePresence, motion } from 'motion/react';
import { collection, doc, updateDoc, deleteDoc, setDoc, query, waitForPendingWrites } from 'firebase/firestore';
import { ArchiveX, ArrowLeft, Loader2, Minus, Plus, PlusCircle, ScanBarcode, Settings, X } from 'lucide-react';
import { categorizeGroceryItem } from '@/ai/flows/categorize-grocery-item-flow';
import { getAiActionContext, unwrapAiActionResult } from '@/ai/client';
import { lookupBarcode } from '@/ai/flows/lookup-barcode-flow';
import { resolveShoppingCategory } from '@/lib/shopping-categorization';
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
import { useAuth } from '@/hooks/use-auth';
import { db } from '@/lib/firebase';
import { slugify, cn } from '@/lib/utils';
import { playFeedback } from '@/lib/feedback';
import { awaitWriteUnlessOffline, getDocOfflineAware, getDocsOfflineAware, isBrowserOffline } from '@/lib/firestore-offline';
import { DEFAULT_SHOPPING_CATEGORIES, buildShoppingListItem, normalizeStoredCategories } from '@/lib/shopping-items';
import { findMergeTarget, groupItemsByAisle, isTripComplete, normalizeItemName, pluralize, splitSettled, withoutIds, type QuickAddEntry } from '@/lib/shopping/items';
import { listTint } from '@/lib/shopping/list-style';
import type { PantryHandoffChoice } from '@/lib/shopping/pantry';
import { addPurchasesToPantry } from '@/lib/shopping/pantry-writes';
import { deleteStillPurchasedItems, mergeIntoNeededItem } from '@/lib/shopping/item-transactions';
import type { ShoppingListItem, ShoppingListCategory, ShoppingList, BarcodeLibraryItem } from '@/lib/types';
import { BarcodeScanner } from './barcode-scanner';
import { ListCard, type ListCounts } from './shopping/list-card';
import { ListDialog, type ListFormValues } from './shopping/list-dialog';
import { renderListIcon } from './shopping/list-icons';
import { ShoppingItemRow } from './shopping/shopping-item-row';
import { CartIndicator } from './shopping/cart-indicator';
import { useCartFlight } from './shopping/cart-flight';
import { QuickAddBar, type QuickAddOutcome } from './shopping/quick-add-bar';
import { TripReceiptDialog } from './shopping/trip-receipt-dialog';
import { PantryHandoffDialog } from './shopping/pantry-handoff-dialog';
import { useInPageMorph } from './shopping/use-in-page-morph';
import { LiveCount } from './shopping/live-count';
import { Stagger, StaggerItem } from '@/components/motion/stagger';
import { useReducedMotion } from '@/hooks/use-reduced-motion';
import { morphStyle, sharedId, staggerDelay } from '@/lib/motion';
import { ADD_SHOPPING_ITEM_SHORTCUT, shortcutTitle } from '@/lib/shopping/shortcut-hint';

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

function ManageCategoriesDialog({ categories, setCategories, householdId, listId, isListOpen, onUpdate }: { categories: ShoppingListCategory[], setCategories: React.Dispatch<React.SetStateAction<ShoppingListCategory[]>>, householdId: string, listId: string, /** False once another list is open, so a late save never overwrites its categories. */ isListOpen: () => boolean, onUpdate: () => void }) {
  const { toastError } = useToast();
  const [newCategory, setNewCategory] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isCategoryDialogOpen, setIsCategoryDialogOpen] = useState(false);

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
      if (isListOpen()) setCategories(updatedCategories);
      setNewCategory('');
      onUpdate();
    } catch (cause) {
      toastError(cause, 'Could not add the category');
    }
  };

  const removeCategory = async (categoryToRemove: string) => {
    if (categoryToRemove === 'Other') return;
    const updatedCategories = categories.filter(c => c !== categoryToRemove);
    try {
      await setDoc(categoriesDocRef, { list: updatedCategories });
      if (isListOpen()) setCategories(updatedCategories);
      onUpdate();
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
                    <button aria-label={`Remove ${category} category`} onClick={() => void removeCategory(category)} className="ml-1 rounded-full p-0.5 hover:bg-muted">
                      <X className="h-3 w-3" aria-hidden />
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

type AddResult = { name: string; merged: boolean; saved: 'saved' | 'queued'; usedFallback: boolean; reason?: string; category: string };

/** Entrance delay of one needed row, in walk order across the aisle groups (≤ 30 ms each, ≤ 400 ms total). */
const rowDelay = (groups: Array<{ items: unknown[] }>, groupIndex: number, itemIndex: number, total: number) => {
  const before = groups.slice(0, groupIndex).reduce((sum, group) => sum + group.items.length, 0);
  return (before + itemIndex) * staggerDelay(total);
};

const fallbackReasonText = (reason?: string) => reason === 'timeout'
  ? 'Automatic categorization timed out.'
  : reason === 'rate_limited'
    ? 'Automatic categorization is receiving too many requests.'
    : reason === 'configuration'
      ? 'Automatic categorization is not configured.'
      : 'Automatic categorization was unavailable.';

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

  const [lists, setLists] = useState<ShoppingList[]>([]);
  const [counts, setCounts] = useState<Record<string, ListCounts>>({});
  const [listItems, setListItems] = useState<ShoppingListItem[]>([]);
  const [categories, setCategories] = useState<ShoppingListCategory[]>(DEFAULT_SHOPPING_CATEGORIES);

  const [loading, setLoading] = useState(true);
  const [loadingItems, setLoadingItems] = useState(false);

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

  const offlineNoticeShownRef = useRef(false);
  const selectedListIdRef = useRef<string | null>(null);
  const listItemsRef = useRef<ShoppingListItem[]>([]);
  const reconcilingListRef = useRef<string | null>(null);
  const reconcileAgainRef = useRef(false);
  const fetchItemsRef = useRef<((listId: string, options?: { silent?: boolean }) => Promise<ShoppingListItem[] | null>) | null>(null);
  const purchasedSectionRef = useRef<HTMLDivElement>(null);

  const selectedList = useMemo(() => lists.find((list) => list.id === selectedListId) ?? null, [lists, selectedListId]);
  // After the first render of a loaded list, later rows (added, re-sorted) enter without the stagger.
  useEffect(() => {
    if (!selectedListId) enteredRowsRef.current = null;
    else if (!loadingItems && selectedList) enteredRowsRef.current = selectedListId;
  });
  listItemsRef.current = listItems;

  // Re-reads the list once Firestore has settled every queued write, so the screen
  // shows the confirmed state: rejected writes are rolled back in the local cache.
  // Used after a failed write and when a list loads with writes still queued (offline
  // ticks restored after a reload, whose rejection promises did not survive). Only one
  // pass runs per list at a time; a request made meanwhile triggers one more pass.
  const reconcileWithServer = useCallback((listId: string) => {
    if (reconcilingListRef.current === listId) {
      reconcileAgainRef.current = true;
      return;
    }
    reconcilingListRef.current = listId;
    reconcileAgainRef.current = false;
    waitForPendingWrites(db)
      .then(() => {
        if (selectedListIdRef.current === listId) return fetchItemsRef.current?.(listId, { silent: true });
      })
      .catch(() => undefined)
      .finally(() => {
        if (reconcilingListRef.current !== listId) return;
        reconcilingListRef.current = null;
        if (reconcileAgainRef.current) reconcileWithServer(listId);
      });
  }, []);
  // The open list's id (from the URL), so async results for another list are never shown.
  selectedListIdRef.current = selectedListId;

  // --- Data Fetching ---

  const getListsCollectionRef = useCallback(() => {
    if (!currentUser?.householdId) return null;
    return collection(db, 'households', currentUser.householdId, 'shopping-lists');
  }, [currentUser]);

  // Item counts for the list cards. Loaded after the lists so cards never wait on them.
  const fetchCounts = useCallback(async (loadedLists: ShoppingList[]) => {
    const householdId = currentUser?.householdId;
    if (!householdId) return;
    const entries = await Promise.all(loadedLists.map(async (list) => {
      try {
        const snapshot = await getDocsOfflineAware(query(collection(db, 'households', householdId, 'shopping-lists', list.id, 'items')));
        let needed = 0;
        let purchased = 0;
        snapshot.docs.forEach((itemDoc) => {
          if (itemDoc.data().status === 'purchased') purchased += 1;
          else needed += 1;
        });
        return [list.id, { needed, purchased }] as const;
      } catch {
        return null;
      }
    }));
    setCounts(Object.fromEntries(entries.filter((entry): entry is NonNullable<typeof entry> => entry !== null)));
  }, [currentUser]);

  const fetchLists = useCallback(async () => {
    const listsCollection = getListsCollectionRef();
    if (!listsCollection) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const snapshot = await getDocsOfflineAware(query(listsCollection));
      const listsData = snapshot.docs
        .map(doc => ({ id: doc.id, ...doc.data() } as ShoppingList))
        .sort((a, b) => a.name.localeCompare(b.name));
      setLists(listsData);
      void fetchCounts(listsData);
    } catch (error) {
      toastError(error, 'Could not load shopping lists');
    } finally {
      setLoading(false);
    }
  }, [getListsCollectionRef, toastError, fetchCounts]);

  // Re-reads a list. Resolves with the items read (the confirmed state, or the local
  // cache offline), or null when the read failed or another list is now open.
  const fetchItemsAndCategories = useCallback(async (listId: string, { silent = false }: { silent?: boolean } = {}): Promise<ShoppingListItem[] | null> => {
    if (!currentUser?.householdId) return null;
    if (!silent) setLoadingItems(true);
    try {
      const itemsCollection = collection(db, 'households', currentUser.householdId, 'shopping-lists', listId, 'items');
      const categoriesDoc = doc(db, 'households', currentUser.householdId, 'shopping-lists', listId, 'config', 'categories');

      const [itemsSnapshot, categoriesSnapshot] = await Promise.all([
        getDocsOfflineAware(query(itemsCollection)),
        getDocOfflineAware(categoriesDoc)
      ]);

      // The member may have opened another list meanwhile (e.g. an Undo toast for list A
      // pressed while list B is open): never render A's items under B's header.
      if (selectedListIdRef.current !== listId) return null;
      const itemsData = itemsSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as ShoppingListItem));
      setListItems(itemsData);

      // Ticks queued offline survive a reload, but the promise that would report a
      // server rejection does not: re-read once the queue settles.
      if (itemsSnapshot.docs.some(item => item.metadata.hasPendingWrites) && reconcilingListRef.current !== listId) {
        reconcileWithServer(listId);
      }

      const storedCategories = categoriesSnapshot.exists() ? normalizeStoredCategories(categoriesSnapshot.data()) : null;
      // Reset to default if no specific categories are set for this list
      setCategories(storedCategories ?? DEFAULT_SHOPPING_CATEGORIES);
      return itemsData;
    } catch (error) {
      if (selectedListIdRef.current === listId) toastError(error, 'Could not load list items');
      return null;
    } finally {
      if (!silent && selectedListIdRef.current === listId) setLoadingItems(false);
    }
  }, [currentUser, reconcileWithServer, toastError]);
  fetchItemsRef.current = fetchItemsAndCategories;

  useEffect(() => {
    if (currentUser?.householdId) {
      fetchLists();
    }
  }, [currentUser, fetchLists]);

  // Items added from elsewhere (the command palette's quick add): silently re-read
  // the open list if it changed, and the card counts. Reads stay offline-aware.
  useEffect(() => {
    const householdId = currentUser?.householdId;
    if (!householdId) return;
    return onDataChanged('shopping', householdId, (detail) => {
      if (detail.listId && selectedListIdRef.current === detail.listId) void fetchItemsRef.current?.(detail.listId, { silent: true });
      void fetchCounts(lists);
    });
  }, [currentUser?.householdId, fetchCounts, lists]);

  useEffect(() => {
    setOpenSections(['needed']);
    setIsReceiptOpen(false);
    if (selectedListId) {
      fetchItemsAndCategories(selectedListId);
    } else {
      setListItems([]);
    }
  }, [selectedListId, fetchItemsAndCategories]);

  // Back on the overview: refresh the card counts so they reflect the trip.
  const wasInListRef = useRef(false);
  useEffect(() => {
    if (selectedListId) {
      wasInListRef.current = true;
    } else if (wasInListRef.current) {
      wasInListRef.current = false;
      void fetchCounts(lists);
    }
  }, [selectedListId, fetchCounts, lists]);

  // A `?list=` link to a list that no longer exists falls back to the overview.
  useEffect(() => {
    if (loading || !selectedListId || !currentUser?.householdId) return;
    if (!lists.some((list) => list.id === selectedListId)) {
      onSelectList(null);
      toast({ title: 'List not found', description: 'That list was deleted or you no longer have access to it.' });
    }
  }, [loading, selectedListId, lists, onSelectList, toast, currentUser]);

  // The home-screen shortcut "Add to shopping" opens /shopping?quickAdd=1: open
  // the add-item dialog on the only list, or else on the first Grocery list.
  // The request comes from the URL on every render (useSearchParams), so it works
  // for a fresh load and for in-app navigation alike; handling it removes it.
  useEffect(() => {
    if (loading || !quickAddRequested) return;
    const target = canEdit ? (lists.length === 1 ? lists[0] : lists.find((list) => list.type === 'Grocery')) : undefined;
    onQuickAddHandled?.(target ? target.id : selectedListId);
    if (!canEdit) return;
    if (target) {
      setIsAddItemDialogOpen(true);
    } else if (lists.length > 0) {
      toast({ title: 'Choose a list', description: 'Open the list you want, then tap Add Item.' });
    }
  }, [loading, quickAddRequested, lists, onQuickAddHandled, selectedListId, toast, canEdit]);

  // --- List CRUD ---

  const handleSaveList = async (data: ListFormValues, id?: string) => {
    const listsCollection = getListsCollectionRef();
    if (!listsCollection) return;
    const listId = id || slugify(data.name);
    try {
      await setDoc(doc(listsCollection, listId), { ...data, name: data.name.trim() }, { merge: true });
      toast({ title: id ? 'List updated' : 'List created' });
      fetchLists();
    } catch (error) {
      toastError(error, 'Could not save the list');
    }
  };

  const handleDeleteList = async () => {
    const listIdToDelete = listToDelete?.id;
    if (!listIdToDelete) return;

    const listsCollection = getListsCollectionRef();
    if (!listsCollection) return;

    try {
      // This does not delete subcollections. For a production app, a Cloud Function would be needed for that.
      await deleteDoc(doc(listsCollection, listIdToDelete));
      toast({ title: 'List deleted' });
      setListToDelete(null);
      if (selectedListId === listIdToDelete) {
        onSelectList(null);
      }
      await fetchLists();
    } catch (error) {
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

  /**
   * Adds entries to the open list. A name that matches a still-needed item
   * (ignoring case and spacing) raises that item's quantity instead of creating a
   * duplicate. New items are categorized like before (manual category, else AI,
   * `Other` on any failure or while offline) and written through Firestore's queue.
   */
  const addEntries = async (
    entries: QuickAddEntry[],
    { selectedCategory, libraryItem, barcode }: { selectedCategory?: string; libraryItem?: BarcodeLibraryItem | null; barcode?: string } = {},
  ): Promise<{ results: AddResult[]; failed: QuickAddEntry[]; firstError?: unknown } | null> => {
    const householdId = currentUser?.householdId;
    const list = selectedList;
    if (!householdId || !list) return null;
    const offline = isBrowserOffline();
    const onLateError = (name: string) => (error: unknown) => {
      toastError(error, `Could not sync ${name}`);
      reconcileWithServer(list.id);
    };

    // Each entry is its own write: settle them all, so one failure never hides
    // which entries were saved (and a retry never adds those twice).
    const settled = await Promise.allSettled(entries.map(async (entry): Promise<AddResult> => {
      // The list on screen comes from a one-time read, so its statuses can be stale.
      // Online, the merge re-reads the target in a transaction and only increments it
      // if it is still needed; otherwise (bought or deleted meanwhile) a new needed
      // item is created below. Offline, transactions cannot run, so there is no merge
      // at all: a new needed item is queued. A duplicate is harmless; folding an
      // addition into an item someone already bought would lose it.
      const target = offline ? undefined : findMergeTarget(listItemsRef.current, entry.name);
      if (target) {
        const merged = await mergeIntoNeededItem(doc(db, 'households', householdId, 'shopping-lists', list.id, 'items', target.id), entry.quantity);
        if (merged) return { name: target.name, merged: true, saved: 'saved', usedFallback: false, category: target.category };
      }
      const categoryResult = await resolveShoppingCategory({
        itemName: entry.name,
        categories,
        // Offline there is no model to ask; save under Other like any AI fallback.
        selectedCategory: selectedCategory || (offline ? 'Other' : undefined),
        categorize: async categorizeInput => unwrapAiActionResult(await categorizeGroceryItem(
          categorizeInput,
          await getAiActionContext(householdId)
        )),
      });
      const { itemId, data } = buildShoppingListItem({
        name: entry.name,
        quantity: entry.quantity,
        category: categoryResult.category,
        imageUrl: libraryItem?.imageUrl,
        barcode,
      });
      const saved = await awaitWriteUnlessOffline(
        setDoc(doc(db, 'households', householdId, 'shopping-lists', list.id, 'items', itemId), data),
        onLateError(entry.name),
      );
      return { name: entry.name, merged: false, saved, usedFallback: categoryResult.usedFallback && !offline, reason: categoryResult.reason, category: categoryResult.category };
    }));
    const { succeeded, failed, firstError } = splitSettled(entries, settled);

    if (succeeded.length > 0) playFeedback('add');
    // Always refresh: whatever was saved shows, even when other entries failed.
    await fetchItemsAndCategories(list.id, { silent: true });
    return { results: succeeded, failed, firstError };
  };

  const reportAddResults = (results: AddResult[]) => {
    const queued = results.some((result) => result.saved === 'queued');
    if (results.length === 1) {
      const [result] = results;
      toast(queued
        ? { title: 'Item Added Offline', description: `${result.name} will sync when you are back online.` }
        : result.merged
          ? { title: 'Quantity updated', description: `${result.name} was already on the list, so its quantity went up.` }
          : { title: 'Item Added', description: `${result.name} was added to the ${result.category} category.` });
    } else {
      const merged = results.filter((result) => result.merged).length;
      toast({
        title: queued ? `${pluralize(results.length, 'item')} added offline` : `${pluralize(results.length, 'item')} added`,
        description: queued
          ? 'They will sync when you are back online.'
          : merged > 0 ? `${pluralize(merged, 'item')} already on the list had the quantity raised.` : undefined,
      });
    }
    const fallback = results.filter((result) => result.usedFallback);
    if (fallback.length === 1) {
      toast({ title: 'Item saved to Other', description: `${fallbackReasonText(fallback[0].reason)} You can update ${fallback[0].name} later.` });
    } else if (fallback.length > 1) {
      toast({ title: 'Items saved to Other', description: `${fallbackReasonText(fallback[0].reason)} You can update their categories later.` });
    }
  };

  const onAddItemSubmit = async (values: z.infer<typeof itemSchema>, libraryItem?: BarcodeLibraryItem | null, barcode?: string) => {
    const name = normalizeItemName(values.name);
    try {
      const outcome = await addEntries([{ name, quantity: values.quantity }], { selectedCategory: values.category, libraryItem, barcode });
      if (!outcome) return;
      if (outcome.failed.length > 0) {
        // Nothing was saved: keep the dialog and its values for a retry.
        toastError(outcome.firstError, 'Could not add the item');
        return;
      }
      reportAddResults(outcome.results);
      form.reset({ name: '', quantity: 1, category: '' });
      setIsAddItemDialogOpen(false);
    } catch (error) {
      toastError(error, 'Could not add the item');
    }
  };

  // Saved entries are reported; failed ones go back into the field with an inline
  // message naming them (QuickAddBar), so a retry only adds what is missing.
  const onQuickAdd = async (entries: QuickAddEntry[]): Promise<QuickAddOutcome> => {
    try {
      const outcome = await addEntries(entries);
      if (!outcome) return null;
      if (outcome.results.length > 0) reportAddResults(outcome.results);
      return { failed: outcome.failed };
    } catch (error) {
      toastError(error, 'Could not add the items');
      return null;
    }
  };

  const handleBarcodeScan = async (barcode: string) => {
    if (!currentUser?.householdId) return;
    setIsScannerOpen(false);
    toast({ title: 'Barcode scanned', description: 'Looking up the product…' });
    try {
      const result = unwrapAiActionResult(await lookupBarcode(
        { barcode },
        await getAiActionContext(currentUser.householdId)
      ));
      const { productName, libraryItem } = result;
      const finalName = libraryItem?.name || productName;
      if (finalName) {
        await onAddItemSubmit({ name: finalName, quantity: result.quantity || 1 }, libraryItem, barcode);
      } else {
        toast({ variant: 'destructive', title: 'Product not found', description: 'No product matches that barcode. You can add it to your Barcode Library.' });
      }
    } catch (error) {
      toastError(error, 'Barcode lookup failed');
    }
  };

  const toggleItemStatus = async (item: ShoppingListItem) => {
      if (!currentUser?.householdId || !selectedList) return;

      const isCheckingOff = item.status === 'needed';
      const newStatus = isCheckingOff ? 'purchased' : 'needed';
      const list = selectedList;
      // The write always targets the item's own list; the screen is only touched while
      // that list is still the open one (an Undo can arrive after switching lists).
      const isListOpen = () => selectedListIdRef.current === list.id;
      const lastNeeded = isCheckingOff && isListOpen()
        && listItemsRef.current.filter(listItem => listItem.status === 'needed' && listItem.id !== item.id).length === 0;
      const setItemStatus = (status: ShoppingListItem['status']) => {
        if (!isListOpen()) return;
        setListItems(prev => prev.map(listItem => listItem.id === item.id ? { ...listItem, status } : listItem));
      };
      // A failed write is not undone by restoring this tick's starting status: several
      // ticks on one item can be queued offline and fail together, and each captured a
      // different predecessor. Show the confirmed state from Firestore instead.
      const failToggle = () => {
        toast({ variant: 'destructive', title: 'Error', description: 'Could not update item status.' });
        // The receipt was opened optimistically on the last tick; a rejected tick
        // means the trip is not complete after all.
        if (isListOpen()) setIsReceiptOpen(false);
        reconcileWithServer(list.id);
      };

      // Into the cart (H07): a copy of the name flies from the row (measured before
      // the row leaves) into the cart icon; skipped under reduced motion.
      if (isCheckingOff && isListOpen()) {
        const row = document.querySelector(`[data-testid="shopping-item-${CSS.escape(item.id)}"]`);
        cartFlight.launch(row?.querySelector('label') ?? row ?? null, item.name);
      }

      // Show the tick immediately. Offline, the write waits in Firestore's persistent
      // queue (it survives reloads) and syncs when the connection returns.
      setItemStatus(newStatus);
      const itemRef = doc(db, 'households', currentUser.householdId, 'shopping-lists', list.id, 'items', item.id);
      const write = updateDoc(itemRef, { status: newStatus });

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
        if (!offlineNoticeShownRef.current) {
          offlineNoticeShownRef.current = true;
          toast({ title: 'You are offline', description: 'Ticks are saved on this device and sync when you reconnect.' });
        } else if (isCheckingOff) {
          showTickUndo(item);
        }
        return;
      }

      if (isCheckingOff) showTickUndo(item);

      try {
        await write;
        // Online, "trip complete" is decided from the confirmed list (another member
        // may have added items since this device last read it), not from the cache.
        const confirmed = await fetchItemsAndCategories(list.id, { silent: true });
        if (isCheckingOff && confirmed && isListOpen() && isTripComplete(confirmed)) {
          playFeedback('celebrate');
          setIsReceiptOpen(true);
        }
      } catch {
          failToggle();
      }
  };

  // "Milk is in the cart · Undo" for five seconds after a tick.
  const showTickUndo = (item: ShoppingListItem) => {
    toast({
      title: `${item.name} is in the cart`,
      duration: 5000,
      action: (
        <ToastAction
          altText={`Undo ticking ${item.name}`}
          onClick={() => {
            setIsReceiptOpen(false);
            void toggleItemStatus({ ...item, status: 'purchased' });
          }}
        >
          Undo
        </ToastAction>
      ),
    });
  };

  // Deletes at once, with five seconds to undo (the item is written back as it was).
  const deleteItem = async (item: ShoppingListItem) => {
    const householdId = currentUser?.householdId;
    const list = selectedList;
    if (!householdId || !list) return;
    const itemRef = doc(db, 'households', householdId, 'shopping-lists', list.id, 'items', item.id);
    setListItems(prev => prev.filter(listItem => listItem.id !== item.id));
    try {
      await awaitWriteUnlessOffline(deleteDoc(itemRef), (error) => {
        toastError(error, `Could not delete ${item.name}`);
        reconcileWithServer(list.id);
      });
    } catch (error) {
      toastError(error, `Could not delete ${item.name}`);
      await fetchItemsAndCategories(list.id, { silent: true });
      return;
    }
    const { id: _id, ...data } = item;
    void _id;
    toast({
      title: `${item.name} removed`,
      duration: 5000,
      action: canEdit ? (
        <ToastAction
          altText={`Undo removing ${item.name}`}
          onClick={() => {
            // The restore always writes to the item's own list; the screen is only
            // touched if that list is still the open one.
            if (selectedListIdRef.current === list.id) {
              setListItems(prev => (prev.some(listItem => listItem.id === item.id) ? prev : [...prev, item]));
            }
            awaitWriteUnlessOffline(setDoc(itemRef, data), (error) => {
              toastError(error, `Could not restore ${item.name}`);
              reconcileWithServer(list.id);
            })
              .then(() => fetchItemsAndCategories(list.id, { silent: true }))
              .catch((error: unknown) => {
                toastError(error, `Could not restore ${item.name}`);
                void fetchItemsAndCategories(list.id, { silent: true });
              });
          }}
        >
          Undo
        </ToastAction>
      ) : undefined,
    });
  };

  /**
   * Deletes exactly `itemIds` (the purchased items the member confirmed, captured
   * when they pressed Clear), never "whatever is purchased now": an item ticked
   * while the dialog or the batch is pending stays. Afterwards only those ids leave
   * the screen, and "the list is empty, delete it?" is decided from a re-read of
   * the list (the confirmed state), not from a local status filter.
   */
  const clearPurchasedItems = async (itemIds: readonly string[]) => {
    if (!currentUser?.householdId || !selectedList) return;
    // Only clear the list that is on screen: the ids below came from it.
    if (selectedListIdRef.current !== selectedList.id) return;
    const list = selectedList;
    const householdId = currentUser.householdId;
    const ids = [...new Set(itemIds)];
    setIsClearAlertOpen(false);
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
      await afterCleared(list, deleted);
    } catch (error) {
      toastError(error, 'Could not clear purchased items');
      void fetchItemsAndCategories(list.id, { silent: true });
    }
  };

  // After a confirmed clear: drop exactly the deleted ids, then decide "empty"
  // from a re-read. Leaves another list's screen alone.
  const afterCleared = async (list: ShoppingList, deleted: string[]) => {
    if (selectedListIdRef.current !== list.id) return;
    setIsReceiptOpen(false);
    setListItems(prev => withoutIds(prev, deleted));
    const confirmed = await fetchItemsAndCategories(list.id, { silent: true });
    if (confirmed && confirmed.length === 0 && selectedListIdRef.current === list.id) {
      setListToDelete(list);
      setIsArchiveAlertOpen(true);
    }
  };

  // `shownIds` are the purchased items listed in the dialog (ticked or not): with
  // "then clear", exactly those are cleared after the pantry write succeeds.
  const sendToPantry = async (choices: PantryHandoffChoice[], shownIds: string[]): Promise<boolean> => {
    const householdId = currentUser?.householdId;
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
      if (thenClear) await afterCleared(list, cleared);
      else void fetchItemsAndCategories(list.id, { silent: true });
      return true;
    } catch (error) {
      toastError(error, 'Could not add to the pantry');
      return false;
    }
  };

  const archiveList = async () => {
    await handleDeleteList();
    setIsArchiveAlertOpen(false);
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

  if (loading) {
    return (
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3" role="status" aria-label="Loading shopping lists">
        <Skeleton className="h-48 w-full" />
        <Skeleton className="h-48 w-full" />
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
    const tint = listTint(selectedList);
    const canHandoff = selectedList.type === 'Grocery' && canEdit && online;

    return (
        <>
            {cartFlight.layer}
            <AlertDialog open={isClearAlertOpen} onOpenChange={setIsClearAlertOpen}>
                <AlertDialogContent>
                    <AlertDialogHeader>
                    <AlertDialogTitle>Clear {pluralize(purchasedItems.length, 'purchased item')}?</AlertDialogTitle>
                    <AlertDialogDescription>
                        {canHandoff
                          ? 'They will be removed from this list. You can put them on the pantry shelves first.'
                          : 'They will be removed from this list. This cannot be undone.'}
                    </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter className="gap-2">
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction onClick={() => void clearPurchasedItems(purchasedItems.map(item => item.id))} className={buttonVariants({ variant: canHandoff ? 'outline' : 'destructive' })}>
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
                    <AlertDialogAction onClick={archiveList} className={buttonVariants({ variant: "destructive"})}>
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
              onClearPurchased={canDelete ? () => { setIsReceiptOpen(false); setIsClearAlertOpen(true); } : undefined}
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
            <div className="rounded-xl border bg-card text-card-foreground shadow-raised" data-testid="open-list" style={morphStyle(listMorph.morphName === listMorphName ? listMorphName : null)}>
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
                        {currentUser?.householdId && <ManageCategoriesDialog categories={categories} setCategories={setCategories} householdId={currentUser.householdId} listId={selectedList.id} isListOpen={() => selectedListIdRef.current === selectedList.id} onUpdate={() => fetchItemsAndCategories(selectedList.id, { silent: true })}/>}
                        <Dialog open={isAddItemDialogOpen} onOpenChange={setIsAddItemDialogOpen}>
                        <DialogTrigger asChild>
                            <Button className="w-full sm:w-auto" title={shortcutTitle('Add item', ADD_SHOPPING_ITEM_SHORTCUT)}><PlusCircle className="mr-2" aria-hidden /> Add Item</Button>
                        </DialogTrigger>
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
                                            <Button type="button" variant="outline" size="icon" aria-label="Decrease item quantity" className="h-10 w-10" onClick={() => adjustQuantity(-1)} disabled={currentQuantity <= 1}>
                                                <Minus className="h-4 w-4" aria-hidden />
                                            </Button>
                                            <FormControl>
                                                <Input type="number" min={1} max={999} className="text-center" {...field} />
                                            </FormControl>
                                            <Button type="button" variant="outline" size="icon" aria-label="Increase item quantity" className="h-10 w-10" onClick={() => adjustQuantity(1)}>
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
                                    <Button type="submit" disabled={form.formState.isSubmitting}>
                                        {form.formState.isSubmitting ? ( <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden /> ) : ( "Add to List" )}
                                    </Button>
                                </DialogFooter>
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
                            <AccordionTrigger className="font-headline text-lg"><span>Needed (<LiveCount value={neededItems.length} />)</span></AccordionTrigger>
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
                                          canDelete={canDelete}
                                          onToggle={toggleItemStatus}
                                          onDelete={deleteItem}
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
                                <AccordionTrigger className="flex-1 font-headline text-lg"><span>Purchased (<LiveCount value={purchasedItems.length} />)</span></AccordionTrigger>
                                {purchasedItems.length > 0 && canDelete && (
                                    <Button variant="ghost" size="sm" onClick={() => setIsClearAlertOpen(true)} className="text-muted-foreground hover:text-destructive">
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
                                      canDelete={canDelete}
                                      onToggle={toggleItemStatus}
                                      onDelete={deleteItem}
                                    />
                                ))}
                                </AnimatePresence>
                                {purchasedItems.length === 0 && <p className="py-4 text-center text-sm text-muted-foreground">Nothing in the cart yet. Tick items as you shop.</p>}
                                </div>
                            </AccordionContent>
                            </AccordionItem>
                        </Accordion>
                        {/* Keyed per list: a pending save's leftovers never land in another list's field. */}
                        {canEdit && <QuickAddBar key={selectedList.id} listName={selectedList.name} onAdd={onQuickAdd} />}
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
              This will permanently delete this list and all its items. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className={buttonVariants({ variant: "destructive" })}
              onClick={handleDeleteList}>
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
