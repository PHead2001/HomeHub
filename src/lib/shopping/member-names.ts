'use client';

import { useEffect, useState } from 'react';
import { collection, getDocs } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { memberNameMap } from '@/lib/shopping/attribution';

const EMPTY: ReadonlyMap<string, string> = new Map();

/**
 * The household's member display names by uid, for "Sam added · 2d" (SH-28b).
 * One read of `households/{id}/members` per household (only `uid` and
 * `displayName` are kept; emails are never used). A failed read leaves the map
 * empty, so rows fall back to "Member".
 */
export function useMemberNames(householdId: string | null | undefined): ReadonlyMap<string, string> {
  const [state, setState] = useState<{ householdId: string; names: ReadonlyMap<string, string> } | null>(null);
  useEffect(() => {
    if (!householdId) return;
    let cancelled = false;
    getDocs(collection(db, 'households', householdId, 'members'))
      .then((snapshot) => {
        if (cancelled) return;
        setState({
          householdId,
          names: memberNameMap(snapshot.docs.map((member) => ({ uid: member.get('uid') ?? member.id, displayName: member.get('displayName') }))),
        });
      })
      .catch(() => {
        if (!cancelled) setState({ householdId, names: EMPTY });
      });
    return () => {
      cancelled = true;
    };
  }, [householdId]);
  return state && state.householdId === householdId ? state.names : EMPTY;
}
