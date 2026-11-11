import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, mock, test } from 'node:test';
import {
  LIVE_COUNT_LIMIT,
  STALE_AFTER_HIDDEN_MS,
  backoffDelay,
  clearIdsFor,
  countItems,
  docsToRecords,
  errorToState,
  isListLinkMissing,
  isOpenListDeleted,
  deactivated,
  deletionSettled,
  justOpened,
  keepListening,
  listsConfirmed,
  liveKey,
  loadingState,
  planCountSources,
  quickAddDecision,
  sameListenerError,
  snapshotToState,
  stateFor,
} from '../../src/lib/shopping/live-state';
import { settleViewTransition } from '../../src/lib/view-transition';

describe('live state: snapshot to screen state', () => {
  test('keys name household and list, and a missing part means nothing to listen to', () => {
    assert.equal(liveKey('items', 'house', 'weekly'), 'items/house/weekly');
    assert.equal(liveKey('items', 'house', null), null);
    assert.equal(liveKey('lists', ''), null);
    // Ids with a slash cannot collide with another key.
    assert.notEqual(liveKey('items', 'a/b', 'c'), liveKey('items', 'a', 'b/c'));
  });

  test('a snapshot carries its value and metadata', () => {
    const state = snapshotToState('k', [1, 2], { fromCache: true, hasPendingWrites: true });
    assert.deepEqual(state, { key: 'k', status: 'ready', value: [1, 2], error: null, fromCache: true, hasPendingWrites: true });
  });

  test('documents become records with their id (the id wins over a stored id field)', () => {
    const records = docsToRecords<{ id: string; name: string }>([
      { id: 'milk', data: () => ({ name: 'Milk', id: 'stale' }) },
      { id: 'eggs', data: () => ({ name: 'Eggs' }) },
    ]);
    assert.deepEqual(records, [{ id: 'milk', name: 'Milk' }, { id: 'eggs', name: 'Eggs' }]);
  });

  test("a consumer never sees another key's data: a list switch shows loading", () => {
    const listA = snapshotToState('items/h/a', ['a1'], { fromCache: false, hasPendingWrites: false });
    assert.deepEqual(stateFor(listA, 'items/h/a', []).value, ['a1']);
    const switched = stateFor(listA, 'items/h/b', [] as string[]);
    assert.equal(switched.status, 'loading');
    assert.deepEqual(switched.value, []);
    const otherHouse = stateFor(listA, 'items/h2/a', [] as string[]);
    assert.equal(otherHouse.status, 'loading');
    // Nothing to listen to (no list open) is ready and empty.
    const none = stateFor(listA, null, [] as string[]);
    assert.equal(none.status, 'ready');
    assert.deepEqual(none.value, []);
  });

  test('an error keeps the last value on screen, or marks a never-loaded key as failed', () => {
    const ready = snapshotToState('k', ['x'], { fromCache: false, hasPendingWrites: false });
    const failed = errorToState(ready, 'k', new Error('offline'), [] as string[]);
    assert.equal(failed.status, 'ready');
    assert.deepEqual(failed.value, ['x']);
    assert.equal(failed.fromCache, true);
    assert.ok(failed.error instanceof Error);
    const never = errorToState(loadingState('k', [] as string[]), 'k', 'denied', [] as string[]);
    assert.equal(never.status, 'error');
    const stale = errorToState(ready, 'other', 'denied', [] as string[]);
    assert.equal(stale.key, 'other');
    assert.deepEqual(stale.value, []);
  });

  test('card counts treat anything not purchased as needed', () => {
    assert.deepEqual(countItems([{ status: 'needed' }, { status: 'purchased' }, {}, { status: 'purchased' }]), { needed: 2, purchased: 2 });
    assert.deepEqual(countItems([]), { needed: 0, purchased: 0 });
  });
});

describe('live state: card count sources', () => {
  test('the first lists get a live listener, the rest fall back to count queries', () => {
    const ids = Array.from({ length: LIVE_COUNT_LIMIT + 3 }, (_, index) => `list-${index}`);
    const plan = planCountSources(ids);
    assert.equal(plan.live.length, LIVE_COUNT_LIMIT);
    assert.deepEqual(plan.live, ids.slice(0, LIVE_COUNT_LIMIT));
    assert.deepEqual(plan.fallback, ids.slice(LIVE_COUNT_LIMIT));
  });

  test('few lists are all live; duplicates and odd limits are handled', () => {
    assert.deepEqual(planCountSources(['a', 'b']), { live: ['a', 'b'], fallback: [] });
    assert.deepEqual(planCountSources(['a', 'a', 'b'], 1), { live: ['a'], fallback: ['b'] });
    assert.deepEqual(planCountSources(['a'], 0), { live: [], fallback: ['a'] });
    assert.deepEqual(planCountSources(['a', 'b'], -2), { live: [], fallback: ['a', 'b'] });
  });
});

