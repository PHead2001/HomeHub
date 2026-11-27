'use client';

// Shopping on a registered wall tablet: kitchen mode (docs/modules/devices/README.md, "Shopping
// on the tablet"; audit SH-11, SH-28, HP-36). One tap from the rail: the chosen list (the one in
// the address, else the household's Grocery list as the personal overview picks it) with its
// needed items inline, grouped by aisle in two or three columns, each row ticked with one tap
// for the person chosen in "Who's here?" (`shopping.tick`, Undo for 10 s); a big quick-add field
// that is always on screen (`shopping.add`, "milk, eggs, 2 bread", a face tap first); who added
// each item ("Sam added · 2d", first names from the tablet's roster, never an email); a live
// "Alex is shopping · 7 left" line while a member ticks items elsewhere; and the pantry's
// expiring chips. Everything is read through the tablet's own listeners (`tabletListener`) under
// the tablet's read rules (the Shopping section switch); every write is a device action.

import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Circle, Clock, Plus, ShoppingBasket, ShoppingCart } from 'lucide-react';
import type { DocumentReference, DocumentSnapshot, Query, QuerySnapshot } from 'firebase/firestore';
import { Input } from '@/components/ui/input';
import { useUnsavedInput } from '@/hooks/use-shell-busy';
import { tabletListener } from '@/lib/devices/tablet-listener';
import { shoppingListsSection } from '@/lib/devices/tablet-sections';
import {
  kitchenActivity,
  kitchenAttribution,
  kitchenItems,
  kitchenListChoice,
  kitchenLists,
  rosterFirstNames,
  type KitchenItem,
  type KitchenList,
} from '@/lib/devices/tablet-shopping';
import { readCategoryConfig } from '@/lib/shopping/category-order';
import { parseQuickAdd } from '@/lib/shopping/items';
import { expiringChips, neededAisleGroups } from '@/lib/shopping/overview';
import { DEFAULT_SHOPPING_CATEGORIES } from '@/lib/shopping-items';
import { localDay, safeTimeZone } from '@functions/shared/calendar';
import { cn } from '@/lib/utils';
import { useTablet } from './tablet-context';

type Snapshot = DocumentSnapshot | QuerySnapshot;
type Firestore = typeof import('firebase/firestore');
type Live<V> = { key: string; value: V | null; fromCache: boolean; failed: boolean };

/**
 * One live document or query through the tablet's listener, keyed (a new key shows loading,
 * never the previous target's data). `target` builds the reference once Firestore is loaded.
 */
function useTabletLive<V>(
  key: string | null,
  target: (fs: Firestore, db: import('firebase/firestore').Firestore) => DocumentReference | Query,
  read: (snapshot: Snapshot) => V,
): Live<V> | null {
  const [state, setState] = useState<Live<V> | null>(null);
  const latest = useRef({ target, read });
  useEffect(() => { latest.current = { target, read }; });
  useEffect(() => {
    if (!key) return;
    let stop: (() => void) | null = null;
    let stopped = false;
    void Promise.all([import('@/lib/firebase'), import('firebase/firestore')]).then(([{ db }, fs]) => {
      if (stopped) return;
      const { onSnapshot } = fs;
      const ref = latest.current.target(fs, db);
      const subscribe: (next: (value: Snapshot) => void, error: (error: unknown) => void) => () => void = ref.type === 'document'
        ? (next, error) => onSnapshot(ref as DocumentReference, { includeMetadataChanges: true }, next, error)
        : (next, error) => onSnapshot(ref as Query, { includeMetadataChanges: true }, next, error);
      stop = tabletListener<Snapshot>(subscribe, {
        confirmed: (snapshot) => !snapshot.metadata.fromCache,
        next: (snapshot) => setState({ key, value: latest.current.read(snapshot), fromCache: snapshot.metadata.fromCache, failed: false }),
        onDenied: () => setState((previous) => ({ key, value: previous?.key === key ? previous.value : null, fromCache: true, failed: true })),
      }).stop;
    });
    return () => {
      stopped = true;
      stop?.();
    };
  }, [key]);
  return state && state.key === key ? state : null;
}

