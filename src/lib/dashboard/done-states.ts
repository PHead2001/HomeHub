/**
 * Reconciles the dashboard's local Done states with the live chore list (HP-33d).
 *
 * A chore this dashboard completed keeps "done" until the server's change removes it
 * from the live list; once it has left, seeing it in the list again means someone
 * reopened it elsewhere, so its local state is dropped and its Done button works again.
 */
export type DoneTracking<S extends string> = {
  states: Readonly<Record<string, S>>;
  /** Ids whose local state is "done" and that have since left the live list. */
  gone: ReadonlySet<string>;
};

export function reconcileDoneStates<S extends string>(
  tracking: DoneTracking<S>,
  liveIds: Iterable<string>,
  doneState: S,
): DoneTracking<S> {
  const live = new Set(liveIds);
  const states: Record<string, S> = { ...tracking.states };
  const gone = new Set<string>();
  let changed = false;
  for (const [id, state] of Object.entries(tracking.states)) {
    if (state !== doneState) continue;
    if (!live.has(id)) {
      gone.add(id);
      if (!tracking.gone.has(id)) changed = true;
    } else if (tracking.gone.has(id)) {
      // Left after completion and came back: reopened elsewhere.
      delete states[id];
      changed = true;
    }
  }
  for (const id of tracking.gone) if (!gone.has(id) && states[id] === doneState) gone.add(id);
  if (!changed && gone.size === tracking.gone.size) return tracking;
  return { states, gone };
}
