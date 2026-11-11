/**
 * The dashboard's live data store and section states (HP-4, HP-5, GOAL-states,
 * GOAL-lastgood). Pure, so the rules are unit tested:
 *
 * - The store belongs to one context: household + member + view permissions. Any
 *   context change starts from an empty store, so the previous household's or
 *   member's data never flashes (last-good data is kept only within one context).
 * - "Today" is not part of the context. At household midnight only the day-scoped
 *   listeners subscribe again (`createListenerSet`: a spec restarts only when its key
 *   changes); their old values stay in the store until the new snapshot replaces them.
 * - Each listener records whether it has answered, whether its data came from the
 *   on-device cache, and whether it is retrying or unauthorized. A section (a group of
 *   listeners) is then exactly one of loading | ready | stale | unauthorized | failed.
 */
import { feedingFailureKey, type DashboardRaw } from './assemble';
import type { DashboardFacts } from './facts';

export type SectionStatus = 'loading' | 'ready' | 'stale' | 'unauthorized' | 'failed';

export type SectionState = {
  status: SectionStatus;
  /** Why it is stale: a retry is pending, or the data is from the device cache while offline. */
  reason?: 'reconnecting' | 'offline';
  /** When the section last had a live (server) answer in this context, epoch ms. */
  updatedAt: number | null;
  /** Some listener's latest answer came from the device cache (not yet confirmed by the server). */
  cached?: boolean;
};

export type ListenerState = {
  /** The failure key the listener reports under (a section, `streaks`, `feed:<petId>` …). */
  group: string;
  answered: boolean;
  fromCache: boolean;
  error: 'retrying' | 'unauthorized' | null;
  /** Last answer that did not come from the cache, epoch ms. */
  liveAt: number | null;
};

export type DashboardStore = {
  context: string;
  raw: DashboardRaw;
  listeners: Record<string, ListenerState>;
};

export const emptyStore = (context: string): DashboardStore => ({ context, raw: {}, listeners: {} });

/** The store for `context`: unchanged when it already belongs to it, otherwise empty. */
export const storeFor = (store: DashboardStore, context: string): DashboardStore =>
  (store.context === context ? store : emptyStore(context));

const listenerOf = (store: DashboardStore, id: string, group: string): ListenerState =>
  store.listeners[id] ?? { group, answered: false, fromCache: false, error: null, liveAt: null };

/** A snapshot arrived: merge its data into the raw facts and mark the listener answered. */
export function applyAnswer(
  store: DashboardStore,
  context: string,
  id: string,
  group: string,
  update: (raw: DashboardRaw) => DashboardRaw,
  meta: { fromCache: boolean; at: number },
): DashboardStore {
  const base = storeFor(store, context);
  const previous = listenerOf(base, id, group);
  return {
    ...base,
    raw: update(base.raw),
    listeners: {
      ...base.listeners,
      [id]: { group, answered: true, fromCache: meta.fromCache, error: null, liveAt: meta.fromCache ? previous.liveAt : meta.at },
    },
  };
}

/** The listener failed (a retry is scheduled) or settled on unauthorized. Its last data stays. */
export function applyError(store: DashboardStore, context: string, id: string, group: string, error: 'retrying' | 'unauthorized'): DashboardStore {
  const base = storeFor(store, context);
  return { ...base, listeners: { ...base.listeners, [id]: { ...listenerOf(base, id, group), error } } };
}

/** A nested listener was removed (a deleted list or pet): drop its state and, optionally, its data. */
export function forgetListeners(
  store: DashboardStore,
  context: string,
  ids: readonly string[],
  update?: (raw: DashboardRaw) => DashboardRaw,
): DashboardStore {
  const base = storeFor(store, context);
  if (ids.length === 0 && !update) return base;
  const listeners = { ...base.listeners };
  ids.forEach((id) => delete listeners[id]);
  return { ...base, listeners, raw: update ? update(base.raw) : base.raw };
}

/**
 * One state per group. `expected` lists the listener ids a group needs (a group with an
 * expected listener that has never answered is loading). Precedence: unauthorized,
 * failed (an error and no data to keep), loading, stale (data kept while retrying, or
 * cached data while offline), ready.
 */
