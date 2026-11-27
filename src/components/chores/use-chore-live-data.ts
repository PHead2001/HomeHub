'use client';

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { collection, onSnapshot, query, type QuerySnapshot } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { resilientListener, type ResilientHandle } from '@/lib/dashboard/resilient-listener';
import {
  CHORE_COLLECTIONS, choreLiveReducer, choreLiveStatus, initialChoreLiveState,
  type ChoreLiveState, type ChoreLiveStatus,
} from '@/lib/chores/live';

/** Each subscription's number: the first event of a new one starts the state over (see live.ts). */
let lastSession = 0;

/**
 * Live members, chores, chore templates and rooms of a household (CH-1): one `onSnapshot`
 * listener per collection, each a `resilientListener` (bounded backoff, retried at once on
 * `online` and when the page is visible again). Completions, new chores and reassignments
 * from other devices, quick add and server upkeep arrive here, so the page never re-reads
 * after a write. `key` names the household and member; when it changes or is null the
 * listeners stop and nothing of the old key is shown.
 */
export function useChoreLiveData(householdId: string | null | undefined, key: string | null): {
  state: ChoreLiveState;
  status: ChoreLiveStatus;
  retry: () => void;
} {
  const [state, dispatch] = useReducer(choreLiveReducer, key, (initialKey) => initialChoreLiveState(initialKey));
  const handles = useRef<ResilientHandle[]>([]);
  // **Try again** starts every listener over, also one that settled on `unauthorized`
  // after repeated refusals (it has no retry pending of its own).
  const [restart, setRestart] = useState(0);

  useEffect(() => {
    if (!key || !householdId) return;
    const session = ++lastSession;
    const started = CHORE_COLLECTIONS.map((name) => {
      const source = query(collection(db, 'households', householdId, name));
      let answered = false;
      return resilientListener<QuerySnapshot>(
        (next, error) => onSnapshot(source, next, error),
        {
          next: (snapshot) => {
            if (answered && snapshot.docChanges().length === 0) return;
            answered = true;
            dispatch({ type: 'answer', key, session, collection: name, docs: snapshot.docs.map((item) => ({ id: item.id, data: item.data() })) });
          },
          confirmed: (snapshot) => !snapshot.metadata.fromCache,
          status: (status) => {
            if (status.kind === 'live') return;
            if (status.kind === 'retrying') console.warn(`Chores ${name} listener failed; retrying in ${status.delayMs} ms.`);
            dispatch({ type: 'failure', key, session, collection: name, failure: status.kind });
          },
        },
      );
    });
    handles.current = started;
    return () => {
      started.forEach((handle) => handle.stop());
      if (handles.current === started) handles.current = [];
    };
  }, [householdId, key, restart]);

  // Nothing of another key is shown while the new listeners start.
  const current = state.key === key ? state : initialChoreLiveState(key);
  const status = choreLiveStatus(current);
  const retry = useCallback(() => setRestart((n) => n + 1), []);
  return useMemo(() => ({ state: current, status, retry }), [current, status, retry]);
}
