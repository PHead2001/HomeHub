'use client';

import { useEffect, useMemo, useReducer, useRef } from 'react';

/** Each subscription's number: the first event of a new one starts the state over (see live-data.ts). */
let lastSession = 0;
import { collection, onSnapshot, orderBy, query, type QuerySnapshot } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { resilientListener, type ResilientHandle } from '@/lib/dashboard/resilient-listener';
import {
  MAINTENANCE_COLLECTIONS, MAINTENANCE_ORDER, initialLiveState, liveReducer, liveView, type MaintenanceLiveView,
} from '@/lib/maintenance/live-data';

/**
 * Live home assets, vehicles, logs and attachment metadata of a household (MA-2): one
 * `onSnapshot` listener per collection, each a `resilientListener` (bounded backoff, retried
 * at once on `online` and when the page is visible again). Only a server-confirmed snapshot
 * resets the retry schedule, so a refused read settles on `unauthorized` (see live-data.ts).
 * Changes from this page's server actions, quick add and other devices arrive through these
 * listeners, so nothing re-reads after a write. `key` names the household and member; when
 * it changes or is null the listeners stop and nothing of the old key is shown.
 */
export function useMaintenanceLiveData(
  householdId: string | null | undefined,
  key: string | null,
  /**
   * `recoverUnauthorizedAfterMs`: a registered wall tablet subscribes again this long after a
   * settled refusal (`TABLET_DENIED_RECOVERY_MS`), as its other listeners do, instead of
   * staying quiet (a section switched off and on again, M8b). Personal pages leave it unset.
   */
  options: { recoverUnauthorizedAfterMs?: number } = {},
): MaintenanceLiveView & { retry: () => void } {
  const recoverAfter = options.recoverUnauthorizedAfterMs;
  const [state, dispatch] = useReducer(liveReducer, key, (initialKey) => initialLiveState(initialKey));
  const handles = useRef<ResilientHandle[]>([]);

  useEffect(() => {
    if (!key || !householdId) return;
    const session = ++lastSession;
    const started = MAINTENANCE_COLLECTIONS.map((name) => {
      const order = MAINTENANCE_ORDER[name];
      const list = collection(db, 'households', householdId, name);
      const source = order ? query(list, orderBy(order.field, order.direction)) : query(list);
      let answered = false;
      let fromServer = false;
      return resilientListener<QuerySnapshot>(
        (next, error) => onSnapshot(source, { includeMetadataChanges: true }, next, error),
        {
          next: (snapshot) => {
            const confirmed = !snapshot.metadata.fromCache;
            // A metadata-only change (a write acknowledged) changes no record; the first
            // server confirmation of a cached answer is still passed on (`confirmed`).
            if (answered && snapshot.docChanges().length === 0 && (fromServer || !confirmed)) return;
            answered = true;
            fromServer ||= confirmed;
            dispatch({
              type: 'answer', key, session, collection: name, fromCache: !confirmed,
              docs: snapshot.docs.map((item) => ({ id: item.id, ...item.data() })),
            });
          },
          confirmed: (snapshot) => !snapshot.metadata.fromCache,
          ...(recoverAfter !== undefined ? { recoverUnauthorizedAfterMs: recoverAfter } : {}),
          status: (status) => {
            if (status.kind === 'live') return;
            if (status.kind === 'retrying') console.warn(`Maintenance ${name} listener failed; retrying in ${status.delayMs} ms.`);
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
  }, [householdId, key, recoverAfter]);

  const view = useMemo(() => liveView(state, key), [state, key]);
  const retry = useMemo(() => () => handles.current.forEach((handle) => handle.retryNow()), []);
  return useMemo(() => ({ ...view, retry }), [view, retry]);
}