describe('live state: retry backoff', () => {
  test('doubles from the base and never passes the cap', () => {
    assert.deepEqual([0, 1, 2, 3, 4, 5, 6].map((attempt) => backoffDelay(attempt)), [1000, 2000, 4000, 8000, 16000, 30000, 30000]);
    assert.equal(backoffDelay(10_000), 30_000);
    assert.equal(backoffDelay(Number.POSITIVE_INFINITY), 1000);
    assert.equal(backoffDelay(-1), 1000);
    assert.equal(backoffDelay(2, { base: 100, max: 250 }), 250);
  });
});

describe('live state: deleted and missing lists', () => {
  const base = { listId: 'weekly', seenListId: 'weekly', listIds: ['hardware'], listsReady: true, deletingListId: null };

  test('an open list that was seen and is gone was deleted elsewhere', () => {
    assert.equal(isOpenListDeleted(base), true);
    assert.equal(isOpenListDeleted({ ...base, listIds: ['weekly'] }), false);
    // Never seen: a stale link, not a deletion.
    assert.equal(isOpenListDeleted({ ...base, seenListId: null }), false);
    assert.equal(isOpenListDeleted({ ...base, seenListId: 'hardware' }), false);
    // This device deleted it itself.
    assert.equal(isOpenListDeleted({ ...base, deletingListId: 'weekly' }), false);
    assert.equal(isOpenListDeleted({ ...base, listsReady: false }), false);
    assert.equal(isOpenListDeleted({ ...base, listId: null }), false);
  });

  test('a link to a missing list is decided from the server, or from the cache only offline', () => {
    const link = { listId: 'gone', listIds: ['weekly'], listsReady: true, fromCache: false, offline: false };
    assert.equal(isListLinkMissing(link), true);
    assert.equal(isListLinkMissing({ ...link, fromCache: true }), false);
    assert.equal(isListLinkMissing({ ...link, fromCache: true, offline: true }), true);
    assert.equal(isListLinkMissing({ ...link, listIds: ['gone'] }), false);
    assert.equal(isListLinkMissing({ ...link, listsReady: false }), false);
    assert.equal(isListLinkMissing({ ...link, listId: null }), false);
  });
});

