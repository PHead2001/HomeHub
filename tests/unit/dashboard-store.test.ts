import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  applyAnswer,
  applyError,
  briefFacts,
  createListenerSet,
  emptyStore,
  forgetListeners,
  sectionStates,
  staleHint,
  storeFor,
  unavailableGroups,
  withFeedingHints,
  sectionHint,
  type DashboardStore,
  type ListenerSpec,
} from '../../src/lib/dashboard/dashboard-store';
import { buildMorningBrief } from '../../src/lib/dashboard/brief';
import type { DashboardFacts, PetState } from '../../src/lib/dashboard/facts';

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

describe('stale feeding histories: a pet count is never shown as current while stale', () => {
  const pet = (id: string, fed: boolean | null): PetState => ({
    id, name: id, type: 'Dog', lastFedAt: null, lastFedBy: null, fed, countLabel: fed ? '2 of 2 today' : '0 of 2 today', headline: 'h',
  });
  const facts: DashboardFacts = { pets: { pets: [pet('maple', false), pet('pixel', true)], hungry: 1, unknown: 0 } };

  it('marks the pet whose feed:<petId> group is stale while the pets collection is ready', () => {
    let store = applyAnswer(emptyStore(CONTEXT), CONTEXT, 'pets', 'pets', (raw) => raw, live);
    store = applyAnswer(store, CONTEXT, 'feed:maple:timestamp', 'feed:maple', (raw) => raw, live);
    store = applyAnswer(store, CONTEXT, 'feed:pixel:timestamp', 'feed:pixel', (raw) => raw, live);
    store = applyError(store, CONTEXT, 'feed:maple:timestamp', 'feed:maple', 'retrying');
    const states = sectionStates(store, { pets: ['pets'] }, false);
    assert.equal(states.pets.status, 'ready');

    const marked = withFeedingHints(facts, states);
    assert.deepEqual(marked.pets!.pets.map((p) => p.feedingHint), ['Reconnecting…', undefined]);
    // The tile's hint covers the displayed pets' feeding groups, not just the collection.
    assert.equal(sectionHint(states, ['pets']), null);
    assert.equal(sectionHint(states, ['pets', 'feed:maple', 'feed:pixel']), 'Reconnecting…');
  });

  it('leaves facts untouched when no feeding history is stale', () => {
    const states = sectionStates(applyAnswer(emptyStore(CONTEXT), CONTEXT, 'pets', 'pets', (raw) => raw, live), { pets: ['pets'] }, false);
    assert.equal(withFeedingHints(facts, states), facts);
  });
});

describe('briefFacts: a section loading again is never read as all clear', () => {
  const greeting = { greeting: 'Good morning' };
  const complete: DashboardFacts = {
    shopping: { activeLists: 1, neededItems: 3, lists: [{ id: 'g', name: 'Grocery', needed: 3 }], firstItems: [] },
  };
  // A new list was added: shopping waits for its items, so the section is absent.
  const incomplete: DashboardFacts = {};

  it('keeps speaking from the last complete facts while not ready', () => {
    assert.match(buildMorningBrief(incomplete, greeting).text, /Nothing needs you/, 'the trap: absent reads as all clear');
    const spoken = briefFacts(complete, incomplete, false)!;
    assert.doesNotMatch(buildMorningBrief(spoken, greeting).text, /Nothing needs you/);
    assert.equal(spoken, complete);
  });

  it('uses the new facts once ready, and has nothing to say before the first ready', () => {
    assert.equal(briefFacts(complete, incomplete, true), incomplete);
    assert.equal(briefFacts(null, incomplete, false), null);
  });
});
