'use client';

import { useCallback, useEffect, useState } from 'react';
import { doc, getDoc, setDoc } from 'firebase/firestore';
import { db } from '@/lib/firebase';

/**
 * Household chore preferences at `households/{id}/chore-settings/preferences`.
 * A missing document means the defaults (leaderboard on), so households created
 * before this setting existed behave as before. Owners and admins may change it.
 */
export type ChoreSettings = { leaderboardEnabled: boolean };

export const DEFAULT_CHORE_SETTINGS: ChoreSettings = { leaderboardEnabled: true };

export function useChoreSettings(householdId: string | null | undefined) {
  const [settings, setSettings] = useState<ChoreSettings>(DEFAULT_CHORE_SETTINGS);

  useEffect(() => {
    if (!householdId) return;
    let active = true;
    getDoc(doc(db, 'households', householdId, 'chore-settings', 'preferences'))
      .then(snap => {
        if (!active) return;
        const data = snap.exists() ? snap.data() : null;
        setSettings({ leaderboardEnabled: typeof data?.leaderboardEnabled === 'boolean' ? data.leaderboardEnabled : true });
      })
      .catch(() => {
        // Unreadable preferences fall back to the defaults.
      });
    return () => { active = false; };
  }, [householdId]);

  const setLeaderboardEnabled = useCallback(async (enabled: boolean) => {
    if (!householdId) return;
    const previous = settings;
    setSettings({ ...settings, leaderboardEnabled: enabled });
    try {
      await setDoc(doc(db, 'households', householdId, 'chore-settings', 'preferences'), {
        leaderboardEnabled: enabled,
        updatedAt: new Date().toISOString(),
      });
    } catch (error) {
      setSettings(previous);
      throw error;
    }
  }, [householdId, settings]);

  return { settings, setLeaderboardEnabled };
}
