'use client';

import { useEffect, useMemo, useState } from 'react';
import { doc, onSnapshot } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { readWeekSummary, weekSnapshotDocId } from '../../../functions/src/shared/chore-points';
import { closedWeekSummary, podiumWeekStart, type StatsMember, type WeekSummary } from '@/lib/chores/stats';
import type { ChoreRecord } from '@/lib/chores/dates';

/**
 * The podium's week (CH-21, CH-29): on the first `PODIUM_DAYS` household days of a
 * week, the week that just closed, else null. Its results come from upkeep's
 * snapshot `stats/week-{weekStart}` (live), so retention, a later Undo or a new
 * allowance rate never change them; until upkeep has written it (or when it cannot
 * be read) they are computed from the retained chores with the same rule.
 */
export function useClosedWeekPodium({
  householdId,
  today,
  chores,
  members,
  centsPerPoint,
  timeZone,
}: {
  householdId: string | null | undefined;
  today: string;
  chores: readonly ChoreRecord[];
  members: readonly StatsMember[];
  centsPerPoint: number;
  timeZone: string;
}): WeekSummary | null {
  const weekStart = podiumWeekStart(today);
  const [stored, setStored] = useState<{ key: string; summary: WeekSummary | null } | null>(null);
  const key = householdId && weekStart ? `${householdId}/${weekStart}` : null;

  useEffect(() => {
    if (!householdId || !weekStart) return;
    const docKey = `${householdId}/${weekStart}`;
    return onSnapshot(
      doc(db, 'households', householdId, 'stats', weekSnapshotDocId(weekStart)),
      snap => setStored({ key: docKey, summary: snap.exists() ? readWeekSummary(snap.data()) : null }),
      () => setStored({ key: docKey, summary: null }),
    );
  }, [householdId, weekStart]);

  const snapshot = stored && stored.key === key ? stored.summary : null;
  return useMemo(() => {
    if (!weekStart) return null;
    return snapshot ?? closedWeekSummary(chores, members, weekStart, centsPerPoint, timeZone);
  }, [weekStart, snapshot, chores, members, centsPerPoint, timeZone]);
}
