'use client';

/**
 * The recipe card's ingredients (SH-31a, SH-22c/d, SH-31b): what the recipe
 * takes from the pantry, with the amounts HomeHub has (never the model's
 * numbers), and what is missing, each with a working "+" that puts it on a
 * Grocery list, plus "Add all missing" for every one in one action. Writes go
 * through the Shopping list's own save path (`addToGroceryList` /
 * `addAllToGroceryList`): an item already needed there gets one more instead of
 * a second entry, and each row shows its write's honest state.
 *
 * Mounted per recipe (the dialog keys it), so a new recipe starts with fresh
 * row states. Row states are kept per destination list: switching the picker
 * shows that list's own states, and a write that settles after the switch
 * lands on the list it was started for.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Check, CloudOff, Loader2, Plus, RotateCcw, Salad } from 'lucide-react';
import type { ShoppingList } from '@/lib/types';
import { auth } from '@/lib/firebase';
import { itemNameKey } from '@/lib/shopping/items';
import { groceryListChoice, productSummary, type PantryProduct } from '@/lib/shopping/pantry-batches';
import { addAllToGroceryList, addToGroceryList, createGroceriesList, readShoppingLists } from '@/lib/shopping/pantry-batch-writes';
import {
  isMissingAdded, missingAddStatesOn, planMissingAdds, summarizeMissingAdds, withMissingAddState,
  type MissingAddState, type MissingAddStates, type RecipeIngredients as RecipeIngredientLists, type RecipeNeededIngredient,
} from '@/lib/shopping/recipe';
import { readRecentList, rememberRecentList } from '@/lib/shopping/recent-list';
import { categorizationNotice, type SettledState } from '@/lib/shopping/save-status';
import { useToast } from '@/hooks/use-toast';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { cn } from '@/lib/utils';

type ListRef = Pick<ShoppingList, 'id' | 'name'>;
type Destination =
  | { kind: 'loading' }
  | { kind: 'error' }
  | { kind: 'create' }
  | { kind: 'direct'; list: ListRef }
  | { kind: 'pick'; lists: ShoppingList[]; selectedId: string };

/** Row states before the new "Groceries" list exists are kept under this key (never a document id). */
const NEW_LIST_KEY = '\u0000new';

/** The key the destination's row states live under, or null while there is none. */
const destinationKey = (destination: Destination): string | null =>
  destination.kind === 'direct' ? destination.list.id
    : destination.kind === 'pick' ? destination.selectedId
      : destination.kind === 'create' ? NEW_LIST_KEY
        : null;

/** 44 px, 48 px on coarse pointers. */
const TOUCH = 'h-11 min-w-11 [@media(pointer:coarse)]:h-12 [@media(pointer:coarse)]:min-w-12';

const STATUS_TEXT: Partial<Record<MissingAddState, string>> = {
  saving: 'Adding…',
  saved: 'On the list',
  'stored-locally': 'Saved, will sync',
  sending: 'Sending…',
  uncertain: 'Sending…',
  failed: 'Not added',
};