const docsOf = (snapshot: Snapshot) => (snapshot as QuerySnapshot).docs.map((doc) => ({ id: doc.id, ...doc.data() }));

/** A clock for "2d" ages and the 10-minute "is shopping" window (each minute). */
function useMinuteClock(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}

/** One needed item: a single tap ticks it for the person chosen in "Who's here?". */
function KitchenRow({ item, attribution, busy, onTick }: { item: KitchenItem; attribution: string | null; busy: boolean; onTick: (item: KitchenItem) => void }) {
  return (
    <li>
      <button
        type="button"
        onClick={() => onTick(item)}
        disabled={busy}
        aria-label={`Tick ${item.name}`}
        className="flex min-h-14 w-full items-center gap-3 rounded-xl border border-border bg-card px-4 py-2 text-left disabled:opacity-60"
        data-testid={`tablet-shopping-item-${item.id}`}
      >
        <Circle aria-hidden className="h-6 w-6 shrink-0 text-primary" />
        <span className="min-w-0">
          <span className="block text-lg font-medium">
            {item.name}
            {item.quantity > 1 && <span className="font-normal text-muted-foreground"> ×{item.quantity}</span>}
          </span>
          {attribution && <span className="block text-sm text-muted-foreground" data-testid={`tablet-shopping-attribution-${item.id}`}>{attribution}</span>}
        </span>
      </button>
    </li>
  );
}

/** The always-visible quick add: "milk, eggs, 2 bread" onto the shown list (`shopping.add`). */
function KitchenQuickAdd({ list }: { list: KitchenList }) {
  const { runAction } = useTablet();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  // One opId per text: a retry of the same words after a lost answer replays on the server
  // (never adding twice); new words are a new add.
  const attempt = useRef<{ text: string; listId: string; opId: string } | null>(null);
  useUnsavedInput(text.trim().length > 0);
  const entries = parseQuickAdd(text);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || entries.length === 0) return;
    if (!attempt.current || attempt.current.text !== text || attempt.current.listId !== list.id) {
      attempt.current = { text, listId: list.id, opId: crypto.randomUUID() };
    }
    setBusy(true);
    try {
      const outcome = await runAction({ capability: 'shopping.add', label: `Add to ${list.name}`, opId: attempt.current.opId, intent: { listId: list.id, entries } });
      if (outcome.ok || outcome.queued) {
        attempt.current = null;
        setText('');
      }
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={(event) => void submit(event)} className="flex gap-2" data-testid="tablet-shopping-add-form">
      <Input
        value={text}
        onChange={(event) => setText(event.target.value)}
        placeholder={`Add to ${list.name}: milk, eggs, 2 bread`}
        aria-label={`Add items to ${list.name}`}
        className="min-h-14 flex-1 text-xl"
        maxLength={2000}
        data-testid="tablet-shopping-add-input"
      />
      <button
        type="submit"
        disabled={busy || entries.length === 0}
        className="inline-flex min-h-14 min-w-14 items-center justify-center gap-2 rounded-xl bg-primary px-5 text-lg font-medium text-primary-foreground disabled:opacity-60"
        data-testid="tablet-shopping-add"
      >
        <Plus aria-hidden className="h-6 w-6" /> Add
      </button>
    </form>
  );
}

