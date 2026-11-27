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

import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type FormEvent } from 'react';
import { Circle, Clock, Plus, ScanLine, ShoppingBasket, ShoppingCart, X } from 'lucide-react';
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
import { expiringChips, neededAisleGroups, preferencesKnown } from '@/lib/shopping/overview';
import { DEFAULT_SHOPPING_CATEGORIES } from '@/lib/shopping-items';
import { localDay, safeTimeZone } from '@functions/shared/calendar';
import { cn } from '@/lib/utils';
import { useTablet } from './tablet-context';
import { BarcodeScanner } from '../barcode-scanner';
import { localLibraryLookup, type LocalLibraryEntry } from '@/lib/barcode/library-fill';

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

const subscribeConnection = (onChange: () => void) => {
  window.addEventListener('online', onChange);
  window.addEventListener('offline', onChange);
  return () => {
    window.removeEventListener('online', onChange);
    window.removeEventListener('offline', onChange);
  };
};

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
    const submitted = text;
    if (!attempt.current || attempt.current.text !== text || attempt.current.listId !== list.id) {
      attempt.current = { text, listId: list.id, opId: crypto.randomUUID() };
    }
    setBusy(true);
    try {
      const outcome = await runAction({ capability: 'shopping.add', label: `Add to ${list.name}`, opId: attempt.current.opId, intent: { listId: list.id, entries } });
      if (outcome.ok || outcome.queued) {
        attempt.current = null;
        // Only the words that were sent: anything typed while it ran stays.
        setText((current) => (current === submitted ? '' : current.startsWith(submitted) ? current.slice(submitted.length).replace(/^[\s,]+/, '') : current));
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

/**
 * Scanning on the kitchen tablet (BL-20, BL-21): the camera from the device record (front by
 * default, WT-4) scans continuously, and each product saved in the household library (read
 * on the tablet, the rules let it) gets the selected action as a device action for the
 * person chosen in "Who's here?" (a face tap, with its Undo): **Add to list** (`shopping.add`,
 * one item on this list), **Used up** (`pantry.useUp`, one package out of the pantry; at zero
 * "Add to list?" with Add and Not now, D-8) or **Restock** (`pantry.restock`, one package in).
 * Anything else says to save it from a phone; nothing here asks Open Food Facts or writes
 * the library.
 */
type TabletScanMode = 'list' | 'used' | 'restock';
const TABLET_SCAN_MODES: readonly { id: TabletScanMode; label: string }[] = [
  { id: 'used', label: 'Used up' },
  { id: 'restock', label: 'Restock' },
  { id: 'list', label: 'Add to list' },
];

function KitchenScanPanel({ list, library, onClose }: { list: KitchenList; library: ReadonlyMap<string, LocalLibraryEntry> | null; onClose: () => void }) {
  const { settings, runAction } = useTablet();
  const [mode, setMode] = useState<TabletScanMode>('used');
  const [line, setLine] = useState<string | null>(null);
  const [askAdd, setAskAdd] = useState<string | null>(null);
  const queue = useRef<Promise<void>>(Promise.resolve());
  // The latest library and mode, for scans queued before they arrived (a scan waits up to 10 s for the library).
  const libraryRef = useRef(library);
  useEffect(() => { libraryRef.current = library; }, [library]);
  const modeRef = useRef(mode);
  useEffect(() => { modeRef.current = mode; }, [mode]);
  const loadedLibrary = async () => {
    for (let waited = 0; !libraryRef.current && waited < 10_000; waited += 250) {
      setLine('Loading the household library…');
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return libraryRef.current;
  };
  const addToList = async (name: string) => {
    const outcome = await runAction({ capability: 'shopping.add', label: `Add ${name}`, intent: { listId: list.id, entries: [{ name, quantity: 1 }] } });
    setLine(outcome.ok || outcome.queued ? `${name} is on ${list.name}.` : `${name} was not added.`);
  };
  const onScan = (code: string) => {
    queue.current = queue.current.then(async () => {
      setAskAdd(null);
      const current = await loadedLibrary();
      if (!current) {
        setLine("The household library couldn't be loaded right now. Try again in a moment.");
        return;
      }
      const found = localLibraryLookup(current, code);
      if (!found) {
        setLine(`${code} is not in the household library yet. Save it from a phone, then scan again.`);
        return;
      }
      const name = found.productName;
      const action = modeRef.current;
      if (action === 'list') {
        await addToList(name);
        return;
      }
      const capability = action === 'used' ? 'pantry.useUp' : 'pantry.restock';
      const outcome = await runAction({ capability, label: name, intent: { barcode: found.libraryItem.id, name } });
      const result = ((outcome.data ?? {}) as { result?: { status?: string; remaining?: number; askAddToList?: boolean } }).result;
      if (outcome.queued) setLine(`Saved on this tablet: ${name} syncs when the connection is back.`);
      else if (!outcome.ok) setLine(result?.status === 'not_stocked' ? `${name} is not in the pantry.` : `${name} was not changed.`);
      else if (action === 'restock') setLine(`${name} restocked.`);
      else setLine(result?.remaining === 0 ? `Used the last ${name}.` : `Used one ${name}.${typeof result?.remaining === 'number' ? ` ${result.remaining} left.` : ''}`);
      // D-8: at zero, ask; nothing goes on the list without the tap.
      if (outcome.ok && result?.askAddToList) setAskAdd(name);
    });
  };
  return (
    <section className="grid gap-4 rounded-xl border bg-card p-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]" aria-label="Scan" data-testid="tablet-scan-panel">
      <BarcodeScanner onScan={onScan} deviceCamera={settings.camera} continuous />
      <div className="space-y-3">
        <div role="radiogroup" aria-label="What a scan does" className="grid grid-cols-3 gap-2">
          {TABLET_SCAN_MODES.map((option) => (
            <button
              key={option.id}
              type="button"
              role="radio"
              aria-checked={mode === option.id}
              onClick={() => setMode(option.id)}
              className={cn('min-h-16 rounded-xl border-2 px-2 text-lg font-semibold', mode === option.id ? 'border-primary bg-primary text-primary-foreground' : 'border-border bg-background')}
              data-testid={`tablet-scan-mode-${option.id}`}
            >
              {option.label}
            </button>
          ))}
        </div>
        <p aria-live="polite" className="min-h-8 text-lg" data-testid="tablet-scan-line">{line}</p>
        {askAdd && (
          <div role="alert" className="space-y-2 rounded-xl border p-3" data-testid="tablet-scan-ask">
            <p className="text-lg font-medium">That was the last {askAdd}. Add to {list.name}?</p>
            <div className="flex gap-2">
              <button type="button" className="min-h-14 flex-1 rounded-xl bg-primary px-4 text-lg font-medium text-primary-foreground" onClick={() => { const name = askAdd; setAskAdd(null); void addToList(name); }}>Add</button>
              <button type="button" className="min-h-14 flex-1 rounded-xl border px-4 text-lg" onClick={() => setAskAdd(null)}>Not now</button>
            </div>
          </div>
        )}
        <button type="button" onClick={onClose} className="inline-flex min-h-14 items-center gap-2 rounded-xl border px-5 text-lg">
          <X aria-hidden className="h-5 w-5" /> Done scanning
        </button>
      </div>
    </section>
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
  // As the personal Shopping view: offline, the cached preferences decide (a fallback list
  // when they name none), so the kitchen never waits on "Loading…" without a connection.
  const offline = useSyncExternalStore(subscribeConnection, () => navigator.onLine === false, () => false);
  const defaultKnown = preferencesKnown({
    status: !preferences ? 'loading' : preferences.failed ? 'error' : 'ready',
    fromCache: preferences?.fromCache ?? true,
    offline,
    defaultListId: preferences?.value ?? null,
  });
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

  // The household library for Scan (BL-20), opened with the view so it is ready before a scan.
  const library = useTabletLive(`library:${householdId}`, (fs, db) => fs.collection(db, 'households', householdId, 'barcode-library'), (snapshot) => {
    const map = new Map<string, LocalLibraryEntry>();
    for (const doc of (snapshot as QuerySnapshot).docs) {
      const name = doc.get('name');
      if (typeof name === 'string') map.set(doc.id, { name });
    }
    return map;
  });
  const [scanning, setScanning] = useState(false);
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
            <div className="flex gap-2">
              <div className="min-w-0 flex-1"><KitchenQuickAdd key={list.id} list={list} /></div>
              {!scanning && (
                <button
                  type="button"
                  onClick={() => setScanning(true)}
                  className="inline-flex min-h-14 items-center gap-2 rounded-xl border bg-card px-5 text-lg font-medium"
                  data-testid="tablet-shopping-scan"
                >
                  <ScanLine aria-hidden className="h-6 w-6" /> Scan
                </button>
              )}
            </div>
            {scanning && <KitchenScanPanel key={list.id} list={list} library={library?.value ?? null} onClose={() => setScanning(false)} />}
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
