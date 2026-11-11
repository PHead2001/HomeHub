'use client';

import { useEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, Settings, Store, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { FieldError, fieldErrorProps } from '@/components/field-error';
import { toast, toastError } from '@/hooks/use-toast';
import { cn } from '@/lib/utils';
import {
  CategoryChangeDeclined,
  categoryKey,
  declinedMessage,
  addNeedsCompaction,
  changeNeedsTransaction,
  checkStoreName,
  initialAisleOrder,
  isOtherCategory,
  listOrderAtStore,
  planCategoryAdd,
  planCategoryRemove,
  type CategoryConfig,
  type MoveDirection,
} from '@/lib/shopping/category-order';
import {
  assignListStore,
  createStoreForList,
  reorderListCategory,
  reorderStoreAisle,
  writeCategoryPlan,
  writeSeededCategoryChange,
} from '@/lib/shopping/category-writes';
import type { AssignedStore } from '@/lib/shopping/assigned-store';
import type { ShoppingList, ShoppingStore } from '@/lib/types';
import { useOnTabDeactivate } from './tab-activity';
import { useSaveLine } from './use-save-line';
import { createSettledQueue, rejectedInputRestore } from '@/lib/shopping/save-line';

const NO_STORE = '__none__';
const NEW_STORE = '__new__';

/** 44 px controls, 48 px on touch (D-2). */
const ICON_CONTROL = 'flex h-11 w-11 shrink-0 items-center justify-center rounded-full transition-ui hover:bg-muted aria-disabled:cursor-not-allowed aria-disabled:opacity-40 [@media(pointer:coarse)]:h-12 [@media(pointer:coarse)]:w-12';

// A write that ran but declined (list full, changed by someone else) says what to do;
// anything else goes through toastError's plain-language mapping.
const reportFailure = (error: unknown, title: string) => {
  if (error instanceof CategoryChangeDeclined) {
    toast({ variant: 'destructive', title, description: declinedMessage(error.reason) });
    return;
  }
  toastError(error, title);
};

/**
 * Categories and aisle order for the open list (S6: SH-10c, SH-34a/b). Adding and
 * removing categories are `arrayUnion`/`arrayRemove` writes (queued offline);
 * moving one is a transaction on the server's current order (online only), and
 * while the list is at a store the move changes that store's aisle order, shared
 * by every list at the store. Everything shown comes from the live listeners, so
 * another member's edits appear as they land. Each write reports through the S2
 * save path in the dialog's status line. While the list names a store that has
 * not loaded yet (`assignedStore`), moves, the store select and New store wait:
 * neither the move's target nor the order a new store would start from is known.
 */
export function CategoriesDialog({
  householdId,
  list,
  config,
  stores,
  assigned,
  storesListed,
  uid,
  online,
  open: openProp,
  onOpenChange,
  showTrigger = true,
  onCloseAutoFocus,
}: {
  householdId: string;
  list: ShoppingList;
  config: CategoryConfig;
  stores: ShoppingStore[];
  /** The store the list follows (`store` null: its own order), and whether that is known yet. */
  assigned: AssignedStore<ShoppingStore>;
  /** A stores snapshot has arrived, so `stores` can be picked from and names checked against. */
  storesListed: boolean;
  uid: string | null;
  online: boolean;
  /** Controlled open state (the open list's overflow menu opens it, S8b). */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Draws the "Manage Categories" button (off when a menu item opens the dialog instead). */
  showTrigger?: boolean;
  /** Where focus goes when the dialog closes (opened from a menu, it has no trigger to return to). */
  onCloseAutoFocus?: (event: Event) => void;
}) {
  const [ownOpen, setOwnOpen] = useState(false);
  const open = openProp ?? ownOpen;
  const setOpen = (next: boolean) => (onOpenChange ? onOpenChange(next) : setOwnOpen(next));
  const [newCategory, setNewCategory] = useState('');
  const [categoryError, setCategoryError] = useState<string | null>(null);
  const [creatingStore, setCreatingStore] = useState(false);
  const [storeName, setStoreName] = useState('');
  const [storeError, setStoreError] = useState<string | null>(null);
  // The New store field as typed now (read when a store create is rejected later).
  const storeNameRef = useRef(storeName);
  useEffect(() => {
    storeNameRef.current = storeName;
  }, [storeName]);
  const [announcement, setAnnouncement] = useState('');
  const save = useSaveLine(reportFailure);
  // Moves run one after another, each on the order the server holds by then: the
  // next starts only once the previous transaction has finally settled, even when
  // its status line gave up waiting after 4 s (so they commit in click order).
  const [enqueueMove] = useState(() => createSettledQueue());

  useOnTabDeactivate(() => setOpen(false));

  const store = assigned.store;
  // Moves only once the list's store is loaded or confirmed gone (or it names none);
  // store changes and New store also need the stores listed (choices, name check).
  const movesReady = assigned.resolved;
  const storeChoiceReady = assigned.resolved && storesListed;
  const order = store ? listOrderAtStore(store.aisleOrder, config.list) : config.list;
  const movable = order.filter((category) => !isOtherCategory(category));
  // A queued move runs later: it reads the store and categories as they are then,
  // not as they were when it was clicked.
  const latest = useRef({ store, resolved: assigned.resolved, listOrder: config.list });
  useEffect(() => {
    latest.current = { store, resolved: assigned.resolved, listOrder: config.list };
  }, [store, assigned.resolved, config.list]);

  // React may re-insert the moved row, which drops focus: put it back on the same
  // control once the new order is drawn, unless the member has moved on.
  const listRef = useRef<HTMLOListElement>(null);
  const focusAfterMove = useRef<string | null>(null);
  const orderSignature = order.join('|');
  useEffect(() => {
    const label = focusAfterMove.current;
    if (!label) return;
    focusAfterMove.current = null;
    // Focus survived the re-render, or the member moved on: leave it.
    const active = document.activeElement;
    if (active && active !== document.body) return;
    const control = [...(listRef.current?.querySelectorAll<HTMLButtonElement>('button[aria-label]') ?? [])]
      .find((button) => button.getAttribute('aria-label') === label);
    control?.focus();
  }, [orderSignature]);

  const addCategory = async () => {
    const result = planCategoryAdd(newCategory, config);
    if (!result.ok) {
      setCategoryError(result.error);
      return;
    }
    // A full `ordered` with stale entries is compacted in a transaction, which needs a connection.
    if (!online && addNeedsCompaction(config)) {
      setCategoryError('Adding a category to this list needs a connection right now. Try again once you are online.');
      return;
    }
    setCategoryError(null);
    setNewCategory('');
    // The first edit that introduces `ordered`, or an add that must compact it,
    // re-reads the document in a transaction online; otherwise (and offline) one
    // arrayUnion write.
    const seed = online && changeNeedsTransaction(config, 'add');
    const write: Promise<unknown> = seed
      ? writeSeededCategoryChange(householdId, list.id, { kind: 'add', name: result.name })
      : writeCategoryPlan(householdId, list.id, result.plan);
    // A refused or declined add (at once, or later when it was queued or slow)
    // goes back into the field unless something newer was typed there; the toast
    // names it and, for a declined transaction, says why (list full, changed).
    await save.track(write, {
      kind: seed ? 'transaction' : 'write',
      subject: `${result.name} added`,
      failTitle: `Could not add ${result.name}`,
      onRejected: () => setNewCategory((current) => rejectedInputRestore(current, result.name).value),
    });
  };

  const removeCategory = (category: string) => {
    const plan = planCategoryRemove(category, config);
    if (!plan) return;
    const seed = online && changeNeedsTransaction(config, 'remove');
    const write: Promise<unknown> = seed
      ? writeSeededCategoryChange(householdId, list.id, { kind: 'remove', category })
      : writeCategoryPlan(householdId, list.id, plan);
    void save.track(write, {
      kind: seed ? 'transaction' : 'write',
      subject: `${category} removed`,
      failTitle: `Could not remove ${category}`,
    });
  };

  const move = (category: string, direction: MoveDirection) => {
    if (!online || !movesReady) return;
    const index = movable.findIndex((entry) => categoryKey(entry) === categoryKey(category));
    const target = index + direction;
    if (index < 0 || target < 0 || target >= movable.length) return;
    const where = direction === -1 ? 'up' : 'down';
    focusAfterMove.current = `Move ${category} ${where}`;
    const run = async () => {
      const now = latest.current;
      // A move that can no longer apply (gone, already at the end, store removed)
      // rejects with CategoryChangeDeclined and is reported, never shown as saved.
      // So does one whose list was meanwhile moved to a store not loaded yet: it
      // must not fall through to the list's own order.
      const write = !now.resolved
        ? Promise.reject(new CategoryChangeDeclined('stale'))
        : now.store
          ? reorderStoreAisle(householdId, now.store.id, now.listOrder, category, direction)
          : reorderListCategory(householdId, list.id, category, direction);
      const tracked = await save.track(write, {
        kind: 'transaction',
        subject: `${category} moved ${where}`,
        failTitle: `Could not move ${category}`,
      });
      if (tracked.state !== 'failed') setAnnouncement(`${category} moved ${where}, position ${target + 1} of ${movable.length}.`);
      return tracked;
    };
    void enqueueMove(run);
  };

  const chooseStore = (value: string) => {
    if (value === NEW_STORE) {
      setCreatingStore(true);
      setStoreError(null);
      return;
    }
    setCreatingStore(false);
    if (!storeChoiceReady) return;
    const storeId = value === NO_STORE ? null : value;
    // Compared with the list's `storeId`, so No store also clears a store that was deleted.
    if (assigned.storeId === storeId) return;
    const chosen = stores.find((entry) => entry.id === storeId);
    void save.track(assignListStore(householdId, list.id, storeId), {
      kind: 'write',
      subject: chosen ? `Sorted for ${chosen.name}` : 'Own order',
      failTitle: 'Could not change the store',
    });
  };

  const createStore = async () => {
    if (!uid || !storeChoiceReady) return;
    const check = checkStoreName(storeName, stores);
    if (!check.ok) {
      setStoreError(check.error);
      return;
    }
    setStoreError(null);
    const { write } = createStoreForList(householdId, list.id, { name: check.name, aisleOrder: initialAisleOrder(order), uid });
    setCreatingStore(false);
    setStoreName('');
    await save.track(write, {
      kind: 'write',
      subject: `${check.name} created`,
      failTitle: `Could not create ${check.name}`,
      // The name comes back in the New store field unless another name was typed since.
      onRejected: () => {
        const restore = rejectedInputRestore(storeNameRef.current, check.name);
        if (!restore.restored) return;
        setStoreName(restore.value);
        setCreatingStore(true);
      },
    });
  };

  // Empty (the placeholder) until the list's store is known: never "No store" for a store still loading.
  const selectValue = !storeChoiceReady ? '' : creatingStore ? NEW_STORE : store?.id ?? NO_STORE;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          setCategoryError(null);
          setStoreError(null);
          setCreatingStore(false);
          setAnnouncement('');
          save.clear();
        }
      }}
    >
      {showTrigger && (
        <DialogTrigger asChild>
          <Button variant="outline" className="w-full sm:w-auto"><Settings className="mr-2 h-4 w-4" aria-hidden /> Manage Categories</Button>
        </DialogTrigger>
      )}
      <DialogContent phoneSheet className="max-h-[90dvh] overflow-y-auto" onCloseAutoFocus={onCloseAutoFocus}>
        <DialogHeader>
          <DialogTitle className="font-headline">Manage Categories</DialogTitle>
          <DialogDescription>
            {!movesReady
              ? 'Loading this list’s store. The list is grouped in that store’s aisle order.'
              : store
                ? `Items are grouped in the order you walk ${store.name}. Every list at ${store.name} shares this aisle order. Other is always last.`
                : 'Items are grouped in this order. Move categories to match how you walk the store. Other is always last and cannot be removed.'}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5 py-2">
          <section className="space-y-2" aria-labelledby="store-heading">
            <h3 id="store-heading" className="flex items-center gap-2 font-medium"><Store className="h-4 w-4" aria-hidden /> Store</h3>
            <Select value={selectValue} onValueChange={chooseStore} disabled={!storeChoiceReady}>
              <SelectTrigger aria-label="Store for this list" className="h-11 [@media(pointer:coarse)]:h-12">
                <SelectValue placeholder="Loading stores…" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_STORE}>No store (this list&apos;s own order)</SelectItem>
                {stores.map((entry) => (
                  <SelectItem key={entry.id} value={entry.id}>{entry.name || 'Unnamed store'}</SelectItem>
                ))}
                {uid && <SelectItem value={NEW_STORE}>New store…</SelectItem>}
              </SelectContent>
            </Select>
            {creatingStore && (
              <div className="space-y-1">
                <label htmlFor="new-store-name" className="text-sm font-medium">New store name</label>
                <div className="flex gap-2">
                  <Input
                    value={storeName}
                    autoFocus
                    maxLength={80}
                    placeholder="e.g. Costco"
                    onChange={(event) => { setStoreName(event.target.value); if (storeError) setStoreError(null); }}
                    onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); void createStore(); } }}
                    {...fieldErrorProps('new-store-name', storeError)}
                  />
                  <Button type="button" onClick={() => void createStore()}>Create store</Button>
                </div>
                <FieldError id="new-store-name">{storeError}</FieldError>
                <p className="text-sm text-muted-foreground">It starts with the order shown below.</p>
              </div>
            )}
          </section>

          <section className="space-y-2" aria-labelledby="add-category-heading">
            <h3 id="add-category-heading" className="font-medium">Add a category</h3>
            <div className="flex gap-2">
              <label htmlFor="new-category" className="sr-only">New category name</label>
              <Input
                value={newCategory}
                maxLength={80}
                onChange={(event) => { setNewCategory(event.target.value); if (categoryError) setCategoryError(null); }}
                placeholder="New category name"
                onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); void addCategory(); } }}
                {...fieldErrorProps('new-category', categoryError)}
              />
              <Button type="button" onClick={() => void addCategory()}>Add</Button>
            </div>
            <FieldError id="new-category">{categoryError}</FieldError>
          </section>

          <section className="space-y-2" aria-labelledby="order-heading">
            <h3 id="order-heading" className="font-medium">{store ? `Aisle order at ${store.name}` : movesReady ? 'Category order' : 'Aisle order'}</h3>
            {!online && <p className="text-sm text-muted-foreground">Moving categories needs a connection. Adding and removing still work.</p>}
            {online && !movesReady && <p className="text-sm text-muted-foreground" data-testid="categories-store-loading">Loading this list&apos;s store. Moving categories waits until it has loaded.</p>}
            <ol ref={listRef} aria-labelledby="order-heading" className="divide-y rounded-lg border">
              {order.map((category) => {
                const other = isOtherCategory(category);
                const index = movable.findIndex((entry) => categoryKey(entry) === categoryKey(category));
                const upDisabled = other || !online || !movesReady || index <= 0;
                const downDisabled = other || !online || !movesReady || index < 0 || index >= movable.length - 1;
                return (
                  <li key={categoryKey(category)} data-category={category} className="flex items-center gap-1 py-0.5 pl-3 pr-1">
                    <span className="min-w-0 flex-1 break-words">{category}</span>
                    {other ? (
                      <span className="pr-3 text-sm text-muted-foreground">Always last</span>
                    ) : (
                      <>
                        <button
                          type="button"
                          aria-label={`Move ${category} up`}
                          aria-disabled={upDisabled || undefined}
                          className={ICON_CONTROL}
                          onClick={() => { if (!upDisabled) move(category, -1); }}
                        >
                          <ArrowUp className="h-4 w-4" aria-hidden />
                        </button>
                        <button
                          type="button"
                          aria-label={`Move ${category} down`}
                          aria-disabled={downDisabled || undefined}
                          className={ICON_CONTROL}
                          onClick={() => { if (!downDisabled) move(category, 1); }}
                        >
                          <ArrowDown className="h-4 w-4" aria-hidden />
                        </button>
                        <button
                          type="button"
                          aria-label={`Remove ${category} category`}
                          className={cn(ICON_CONTROL, 'hover:text-destructive')}
                          onClick={() => removeCategory(category)}
                        >
                          <X className="h-4 w-4" aria-hidden />
                        </button>
                      </>
                    )}
                  </li>
                );
              })}
            </ol>
          </section>
          <p role="status" aria-live="polite" className="min-h-5 text-sm text-muted-foreground" data-testid="categories-save-status">{save.text}</p>
          <p aria-live="polite" className="sr-only">{announcement}</p>
        </div>

        <DialogFooter>
          <Button variant="secondary" onClick={() => setOpen(false)}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
