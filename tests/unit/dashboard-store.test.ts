import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  applyAnswer,
  applyError,
  createListenerSet,
  emptyStore,
  forgetListeners,
  sectionStates,
  staleHint,
  storeFor,
  unavailableGroups,
  type DashboardStore,
  type ListenerSpec,
} from '../../src/lib/dashboard/dashboard-store';

const CONTEXT = 'h1|u1|sam@example.test|true';
const live = { fromCache: false, at: Date.UTC(2026, 10, 9, 15, 41) };
const chores = { chores: ['chores.rooms', 'chores.today'] };

/** Specs for one day: rooms is context-scoped, today's chores are day-scoped. */
function specsFor(day: string, starts: string[], stops: string[]): ListenerSpec[] {
  const spec = (id: string, key: string): ListenerSpec => ({
    id,
    key,
    start: () => {
      starts.push(key);
      return () => stops.push(key);
    },
  });
  return [spec('chores.rooms', 'chores.rooms'), spec('chores.today', `chores.today|${day}`)];
}

describe('createListenerSet: the day / context split (HP-4a)', () => {
  it('restarts only the day-scoped listener when the household day changes', () => {
    const starts: string[] = [];
    const stops: string[] = [];
    const set = createListenerSet();
    set.sync(specsFor('2026-11-09', starts, stops));
    assert.deepEqual(starts, ['chores.rooms', 'chores.today|2026-11-09']);

    set.sync(specsFor('2026-11-09', starts, stops));
    assert.equal(starts.length, 2, 'same day: nothing resubscribes');

    set.sync(specsFor('2026-11-10', starts, stops));
    assert.deepEqual(starts.slice(2), ['chores.today|2026-11-10']);
    assert.deepEqual(stops, ['chores.today|2026-11-09'], 'rooms kept running');

    set.sync([]);
    assert.deepEqual(stops.slice(1).sort(), ['chores.rooms', 'chores.today|2026-11-10']);
  });

  it('stopAll stops everything (a context change)', () => {
    const starts: string[] = [];
    const stops: string[] = [];
    const set = createListenerSet();
    set.sync(specsFor('2026-11-09', starts, stops));
    set.stopAll();
    assert.equal(stops.length, 2);
  });
});

describe('the store keeps values across midnight (HP-4b) but never across contexts (GOAL-lastgood)', () => {
  const answered = (): DashboardStore => {
    let store = emptyStore(CONTEXT);
    store = applyAnswer(store, CONTEXT, 'chores.rooms', 'chores', (raw) => ({ ...raw, rooms: [{ id: 'kitchen' }] }), live);
    store = applyAnswer(store, CONTEXT, 'chores.today', 'chores', (raw) => ({ ...raw, todayChores: [{ id: 'yesterday' }] }), live);
    return store;
  };

  it('keeps the old day-scoped values, and the section ready, until the new snapshot answers', () => {
    const before = answered();
    // Midnight: the listener set restarts `chores.today`; the store is not touched.
    assert.equal(sectionStates(before, chores, false).chores.status, 'ready');
    assert.deepEqual(before.raw.todayChores, [{ id: 'yesterday' }]);
    const after = applyAnswer(before, CONTEXT, 'chores.today', 'chores', (raw) => ({ ...raw, todayChores: [{ id: 'today' }] }), live);
    assert.deepEqual(after.raw.todayChores, [{ id: 'today' }]);
    assert.deepEqual(after.raw.rooms, [{ id: 'kitchen' }]);
  });

  it('starts from nothing for another household, member or permission set', () => {
    const other = 'h2|u1|sam@example.test|true';
    const store = answered();
    assert.deepEqual(storeFor(store, other).raw, {});
    const next = applyAnswer(store, other, 'chores.rooms', 'chores', (raw) => ({ ...raw, rooms: [{ id: 'garage' }] }), live);
    assert.deepEqual(next.raw, { rooms: [{ id: 'garage' }] }, 'no data from the previous context');
    assert.equal(sectionStates(next, chores, false).chores.status, 'loading');
  });
});

describe('sectionStates (GOAL-states)', () => {
  it('moves loading → ready → stale (reconnecting) → ready', () => {
    let store = emptyStore(CONTEXT);
    assert.equal(sectionStates(store, chores, false).chores.status, 'loading');
    store = applyAnswer(store, CONTEXT, 'chores.rooms', 'chores', (raw) => raw, live);
    assert.equal(sectionStates(store, chores, false).chores.status, 'loading', 'one listener has not answered');
    store = applyAnswer(store, CONTEXT, 'chores.today', 'chores', (raw) => raw, live);
    assert.equal(sectionStates(store, chores, false).chores.status, 'ready');

    store = applyError(store, CONTEXT, 'chores.today', 'chores', 'retrying');
    const stale = sectionStates(store, chores, false).chores;
    assert.deepEqual([stale.status, stale.reason], ['stale', 'reconnecting']);
    assert.equal(staleHint(stale), 'Reconnecting…');
    assert.equal(unavailableGroups(sectionStates(store, chores, false)).size, 0, 'stale data is still shown');

    store = applyAnswer(store, CONTEXT, 'chores.today', 'chores', (raw) => raw, live);
    assert.equal(sectionStates(store, chores, false).chores.status, 'ready');
  });

  it('is failed when a listener errs before it ever answered', () => {
    let store = applyAnswer(emptyStore(CONTEXT), CONTEXT, 'chores.rooms', 'chores', (raw) => raw, live);
    store = applyError(store, CONTEXT, 'chores.today', 'chores', 'retrying');
    const states = sectionStates(store, chores, false);
    assert.equal(states.chores.status, 'failed');
    assert.deepEqual([...unavailableGroups(states)], ['chores']);
  });

  it('is unauthorized when the server refused, over every other state', () => {
    let store = applyAnswer(emptyStore(CONTEXT), CONTEXT, 'chores.rooms', 'chores', (raw) => raw, live);
    store = applyError(store, CONTEXT, 'chores.rooms', 'chores', 'unauthorized');
    const states = sectionStates(store, chores, false);
    assert.equal(states.chores.status, 'unauthorized');
    assert.ok(unavailableGroups(states).has('chores'));
  });

  it('is stale (offline) for cached data while offline, with the last live time', () => {
    let store = applyAnswer(emptyStore(CONTEXT), CONTEXT, 'chores.rooms', 'chores', (raw) => raw, live);
    store = applyAnswer(store, CONTEXT, 'chores.today', 'chores', (raw) => raw, live);
    store = applyAnswer(store, CONTEXT, 'chores.today', 'chores', (raw) => raw, { fromCache: true, at: live.at + 60_000 });
    assert.equal(sectionStates(store, chores, false).chores.status, 'ready', 'cached while online is ready');
    const offline = sectionStates(store, chores, true).chores;
    assert.deepEqual([offline.status, offline.reason, offline.updatedAt], ['stale', 'offline', live.at]);
    assert.equal(staleHint(offline, 'UTC'), `Updated ${new Date(live.at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', timeZone: 'UTC' })}`);
  });

  it('counts nested listeners in their group, and forgets removed ones', () => {
    const shopping = { shopping: ['shopping.lists'] };
    let store = applyAnswer(emptyStore(CONTEXT), CONTEXT, 'shopping.lists', 'shopping', (raw) => raw, live);
    store = applyError(store, CONTEXT, 'shopping.items:l1', 'shopping', 'retrying');
    assert.equal(sectionStates(store, shopping, false).shopping.status, 'failed');
    store = forgetListeners(store, CONTEXT, ['shopping.items:l1']);
    assert.equal(sectionStates(store, shopping, false).shopping.status, 'ready');
  });
});