export function sectionStates(
  store: DashboardStore,
  expected: Readonly<Record<string, readonly string[]>>,
  offline: boolean,
): Record<string, SectionState> {
  const groups = new Map<string, ListenerState[]>();
  for (const [group, ids] of Object.entries(expected)) {
    groups.set(group, ids.map((id) => store.listeners[id] ?? { group, answered: false, fromCache: false, error: null, liveAt: null }));
  }
  // Listeners outside the plan (nested ones: a list's items, a pet's feedings) join their group.
  for (const [id, listener] of Object.entries(store.listeners)) {
    if (expected[listener.group]?.includes(id)) continue;
    const members = groups.get(listener.group);
    if (members) members.push(listener);
    else groups.set(listener.group, [listener]);
  }
  const states: Record<string, SectionState> = {};
  for (const [group, listeners] of groups) {
    const liveTimes = listeners.map((listener) => listener.liveAt).filter((at): at is number => at !== null);
    // The oldest live answer is what the whole section can vouch for.
    const updatedAt = liveTimes.length > 0 ? Math.min(...liveTimes) : null;
    let state: SectionState;
    if (listeners.some((listener) => listener.error === 'unauthorized')) state = { status: 'unauthorized', updatedAt };
    else if (listeners.some((listener) => listener.error === 'retrying' && !listener.answered)) state = { status: 'failed', updatedAt };
    else if (listeners.some((listener) => !listener.answered)) state = { status: 'loading', updatedAt };
    else if (listeners.some((listener) => listener.error === 'retrying')) state = { status: 'stale', reason: 'reconnecting', updatedAt };
    else if (offline && listeners.some((listener) => listener.fromCache)) state = { status: 'stale', reason: 'offline', updatedAt };
    else state = { status: 'ready', updatedAt };
    if (listeners.some((listener) => listener.fromCache)) state.cached = true;
    states[group] = state;
  }
  return states;
}

/** Groups whose data must not be shown: failed, or unauthorized (never shown as empty or zero). */
export function unavailableGroups(states: Readonly<Record<string, SectionState>>): Set<string> {
  return new Set(Object.entries(states).filter(([, state]) => state.status === 'failed' || state.status === 'unauthorized').map(([group]) => group));
}

/** The hint a stale section shows: "Reconnecting…", or "Updated 9:41" for cached data offline. */
export function staleHint(state: SectionState | undefined, timeZone?: string): string | null {
  if (!state || state.status !== 'stale') return null;
  if (state.reason === 'reconnecting') return 'Reconnecting…';
  if (state.updatedAt === null) return 'Offline, showing saved data';
  const time = new Date(state.updatedAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', ...(timeZone ? { timeZone } : null) });
  return `Updated ${time}`;
}

/** The first stale hint among `groups` (a tile that depends on several listener groups). */
export function sectionHint(states: Readonly<Record<string, SectionState>>, groups: readonly string[], timeZone?: string): string | null {
  for (const group of groups) {
    const hint = staleHint(states[group], timeZone);
    if (hint) return hint;
  }
  return null;
}

/**
 * Marks each pet whose feeding history (`feed:<petId>`) is stale while the pets collection
 * itself is fine, so the tile and the house never show an old "0 of 2 today" or fed state as
 * current (a stale count can cause a duplicate or a missed feeding). Returns the same object
 * when nothing is stale.
 */
export function withFeedingHints(facts: DashboardFacts, states: Readonly<Record<string, SectionState>>, timeZone?: string): DashboardFacts {
  const pets = facts.pets;
  if (!pets) return facts;
  let changed = false;
  const marked = pets.pets.map((pet) => {
    const hint = pet.fed === null ? null : staleHint(states[feedingFailureKey(pet.id)], timeZone);
    if (!hint) return pet;
    changed = true;
    return { ...pet, feedingHint: hint };
  });
  return changed ? { ...facts, pets: { ...pets, pets: marked } } : facts;
}

/**
 * The facts the brief may speak from (HP-4b, GOAL-states). Once the brief has shown, a
 * section dropping back to loading (a new list whose items have not answered) must not make
 * its absence read as "nothing needs you": while not ready, the last complete facts are kept.
 */
export function briefFacts(held: DashboardFacts | null, facts: DashboardFacts, ready: boolean): DashboardFacts | null {
  return ready ? facts : held;
}

export type ListenerSpec = {
  id: string;
  /** Restart only when this changes: the id for context-scoped queries, id + day for day-scoped ones. */
  key: string;
  start: () => () => void;
};

/**
 * The running listeners of one context. `sync` keeps a listener whose key is unchanged,
 * restarts one whose key changed (a day-scoped query after midnight) and stops one no
 * longer wanted. The store is untouched, so a restarted listener's old values stay
 * visible until its new snapshot replaces them.
 */
export function createListenerSet() {
  const running = new Map<string, { key: string; stop: () => void }>();
  return {
    sync(specs: readonly ListenerSpec[]) {
      const wanted = new Set(specs.map((spec) => spec.id));
      for (const [id, entry] of running) {
        if (!wanted.has(id)) {
          entry.stop();
          running.delete(id);
        }
      }
      for (const spec of specs) {
        const entry = running.get(spec.id);
        if (entry?.key === spec.key) continue;
        // Start the new query before stopping the old one, so the two overlap briefly.
        const stop = spec.start();
        entry?.stop();
        running.set(spec.id, { key: spec.key, stop });
      }
    },
    stopAll() {
      running.forEach((entry) => entry.stop());
      running.clear();
    },
  };
}
