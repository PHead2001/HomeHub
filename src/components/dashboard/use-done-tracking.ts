'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  emptyDoneTracking,
  reconcileDoneStates,
  setDoneState,
  settleDone,
  type DoneStateNames,
  type DoneTracking,
} from '@/lib/dashboard/done-states';

/**
 * A dashboard tile's local Done states, kept in step with its live list
 * (`src/lib/dashboard/done-states.ts`): the chores "Done" and the Shopping tick.
 * `liveIds` are the listed rows' ids, undefined while loading. `names` must be stable.
 */
export function useDoneTracking<S extends string>(liveIds: readonly string[] | undefined, names: DoneStateNames<S>) {
  const [tracking, setTracking] = useState<DoneTracking<S>>(emptyDoneTracking);
  const liveKey = liveIds?.join('|');
  // Runs on state changes too: a row often leaves the list before its answer arrives,
  // and the order of the list's snapshot and a state change is not fixed.
  useEffect(() => {
    if (!liveIds) return;
    setTracking((current) => reconcileDoneStates(current, liveIds, names));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveKey, tracking, names]);

  const set = useCallback((id: string, state: S | null) => {
    setTracking((current) => setDoneState(current, id, state));
  }, []);
  /** The completion was accepted: "done", unless the row was reopened elsewhere meanwhile. */
  const settle = useCallback((id: string) => {
    setTracking((current) => settleDone(current, id, names));
  }, [names]);

  return { states: tracking.states, set, settle };
}