export function RecipeIngredients({
  ingredients,
  products,
  today,
  householdId,
  uid,
  canEdit,
}: {
  ingredients: RecipeIngredientLists;
  /** The live pantry, for the amounts on hand. */
  products: readonly PantryProduct[];
  today: string;
  householdId: string;
  uid: string | null;
  /** `shopping.edit`: without it the add buttons are disabled. */
  canEdit: boolean;
}) {
  const { toast, toastError } = useToast();
  const [states, setStates] = useState<MissingAddStates>({});
  // Read by the handlers (a tap and "Add all" may overlap); `setState` keeps it current.
  const statesRef = useRef(states);
  const setState = useCallback((listKey: string, name: string, state: MissingAddState) => {
    statesRef.current = withMissingAddState(statesRef.current, listKey, name, state);
    setStates(statesRef.current);
  }, []);

  // Where the adds go (SH-6): one Grocery list directly, several via the picker
  // (preselecting the list used last here, else the default), none: a new "Groceries".
  const [destination, setDestination] = useState<Destination>({ kind: 'loading' });
  const destinationRef = useRef(destination);
  useEffect(() => {
    destinationRef.current = destination;
  }, [destination]);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const hasNeeded = ingredients.needed.length > 0;
  useEffect(() => {
    if (!canEdit || !householdId || !hasNeeded) return;
    let cancelled = false;
    readShoppingLists(householdId).then((lists) => {
      if (cancelled) return;
      const choice = groceryListChoice(lists, readRecentList(householdId));
      setDestination(choice.kind === 'pick' ? { kind: 'pick', lists: choice.lists, selectedId: choice.preselectId } : choice);
    }, () => {
      if (!cancelled) setDestination({ kind: 'error' });
    });
    return () => {
      cancelled = true;
    };
  }, [canEdit, householdId, hasNeeded, loadAttempt]);

  const creatingRef = useRef<Promise<ListRef> | null>(null);
  // Resolves the destination captured when the add started, not whatever is selected by then.
  const resolveList = useCallback(async (current: Destination): Promise<ListRef | null> => {
    if (current.kind === 'direct') return current.list;
    if (current.kind === 'pick') return current.lists.find((list) => list.id === current.selectedId) ?? null;
    if (current.kind !== 'create') return null;
    // Several taps while the list is being created share the one create.
    creatingRef.current ??= createGroceriesList(householdId, (error) => toastError(error, 'Could not create the Groceries list'));
    try {
      const list = await creatingRef.current;
      destinationRef.current = { kind: 'direct', list };
      setDestination(destinationRef.current);
      return list;
    } catch (error) {
      creatingRef.current = null;
      throw error;
    }
  }, [householdId, toastError]);

  const active = useCallback((listId: string) => () => ({ householdId: auth.currentUser ? householdId : null, listId }), [householdId]);
  const follow = useCallback((listKey: string, name: string, settled: Promise<SettledState>) => {
    void settled.then((final) => setState(listKey, name, final));
  }, [setState]);
  const reportCategories = useCallback((categorization: Promise<{ unavailable: string[]; unconfirmed: string[] }>) => {
    void categorization.then((report) => {
      const notice = categorizationNotice({ savedNames: report.unavailable, unconfirmedNames: report.unconfirmed }, 'Automatic sorting was unavailable.');
      if (notice) toast(notice);
    });
  }, [toast]);

  const addOne = useCallback(async (entry: RecipeNeededIngredient) => {
    const target = destinationRef.current;
    let listKey = destinationKey(target);
    if (!canEdit || !householdId || listKey === null) return;
    const state = missingAddStatesOn(statesRef.current, listKey)[itemNameKey(entry.name)];
    if (state === 'saving' || isMissingAdded(state)) return;
    setState(listKey, entry.name, 'saving');
    try {
      const list = await resolveList(target);
      if (!list) {
        setState(listKey, entry.name, 'idle');
        return;
      }
      if (list.id !== listKey) {
        // The new Groceries list now exists: the row's state moves onto it.
        setState(listKey, entry.name, 'idle');
        listKey = list.id;
        setState(listKey, entry.name, 'saving');
      }
      const result = await addToGroceryList({
        householdId,
        uid,
        list,
        name: entry.name,
        quantity: 1,
        active: active(list.id),
        onLateError: (error) => toastError(error, `Could not sync ${entry.name}`),
      });
      setState(listKey, entry.name, result.state);
      if (result.state === 'failed') throw result.error ?? new Error('save-failed');
      follow(listKey, entry.name, result.settled);
      rememberRecentList(householdId, list.id);
      toast(result.state === 'saved'
        ? {
            title: 'On the list',
            description: result.merged ? `${result.name} was already on ${list.name}; it now needs 1 more.` : `${entry.name} is on ${list.name}.`,
          }
        : result.state === 'stored-locally'
          ? { title: 'Saved, will sync', description: `${entry.name} is saved on this device and reaches ${list.name} when the connection is back.` }
          : { title: 'Still sending…', description: `${entry.name} has not reached ${list.name} yet. An error shows here if it fails.` });
      reportCategories(result.categorization);
    } catch (error) {
      setState(listKey, entry.name, 'failed');
      toastError(error, `Could not add ${entry.name} to the list`);
    }
  }, [canEdit, householdId, uid, resolveList, active, follow, reportCategories, setState, toast, toastError]);

  // The destination keys an "Add all missing" is running for (each list on its own).
  const [addingAllOn, setAddingAllOn] = useState<ReadonlySet<string>>(() => new Set());
  const markAddingAll = useCallback((listKey: string, running: boolean) => {
    setAddingAllOn((current) => {
      const next = new Set(current);
      if (running) next.add(listKey);
      else next.delete(listKey);
      return next;
    });
  }, []);
  const addAll = useCallback(async () => {
    const target = destinationRef.current;
    const startKey = destinationKey(target);
    if (!canEdit || !householdId || startKey === null) return;
    let listKey = startKey;
    const names = planMissingAdds(ingredients.needed, missingAddStatesOn(statesRef.current, listKey));
    if (names.length === 0) return;
    markAddingAll(startKey, true);
    for (const name of names) setState(listKey, name, 'saving');
    try {
      const list = await resolveList(target);
      if (!list) {
        for (const name of names) setState(listKey, name, 'idle');
        return;
      }
      if (list.id !== listKey) {
        // The new Groceries list now exists: the rows' states move onto it.
        for (const name of names) setState(listKey, name, 'idle');
        listKey = list.id;
        for (const name of names) setState(listKey, name, 'saving');
      }
      const result = await addAllToGroceryList({
        householdId,
        uid,
        list,
        entries: names.map((name) => ({ name, quantity: 1 })),
        active: active(list.id),
        onLateError: (name, error) => toastError(error, `Could not sync ${name}`),
      });
      for (const entry of result.entries) {
        setState(listKey, entry.asked, entry.state);
        if (entry.state !== 'failed') follow(listKey, entry.asked, entry.settled);
      }
      if (result.entries.some((entry) => entry.state !== 'failed')) rememberRecentList(householdId, list.id);
      const summary = summarizeMissingAdds(result.entries.map((entry) => ({ name: entry.asked, state: entry.state, merged: entry.merged })), list.name);
      toast({ title: summary.title, description: summary.description, ...(summary.failed ? { variant: 'destructive' as const } : {}) });
      reportCategories(result.categorization);
    } catch (error) {
      for (const name of names) setState(listKey, name, 'failed');
      toastError(error, 'Could not add the missing ingredients');
    } finally {
      markAddingAll(startKey, false);
    }
  }, [canEdit, householdId, uid, ingredients.needed, resolveList, active, follow, reportCategories, setState, markAddingAll, toast, toastError]);

  // Amounts on hand come from the live pantry, by exact name (every shelf).
  const onHand = useMemo(() => {
    const byName = new Map<string, string[]>();
    for (const product of products) {
      const summary = productSummary(product, today);
      if (!summary) continue;
      const lines = byName.get(product.nameKey) ?? [];
      lines.push(`${summary} (${product.location})`);
      byName.set(product.nameKey, lines);
    }
    return byName;
  }, [products, today]);

  // Everything below shows the selected destination's own states.
  const shownKey = destinationKey(destination);
  const shownStates = shownKey === null ? {} : missingAddStatesOn(states, shownKey);
  const addingAll = shownKey !== null && addingAllOn.has(shownKey);
  const remaining = planMissingAdds(ingredients.needed, shownStates).length;
  const listReady = destination.kind === 'direct' || destination.kind === 'pick' || destination.kind === 'create';
  const disabledReason = !canEdit
    ? 'You need permission to edit shopping lists to add these.'
    : null;

  return (
    <div className="space-y-3">
      <h3 className="font-headline text-lg font-semibold flex items-center gap-2"><Salad aria-hidden /> Ingredients</h3>
      <div className="p-4 bg-secondary/50 rounded-lg">
        <h4 className="font-semibold mb-2">From Your Pantry</h4>
        {ingredients.used.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing from the pantry.</p>
        ) : (
          <ul className="space-y-2" aria-label="From your pantry">
            {ingredients.used.map((entry) => {
              const have = onHand.get(itemNameKey(entry.pantryItem));
              return (
                <li key={entry.pantryItem} className="flex items-start gap-2">
                  <Check className="mt-1 h-4 w-4 shrink-0 text-success" aria-hidden />
                  <div className="min-w-0">
                    <span>{entry.line}</span>
                    <p className="text-xs text-muted-foreground">
                      {have ? `You have ${have.join('; ')}` : `${entry.pantryItem} is no longer in the pantry`}
                    </p>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      {hasNeeded && (
        <div className="p-4 bg-warning/10 rounded-lg space-y-3" data-testid="recipe-missing">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h4 className="font-semibold">You Might Need</h4>
            <Button
              type="button"
              variant="outline"
              className={cn(TOUCH, 'px-3')}
              onClick={() => void addAll()}
              disabled={!canEdit || !listReady || addingAll || remaining === 0}
            >
              {addingAll ? <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden /> : <Plus className="mr-2 h-4 w-4" aria-hidden />}
              Add all missing
            </Button>
          </div>
          {disabledReason ? (
            <p className="text-sm text-muted-foreground">{disabledReason}</p>
          ) : destination.kind === 'loading' ? (
            <p className="text-sm text-muted-foreground">Finding your Grocery list…</p>
          ) : destination.kind === 'error' ? (
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="text-destructive">Could not load your shopping lists.</span>
              <Button type="button" variant="ghost" className={TOUCH} onClick={() => { setDestination({ kind: 'loading' }); setLoadAttempt((value) => value + 1); }}>Retry</Button>
            </div>
          ) : destination.kind === 'pick' ? (
            <div className="flex flex-wrap items-center gap-2">
              <Label htmlFor="recipe-add-list" className="text-sm">Add to</Label>
              <Select
                value={destination.selectedId}
                onValueChange={(selectedId) => setDestination({ ...destination, selectedId })}
              >
                <SelectTrigger id="recipe-add-list" aria-label="Grocery list for missing ingredients" className={cn(TOUCH, 'w-auto min-w-40')}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {destination.lists.map((list) => (
                    <SelectItem key={list.id} value={list.id}>{list.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              {destination.kind === 'direct' ? `Adds to ${destination.list.name}.` : 'Adds to a new Groceries list.'}
            </p>
          )}
          <ul className="space-y-1" aria-label="You might need">
            {ingredients.needed.map((entry) => {
              const state = shownStates[itemNameKey(entry.name)] ?? 'idle';
              const added = isMissingAdded(state);
              const status = STATUS_TEXT[state];
              return (
                <li key={entry.name} className="flex items-center gap-2" data-add-state={state}>
                  <Button
                    type="button"
                    variant={added ? 'ghost' : 'outline'}
                    size="icon"
                    className={cn(TOUCH, 'shrink-0')}
                    aria-label={state === 'failed' ? `Try adding ${entry.name} again` : added ? `${entry.name} added` : `Add ${entry.name} to the list`}
                    onClick={() => void addOne(entry)}
                    disabled={!canEdit || !listReady || addingAll || state === 'saving' || added}
                  >
                    {state === 'saving' ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                      : state === 'saved' ? <Check className="h-4 w-4 text-success" aria-hidden />
                        : state === 'stored-locally' ? <CloudOff className="h-4 w-4" aria-hidden />
                          : state === 'sending' || state === 'uncertain' ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                            : state === 'failed' ? <RotateCcw className="h-4 w-4 text-destructive" aria-hidden />
                              : <Plus className="h-4 w-4 text-warning" aria-hidden />}
                  </Button>
                  <span className="min-w-0 flex-1">{entry.line}</span>
                  {status && <span className={cn('text-xs', state === 'failed' ? 'text-destructive' : 'text-muted-foreground')}>{status}</span>}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
