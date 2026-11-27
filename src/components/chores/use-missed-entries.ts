'use client';

import { useEffect, useState } from 'react';
import { doc, onSnapshot } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { MISSED_DOC_ID, readMissedEntries, type MissedEntry } from '@functions/shared/missed';

/**
 * Live `households/{id}/stats/missed-recent` (CH-7): missed days upkeep expired out of
 * To Do. One listener on the Chores page feeds both "N missed in the last 2 weeks"
 * (`MissedRecently`) and fair streaks (CH-19). An unreadable document reads as none.
 */
export function useMissedEntries(householdId: string | null | undefined): MissedEntry[] {
  const [state, setState] = useState<{ householdId: string; entries: MissedEntry[] } | null>(null);
  useEffect(() => {
    if (!householdId) return;
    return onSnapshot(
      doc(db, 'households', householdId, 'stats', MISSED_DOC_ID),
      snap => setState({ householdId, entries: readMissedEntries(snap.exists() ? snap.data() : null) }),
      () => setState({ householdId, entries: [] }),
    );
  }, [householdId]);
  return state && state.householdId === householdId ? state.entries : EMPTY;
}

const EMPTY: MissedEntry[] = [];