describe('live state: keepListening', () => {
  type Handlers = { healthy: (fromCache: boolean) => void; failed: () => void };
  const globals = globalThis as unknown as { window?: EventTarget; document?: EventTarget & { visibilityState: string } };
  let opened: Handlers[];
  let closed: number;

  const setVisibility = (state: 'visible' | 'hidden') => {
    globals.document!.visibilityState = state;
    globals.document!.dispatchEvent(new Event('visibilitychange'));
  };

  beforeEach(() => {
    mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    globals.window = new EventTarget();
    globals.document = Object.assign(new EventTarget(), { visibilityState: 'visible' });
    opened = [];
    closed = 0;
  });

  afterEach(() => {
    mock.timers.reset();
    delete globals.window;
    delete globals.document;
  });

  const start = () => keepListening((handlers) => {
    opened.push(handlers);
    return () => {
      closed += 1;
    };
  });

  test('a failed listener is reopened with growing delays, reset by a healthy snapshot', () => {
    const stop = start();
    assert.equal(opened.length, 1);
    opened[0].failed();
    assert.equal(closed, 1);
    mock.timers.tick(999);
    assert.equal(opened.length, 1);
    mock.timers.tick(1);
    assert.equal(opened.length, 2);
    opened[1].failed();
    mock.timers.tick(1999);
    assert.equal(opened.length, 2);
    mock.timers.tick(1);
    assert.equal(opened.length, 3);
    // A healthy snapshot resets the backoff.
    opened[2].healthy(false);
    opened[2].failed();
    mock.timers.tick(1000);
    assert.equal(opened.length, 4);
    stop();
    assert.equal(closed, 4);
  });

  test('coming back online or showing the page reopens a failed listener at once', () => {
    const stop = start();
    opened[0].failed();
    globals.window!.dispatchEvent(new Event('online'));
    assert.equal(opened.length, 2);
    // Hidden: no retry is scheduled; showing the page reopens it.
    setVisibility('hidden');
    opened[1].failed();
    mock.timers.tick(60_000);
    assert.equal(opened.length, 2);
    setVisibility('visible');
    assert.equal(opened.length, 3);
    stop();
  });

  test('a healthy listener is renewed after a long hide, the new one starting before the old one stops', () => {
    const stop = start();
    opened[0].healthy(false);
    setVisibility('hidden');
    mock.timers.tick(1_000);
    setVisibility('visible');
    assert.equal(opened.length, 1, 'a short hide changes nothing');
    setVisibility('hidden');
    mock.timers.tick(STALE_AFTER_HIDDEN_MS);
    let closedWhenOpened = -1;
    const before = closed;
    // The renewal opens first: the old listener is still open at that moment.
    const originalPush = opened.push.bind(opened);
    opened.push = (...handlers: Handlers[]) => {
      closedWhenOpened = closed;
      return originalPush(...handlers);
    };
    setVisibility('visible');
    assert.equal(opened.length, 2);
    assert.equal(closedWhenOpened, before);
    assert.equal(closed, before + 1);
    stop();
  });

  test('a cached answer before each denial never resets the backoff, and the loop reports one error', () => {
    // The useLive reducer: snapshot and error states for one key.
    const key = 'items/h/a';
    let state = snapshotToState(key, ['milk'], { fromCache: false, hasPendingWrites: false });
    const reported: unknown[] = [];
    const report = () => {
      if (state.error && reported.at(-1) !== state.error) reported.push(state.error);
    };
    const opensAt: number[] = [];
    const stop = start();
    opensAt.push(Date.now());
    const denied = () => Object.assign(new Error('Missing or insufficient permissions.'), { code: 'permission-denied' });
    for (let cycle = 0; cycle < 6; cycle += 1) {
      const handlers = opened.at(-1)!;
      // Firestore answers the resubscribe from the cache, then the server denies it.
      handlers.healthy(true);
      state = snapshotToState(key, ['milk'], { fromCache: true, hasPendingWrites: false }, state);
      report();
      handlers.failed();
      state = errorToState(state, key, denied(), [] as string[]);
      report();
      const before = opened.length;
      while (opened.length === before) mock.timers.tick(1);
      opensAt.push(Date.now());
    }
    const delays = opensAt.slice(1).map((at, index) => at - opensAt[index]);
    assert.deepEqual(delays, [1000, 2000, 4000, 8000, 16000, 30000]);
    assert.equal(reported.length, 1, 'one toast for the whole loop');
    assert.equal(state.value[0], 'milk', 'the cached list stays on screen');
    // A server-confirmed snapshot clears the error and resets the schedule.
    opened.at(-1)!.healthy(false);
    state = snapshotToState(key, ['milk'], { fromCache: false, hasPendingWrites: false }, state);
    assert.equal(state.error, null);
    opened.at(-1)!.failed();
    mock.timers.tick(1000);
    assert.equal(opened.length, 8);
    stop();
  });

  test('errors with the same code are one failure; a different code is new', () => {
    const key = 'k';
    const ready = snapshotToState(key, ['x'], { fromCache: false, hasPendingWrites: false });
    const first = errorToState(ready, key, { code: 'unavailable' }, [] as string[]);
    const again = errorToState(first, key, { code: 'unavailable' }, [] as string[]);
    assert.equal(again.error, first.error);
    const other = errorToState(again, key, { code: 'permission-denied' }, [] as string[]);
    assert.notEqual(other.error, first.error);
    assert.equal(sameListenerError(new Error('a'), new Error('a')), false, 'no code: identity only');
  });

  test('an error raised while opening is handled, and nothing runs after stop', () => {
    let first = true;
    const stop = keepListening((handlers) => {
      opened.push(handlers);
      if (first) {
        first = false;
        handlers.failed();
      }
      return () => {
        closed += 1;
      };
    });
    assert.equal(closed, 1);
    mock.timers.tick(1000);
    assert.equal(opened.length, 2);
    stop();
    globals.window!.dispatchEvent(new Event('online'));
    mock.timers.tick(60_000);
    assert.equal(opened.length, 2);
  });
});