export function TabletShoppingView({ listId }: { listId?: string }) {
  const { householdId, household, data, roster, runAction, navigate } = useTablet();
  const now = useMinuteClock();
  const timeZone = safeTimeZone(household?.timeZone ?? 'UTC');

  const lists = useTabletLive(`lists:${householdId}`, (fs, db) => fs.collection(db, 'households', householdId, 'shopping-lists'), (snapshot) => kitchenLists(docsOf(snapshot)));
  const preferences = useTabletLive(`prefs:${householdId}`, (fs, db) => fs.doc(db, 'households', householdId, 'shopping-settings', 'preferences'), (snapshot) => {
    const value = (snapshot as DocumentSnapshot).get('defaultGroceryListId');
    return typeof value === 'string' && value ? value : null;
  });
  const defaultKnown = Boolean(preferences && (preferences.failed || !preferences.fromCache || preferences.value !== null));
  const choice = kitchenListChoice({ lists: lists?.value ?? [], pickedId: listId, defaultListId: preferences?.value ?? null, defaultKnown });
  const list = choice.list;

  const items = useTabletLive(list ? `items:${householdId}:${list.id}` : null, (fs, db) => fs.collection(db, 'households', householdId, 'shopping-lists', list!.id, 'items'), (snapshot) => kitchenItems(docsOf(snapshot)));
  const config = useTabletLive(list ? `config:${householdId}:${list.id}` : null, (fs, db) => fs.doc(db, 'households', householdId, 'shopping-lists', list!.id, 'config', 'categories'),
    (snapshot) => readCategoryConfig((snapshot as DocumentSnapshot).data(), (snapshot as DocumentSnapshot).exists(), DEFAULT_SHOPPING_CATEGORIES));
  const store = useTabletLive(list?.storeId ? `store:${householdId}:${list.storeId}` : null, (fs, db) => fs.doc(db, 'households', householdId, 'stores', list!.storeId!),
    (snapshot) => ((snapshot as DocumentSnapshot).exists() ? { aisleOrder: Array.isArray((snapshot as DocumentSnapshot).get('aisleOrder')) ? (snapshot as DocumentSnapshot).get('aisleOrder') as unknown[] : [] } : null));
  const pantry = useTabletLive(`pantry:${householdId}`, (fs, db) => fs.collection(db, 'households', householdId, 'pantry-inventory'), docsOf);

  const names = useMemo(() => rosterFirstNames(roster), [roster]);
  const liveItems = items?.value ?? null;
  const groups = useMemo(() => (liveItems ? neededAisleGroups(liveItems, config?.value ?? readCategoryConfig(null, false, DEFAULT_SHOPPING_CATEGORIES), store?.value ?? null) : []), [liveItems, config?.value, store?.value]);
  const activity = useMemo(() => (liveItems ? kitchenActivity(liveItems, names, now) : null), [liveItems, names, now]);
  const inCart = liveItems ? liveItems.filter((item) => item.status === 'purchased').length : 0;
  const pantryDocs = pantry?.value ?? null;
  const expiring = useMemo(() => (pantryDocs ? expiringChips(pantryDocs, localDay(new Date(now), timeZone), { timeZone, limit: 6 }) : { chips: [], more: 0 }), [pantryDocs, now, timeZone]);
  const counts = new Map((shoppingListsSection(data.sectionFacts ?? {}) ?? []).map((entry) => [entry.id, entry.needed]));

  // One tick per row at a time (a double tap credits once); the live list removes a ticked row.
  const [ticking, setTicking] = useState<ReadonlySet<string>>(new Set());
  const tick = async (item: KitchenItem) => {
    if (!list || ticking.has(item.id)) return;
    setTicking((current) => new Set(current).add(item.id));
    try {
      await runAction({ capability: 'shopping.tick', label: item.name, intent: { listId: list.id, itemId: item.id } });
    } finally {
      setTicking((current) => {
        const next = new Set(current);
        next.delete(item.id);
        return next;
      });
    }
  };

  const listsReady = Boolean(lists?.value);
  const status = lists?.failed && !listsReady ? "This couldn't be loaded right now. It tries again on its own." : !listsReady || choice.waiting ? 'Loading…' : null;
  return (
    <section className="mx-auto max-w-6xl space-y-4 p-6" data-testid="tablet-view-shopping" aria-labelledby="tablet-view-shopping-title">
      <h1 id="tablet-view-shopping-title" className="flex items-center gap-3 font-headline text-3xl font-bold">
        <ShoppingCart aria-hidden className="h-7 w-7 text-primary" />
        {list ? list.name : 'Shopping'}
      </h1>
      {status ? <p className="text-lg text-muted-foreground">{status}</p> : !list ? (
        <p className="text-lg text-muted-foreground">No shopping lists yet. Make one on a phone.</p>
      ) : (
        <>
          {(lists?.value?.length ?? 0) > 1 && (
            <nav aria-label="Shopping lists" className="flex flex-wrap gap-2">
              {lists!.value!.map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  aria-current={entry.id === list.id ? 'true' : undefined}
                  onClick={() => navigate(`/shopping?list=${encodeURIComponent(entry.id)}`)}
                  className={cn('min-h-12 rounded-full border px-4 text-base', entry.id === list.id ? 'border-primary bg-primary/10 font-semibold text-primary' : 'border-border bg-card')}
                  data-testid={`tablet-shopping-list-${entry.id}`}
                >
                  {entry.name}{counts.has(entry.id) ? <span className="ml-2 text-sm text-muted-foreground">{counts.get(entry.id)}</span> : null}
                </button>
              ))}
            </nav>
          )}
          {/* Always on screen while the rows scroll under it. */}
          <div className="sticky top-0 z-10 space-y-2 bg-background pb-2">
            <KitchenQuickAdd key={list.id} list={list} />
            {activity && (
              <p role="status" className="rounded-lg bg-success/10 px-3 py-1.5 text-base font-medium text-success" data-testid="tablet-shopping-activity">
                <ShoppingBasket aria-hidden className="mr-1.5 inline h-5 w-5 align-[-0.2em]" />
                {activity.label}
              </p>
            )}
            {expiring.chips.length > 0 && (
              <ul className="flex flex-wrap items-center gap-2" aria-label="Use soon from the pantry" data-testid="tablet-shopping-expiring">
                <li className="text-sm font-medium text-muted-foreground"><Clock aria-hidden className="mr-1 inline h-4 w-4 align-[-0.15em]" />Use soon</li>
                {expiring.chips.map((chip) => (
                  <li key={chip.id} className={cn('rounded-full border px-3 py-1 text-sm', chip.days <= 0 ? 'border-destructive/40 text-destructive' : 'border-warning/40 text-warning')}>
                    {chip.name} · {chip.when}
                  </li>
                ))}
                {expiring.more > 0 && <li className="text-sm text-muted-foreground">+{expiring.more} more</li>}
              </ul>
            )}
          </div>
          {!liveItems ? (
            <p className="text-lg text-muted-foreground">{items?.failed ? "This list couldn't be loaded right now. It tries again on its own." : 'Loading…'}</p>
          ) : groups.length === 0 ? (
            <p className="text-lg text-muted-foreground">{liveItems.length === 0 ? 'This list is empty. Add something above.' : 'Nothing left to buy. Everything is in the cart.'}</p>
          ) : (
            <div className="columns-2 gap-4 lg:columns-3" data-testid="tablet-shopping-items">
              {groups.map((group) => (
                <section key={group.category.toLowerCase()} className="mb-4 break-inside-avoid" data-testid="tablet-shopping-aisle">
                  <h2 className="mb-1 px-1 text-sm font-semibold uppercase tracking-wide text-primary">{group.category}</h2>
                  <ul className="space-y-2">
                    {group.items.map((item) => (
                      <KitchenRow key={item.id} item={item} attribution={kitchenAttribution(item, names, now)} busy={ticking.has(item.id)} onTick={(target) => void tick(target)} />
                    ))}
                  </ul>
                </section>
              ))}
            </div>
          )}
          {inCart > 0 && <p className="text-sm text-muted-foreground" data-testid="tablet-shopping-in-cart">{inCart} in the cart.</p>}
        </>
      )}
    </section>
  );
}
