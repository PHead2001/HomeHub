/**
 * Reconciles the dashboard's local Done states with a live list (HP-33d): the chores
 * "Done" tile (`useChoreDone`) and the Shopping tile's tick (`useShoppingTick`).
 *
 * A row this dashboard completed keeps "done" until the live list drops it; once it has
 * left, seeing it in the list again means someone reopened it elsewhere, so its local
 * state is dropped and its button works again.
 *
 * A row can leave while its completion is still saving (the server's change, or a
 * queued write, reaches the listener before the answer reaches this dashboard), so
 * departures are recorded while saving too. A row that left while saving and is listed
 * again was reopened elsewhere before the answer came: `settleDone` then drops its state
 * instead of marking it done, so its button works again. An answer for a row whose
 * state is no longer saving (an Undo cleared it, or it failed) changes nothing.
 *
 * Pure, so the hooks keep the whole tracking in React state (updaters may run twice).
 */
export type DoneTracking<S extends string> = {
  states: Readonly<Record<string, S>>;
  /** Ids whose local state is saving or done and that have since left the live list. */
  gone: ReadonlySet<string>;
  /** Ids still saving that left the live list and are listed again (reopened elsewhere). */
  returned: ReadonlySet<string>;
};

export type DoneStateNames<S extends string> = { saving: S; done: S };

export function emptyDoneTracking<S extends string>(): DoneTracking<S> {
  return { states: {}, gone: new Set(), returned: new Set() };
}

const sameSet = (a: ReadonlySet<string>, b: ReadonlySet<string>) =>
  a.size === b.size && [...a].every((id) => b.has(id));

export function reconcileDoneStates<S extends string>(
  tracking: DoneTracking<S>,
  liveIds: Iterable<string>,
  names: DoneStateNames<S>,
): DoneTracking<S> {
  const live = new Set(liveIds);
  const states: Record<string, S> = { ...tracking.states };
  const gone = new Set<string>();
  const returned = new Set<string>();
  let changed = false;
  for (const [id, state] of Object.entries(tracking.states)) {
    if (state !== names.done && state !== names.saving) continue;
    const left = tracking.gone.has(id) || tracking.returned.has(id);
    if (!live.has(id)) {
      gone.add(id);
    } else if (state === names.done && left) {
      // Left after completing here and came back: reopened elsewhere.
      delete states[id];
      changed = true;
    } else if (state === names.saving && left) {
      // Came back before the answer: remembered, so the answer does not mark it done.
      returned.add(id);
    }
  }
  if (!changed && sameSet(gone, tracking.gone) && sameSet(returned, tracking.returned)) return tracking;
  return { states, gone, returned };
}

/** Sets (or with null clears) one row's state; a new attempt starts with no departure history. */
export function setDoneState<S extends string>(tracking: DoneTracking<S>, id: string, state: S | null): DoneTracking<S> {
  const unchanged = state
    ? tracking.states[id] === state
    : !(id in tracking.states) && !tracking.gone.has(id) && !tracking.returned.has(id);
  if (unchanged) return tracking;
  const states = { ...tracking.states };
  if (state) states[id] = state;
  else delete states[id];
  const gone = new Set(tracking.gone);
  const returned = new Set(tracking.returned);
  gone.delete(id);
  returned.delete(id);
  return { states, gone, returned };
}

/**
 * The completion was accepted. A row still saving reads "done" until it leaves the list
 * (its departure history is kept, so a later return re-enables it); a row that already
 * left and came back while saving was reopened elsewhere, so its state is dropped.
 */
export function settleDone<S extends string>(tracking: DoneTracking<S>, id: string, names: DoneStateNames<S>): DoneTracking<S> {
  if (tracking.states[id] !== names.saving) return tracking;
  if (tracking.returned.has(id)) return setDoneState(tracking, id, null);
  return { ...tracking, states: { ...tracking.states, [id]: names.done } };
}