describe('clear purchased: the confirmation belongs to its list', () => {
  test('ids captured on list A are never used on list B or in another household', () => {
    const target = { householdId: 'h1', listId: 'a', ids: ['a1', 'a2'] };
    assert.deepEqual(clearIdsFor(target, 'h1', 'a'), ['a1', 'a2']);
    assert.equal(clearIdsFor(target, 'h1', 'b'), null);
    assert.equal(clearIdsFor(target, 'h2', 'a'), null);
    assert.equal(clearIdsFor(target, 'h1', null), null, 'back on the overview');
    assert.equal(clearIdsFor(null, 'h1', 'a'), null);
  });
});

describe('view transitions (SH-10i)', () => {
  test('every promise of a transition is handled, so a skipped one never goes unhandled', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      const abort = () => Promise.reject(new Error('Transition was aborted because of timeout in DOM update'));
      const transition = { ready: abort(), finished: abort(), updateCallbackDone: abort() };
      assert.equal(settleViewTransition(transition), transition);
      settleViewTransition({ finished: abort() });
      settleViewTransition({});
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(unhandled, []);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  test('callers that use the transition API all go through settleViewTransition', async () => {
    const { readFileSync } = await import('node:fs');
    for (const file of ['src/components/appearance-provider.tsx', 'src/components/motion/route-transition.ts', 'src/components/shopping/use-in-page-morph.ts']) {
      const source = readFileSync(file, 'utf8');
      const calls = source.match(/doc\.startViewTransition\(/g) ?? [];
      const settled = source.match(/settleViewTransition\(doc\.startViewTransition\(/g) ?? [];
      assert.ok(calls.length > 0, `${file} starts a transition`);
      assert.equal(settled.length, calls.length, `${file} settles every transition`);
    }
  });
});

describe('live state: one-shot URL requests wait for confirmed lists', () => {
  const grocery = { id: 'weekly', type: 'Grocery' };
  const hardware = { id: 'hardware', type: 'Hardware' };

  test('confirmed means a server snapshot, or the cache only when offline', () => {
    assert.equal(listsConfirmed({ listsReady: true, fromCache: false, offline: false }), true);
    assert.equal(listsConfirmed({ listsReady: true, fromCache: true, offline: false }), false);
    assert.equal(listsConfirmed({ listsReady: true, fromCache: true, offline: true }), true);
    assert.equal(listsConfirmed({ listsReady: false, fromCache: false, offline: false }), false);
  });

  test('?quickAdd=1 waits on a cached snapshot instead of opening a list it may not have', () => {
    // The cache still lists a Grocery list deleted elsewhere: nothing is chosen or consumed yet.
    assert.deepEqual(quickAddDecision({ requested: true, confirmed: false, canEdit: true, lists: [grocery, hardware] }), { kind: 'wait' });
    // The server snapshot no longer has it: the request is handled from that.
    assert.deepEqual(quickAddDecision({ requested: true, confirmed: true, canEdit: true, lists: [hardware] }), { kind: 'open', listId: 'hardware' });
    assert.deepEqual(quickAddDecision({ requested: true, confirmed: true, canEdit: true, lists: [hardware, { id: 'auto', type: 'Auto' }] }), { kind: 'choose' });
  });

  test('?quickAdd=1 opens the only list or the first Grocery list, and nothing without edit rights or lists', () => {
    assert.deepEqual(quickAddDecision({ requested: true, confirmed: true, canEdit: true, lists: [hardware, grocery] }), { kind: 'open', listId: 'weekly' });
    assert.deepEqual(quickAddDecision({ requested: true, confirmed: true, canEdit: false, lists: [grocery] }), { kind: 'read-only' });
    assert.deepEqual(quickAddDecision({ requested: true, confirmed: true, canEdit: true, lists: [] }), { kind: 'empty' });
    assert.equal(quickAddDecision({ requested: false, confirmed: true, canEdit: true, lists: [grocery] }), null);
  });
});

describe('tab overlays close when their tab is hidden', () => {
  test('only the active-to-inactive change counts as a deactivation', () => {
    assert.equal(deactivated(true, false), true);
    assert.equal(deactivated(false, true), false);
    assert.equal(deactivated(true, true), false);
    assert.equal(deactivated(false, false), false);
  });

  test('both force-mounted tabs are wrapped, and their menus are tab-aware', async () => {
    const { readFileSync } = await import('node:fs');
    const center = readFileSync('src/components/shopping-center-client.tsx', 'utf8');
    assert.match(center, /<TabActivity active=\{state\.tab === 'lists'\}>\s*<ShoppingListClient/);
    assert.match(center, /<TabActivity active=\{state\.tab === 'inventory'\}>\s*<PantryInventoryClient/);
    for (const file of ['src/components/shopping/list-card.tsx', 'src/components/shopping/pantry-shelves.tsx']) {
      const source = readFileSync(file, 'utf8');
      assert.doesNotMatch(source, /<DropdownMenu[\s>]/, `${file} uses a plain DropdownMenu`);
      assert.match(source, /<TabDropdownMenu>/);
    }
    for (const file of ['src/components/shopping-list-client.tsx', 'src/components/pantry-inventory-client.tsx']) {
      assert.match(readFileSync(file, 'utf8'), /useOnTabDeactivate\(\(\) => \{/, `${file} closes its overlays`);
    }
  });

  test('nested scanners close with their tab and their parent dialog, and the camera is released', async () => {
    const { readFileSync } = await import('node:fs');
    const pantry = readFileSync('src/components/pantry-inventory-client.tsx', 'utf8');
    const itemDialog = pantry.slice(pantry.indexOf('function PantryItemDialog'), pantry.indexOf('<Dialog open={isScannerOpen}'));
    assert.match(itemDialog, /useOnTabDeactivate\(\(\) => setIsScannerOpen\(false\)\)/);
    assert.match(itemDialog, /if \(!isOpen && isScannerOpen\) setIsScannerOpen\(false\)/);
    const list = readFileSync('src/components/shopping-list-client.tsx', 'utf8');
    assert.match(list, /if \(!isAddItemDialogOpen && isScannerOpen\) setIsScannerOpen\(false\)/);
    assert.match(list, /useOnTabDeactivate\(\(\) => \{[^}]*setIsScannerOpen\(false\)/);
    const scanner = readFileSync('src/components/barcode-scanner.tsx', 'utf8');
    assert.match(scanner, /getTracks\(\)\.forEach\(\(track\) => track\.stop\(\)\)/);
  });
});

describe('one-time triggers on live data', () => {
  test('the recipe is generated only when the dialog goes from closed to open', () => {
    assert.equal(justOpened(false, true), true);
    // Still open (a new pantry snapshot re-rendered it): no new request.
    assert.equal(justOpened(true, true), false);
    assert.equal(justOpened(true, false), false);
    assert.equal(justOpened(false, false), false);
  });

  test('the recipe request reads the pantry at request time and auto-runs only on open', async () => {
    const { readFileSync } = await import('node:fs');
    const pantry = readFileSync('src/components/pantry-inventory-client.tsx', 'utf8');
    const dialog = pantry.slice(pantry.indexOf('function RecipeGeneratorDialog'), pantry.indexOf('<Dialog open={isOpen} onOpenChange={onOpenChange}>', pantry.indexOf('function RecipeGeneratorDialog')));
    assert.match(dialog, /pantryItemsRef\.current\.map\(/);
    assert.match(dialog, /\}, \[householdId, toast, onRecipe, reduced\]\);/);
    assert.match(dialog, /const opened = justOpened\(wasOpenRef\.current, isOpen\);/);
    // A pending "Put on a shopping list" is dropped when the tab is hidden, and the picker is gated.
    assert.match(pantry, /if \(request !== addToListRequestRef\.current\) return;/);
    assert.match(pantry, /isOpen=\{isAddToListDialogOpen && tabActive\}/);
  });

  test("the local deletion marker clears once this device has left the list and it is gone", () => {
    const base = { deletingListId: 'weekly', selectedListId: null, listIds: ['hardware'] };
    assert.equal(deletionSettled(base), true);
    // Still open here, or still in the snapshot: the deletion is in flight.
    assert.equal(deletionSettled({ ...base, selectedListId: 'weekly' }), false);
    assert.equal(deletionSettled({ ...base, listIds: ['weekly'] }), false);
    assert.equal(deletionSettled({ ...base, deletingListId: null }), false);
    // Re-created later under the same id: the marker is already gone, so a deletion
    // elsewhere is reported again.
    assert.equal(isOpenListDeleted({ listId: 'weekly', seenListId: 'weekly', listIds: [], listsReady: true, deletingListId: null }), true);
  });
});
