'use client';

import { useEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, Settings, Store, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { FieldError, fieldErrorProps } from '@/components/field-error';
import { toastError } from '@/hooks/use-toast';
import { cn } from '@/lib/utils';
import {
  categoryKey,
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
  TooManyAislesError,
  writeCategoryPlan,
} from '@/lib/shopping/category-writes';
import type { ShoppingList, ShoppingStore } from '@/lib/types';
import { useOnTabDeactivate } from './tab-activity';
import { useSaveLine } from './use-save-line';

const NO_STORE = '__none__';
const NEW_STORE = '__new__';

/** 44 px controls, 48 px on touch (D-2). */
const ICON_CONTROL = 'flex h-11 w-11 shrink-0 items-center justify-center rounded-full transition-ui hover:bg-muted aria-disabled:cursor-not-allowed aria-disabled:opacity-40 [@media(pointer:coarse)]:h-12 [@media(pointer:coarse)]:w-12';

const reportFailure = (error: unknown, title: string) => {
  if (error instanceof TooManyAislesError) {
    toastError(new Error('This store already has 200 aisles.'), title);
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
 * save path in the dialog's status line.
 */
export function CategoriesDialog({
  householdId,
  list,
  config,
  stores,
  store,
  uid,
  online,
}: {
  householdId: string;
  list: ShoppingList;
  config: CategoryConfig;
  stores: ShoppingStore[];
  /** The store the list follows (null: its own order). */
  store: ShoppingStore | null;
  uid: string | null;
  online: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [newCategory, setNewCategory] = useState('');
  const [categoryError, setCategoryError] = useState<string | null>(null);
  const [creatingStore, setCreatingStore] = useState(false);
  const [storeName, setStoreName] = useState('');
  const [storeError, setStoreError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const save = useSaveLine(reportFailure);
  // Moves run one after another, each on the order the server holds by then.
  const moveChain = useRef<Promise<unknown>>(Promise.resolve());

  useOnTabDeactivate(() => setOpen(false));

  const order = store ? listOrderAtStore(store.aisleOrder, config.list) : config.list;
  const movable = order.filter((category) => !isOtherCategory(category));

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
    setCategoryError(null);
    setNewCategory('');
    const tracked = await save.track(writeCategoryPlan(householdId, list.id, result.plan), {
      kind: 'write',
      subject: `${result.name} added`,
      failTitle: `Could not add ${result.name}`,
    });
    // A refused add goes back into the field.
    if (tracked.state === 'failed') setNewCategory((current) => current || result.name);
  };

  const removeCategory = (category: string) => {
    const plan = planCategoryRemove(category, config);
    if (!plan) return;
    void save.track(writeCategoryPlan(householdId, list.id, plan), {
      kind: 'write',
      subject: `${category} removed`,
      failTitle: `Could not remove ${category}`,
    });
  };

  const move = (category: string, direction: MoveDirection) => {
    if (!online) return;
    const index = movable.findIndex((entry) => categoryKey(entry) === categoryKey(category));
    const target = index + direction;
    if (index < 0 || target < 0 || target >= movable.length) return;
    const where = direction === -1 ? 'up' : 'down';
    focusAfterMove.current = `Move ${category} ${where}`;
    const run = async () => {
      const write = store
        ? reorderStoreAisle(householdId, store.id, config.list, category, direction)
        : reorderListCategory(householdId, list.id, category, direction);
      const tracked = await save.track(write, {
        kind: 'transaction',
        subject: `${category} moved ${where}`,
        failTitle: `Could not move ${category}`,
      });
      if (tracked.state === 'saved' && tracked.value === false) {
        save.clear();
        return;
      }
      if (tracked.state !== 'failed') setAnnouncement(`${category} moved ${where}, position ${target + 1} of ${movable.length}.`);
    };
    moveChain.current = moveChain.current.then(run, run);
  };

  const chooseStore = (value: string) => {
    if (value === NEW_STORE) {
      setCreatingStore(true);
      setStoreError(null);
      return;
    }
    setCreatingStore(false);
    const storeId = value === NO_STORE ? null : value;
    if ((store?.id ?? null) === storeId) return;
    const chosen = stores.find((entry) => entry.id === storeId);
    void save.track(assignListStore(householdId, list.id, storeId), {
      kind: 'write',
      subject: chosen ? `Sorted for ${chosen.name}` : 'Own order',
      failTitle: 'Could not change the store',
    });
  };

  const createStore = async () => {
    if (!uid) return;
    const check = checkStoreName(storeName, stores);
    if (!check.ok) {
      setStoreError(check.error);
      return;
    }
    setStoreError(null);
    const { write } = createStoreForList(householdId, list.id, { name: check.name, aisleOrder: initialAisleOrder(config.list), uid });
    setCreatingStore(false);
    setStoreName('');
    await save.track(write, { kind: 'write', subject: `${check.name} created`, failTitle: `Could not create ${check.name}` });
  };

  const selectValue = creatingStore ? NEW_STORE : store?.id ?? NO_STORE;

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
      <DialogTrigger asChild>
        <Button variant="outline" className="w-full sm:w-auto"><Settings className="mr-2 h-4 w-4" aria-hidden /> Manage Categories</Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="font-headline">Manage Categories</DialogTitle>
          <DialogDescription>
            {store
              ? `Items are grouped in the order you walk ${store.name}. Every list at ${store.name} shares this aisle order. Other is always last.`
              : 'Items are grouped in this order. Move categories to match how you walk the store. Other is always last and cannot be removed.'}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5 py-2">
          <section className="space-y-2" aria-labelledby="store-heading">
            <h3 id="store-heading" className="flex items-center gap-2 font-medium"><Store className="h-4 w-4" aria-hidden /> Store</h3>
            <Select value={selectValue} onValueChange={chooseStore}>
              <SelectTrigger aria-label="Store for this list" className="h-11 [@media(pointer:coarse)]:h-12">
                <SelectValue />
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
                <p className="text-sm text-muted-foreground">It starts with this list&apos;s current order.</p>
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
            <h3 id="order-heading" className="font-medium">{store ? `Aisle order at ${store.name}` : 'Category order'}</h3>
            {!online && <p className="text-sm text-muted-foreground">Moving categories needs a connection. Adding and removing still work.</p>}
            <ol ref={listRef} aria-labelledby="order-heading" className="divide-y rounded-lg border">
              {order.map((category) => {
                const other = isOtherCategory(category);
                const index = movable.findIndex((entry) => categoryKey(entry) === categoryKey(category));
                const upDisabled = other || !online || index <= 0;
                const downDisabled = other || !online || index < 0 || index >= movable.length - 1;
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
