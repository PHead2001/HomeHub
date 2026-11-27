'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { doc, onSnapshot, setDoc } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { centsPerPointFrom } from '../../../functions/src/shared/chore-points';

/**
 * Household chore preferences at `households/{id}/chore-settings/preferences`.
 * A missing document means the defaults (leaderboard on, no allowance), so
 * households created before these settings existed behave as before. Owners and
 * admins may change them (the rules say so too). Each change is a merge, so
 * turning the leaderboard off keeps the allowance rate and the other way round.
 */
export type ChoreSettings = {
  leaderboardEnabled: boolean;
  /** Allowance (CH-29): whole cents per point, 0 (off) to 100. */
  centsPerPoint: number;
};

export const DEFAULT_CHORE_SETTINGS: ChoreSettings = { leaderboardEnabled: true, centsPerPoint: 0 };

export function useChoreSettings(householdId: string | null | undefined) {
  const [settings, setSettings] = useState<ChoreSettings>(DEFAULT_CHORE_SETTINGS);
  const latest = useRef(settings);
  useEffect(() => { latest.current = settings; }, [settings]);

  // Live (CH-1): an owner turning the leaderboard off on a phone hides it on every open page.
  useEffect(() => {
    if (!householdId) return;
    return onSnapshot(
      doc(db, 'households', householdId, 'chore-settings', 'preferences'),
      snap => {
        const data = snap.exists() ? snap.data() : null;
        setSettings({
          leaderboardEnabled: typeof data?.leaderboardEnabled === 'boolean' ? data.leaderboardEnabled : true,
          centsPerPoint: centsPerPointFrom(data),
        });
      },
      () => {
        // Unreadable preferences keep the last known value (the defaults at first).
      },
    );
  }, [householdId]);

  const save = useCallback(async (change: Partial<ChoreSettings>) => {
    if (!householdId) return;
    const previous = latest.current;
    setSettings({ ...previous, ...change });
    try {
      await setDoc(doc(db, 'households', householdId, 'chore-settings', 'preferences'), {
        ...change,
        updatedAt: new Date().toISOString(),
      }, { merge: true });
    } catch (error) {
      setSettings(previous);
      throw error;
    }
  }, [householdId]);

  const setLeaderboardEnabled = useCallback((enabled: boolean) => save({ leaderboardEnabled: enabled }), [save]);
  const setCentsPerPoint = useCallback((cents: number) => save({ centsPerPoint: cents }), [save]);

  return { settings, setLeaderboardEnabled, setCentsPerPoint };
}
