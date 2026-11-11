'use client';

import { collection, doc, limit, onSnapshot, orderBy, query, serverTimestamp, setDoc } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { useLive } from './live';
import { liveKey, type LiveState } from './live-state';
import { readAfterTrip, type AfterTrip, type TripMode } from './trip-plan';

/**
 * Live trip data for the receipt, quick add and history (S5): the household's
 * remembered after-trip choice (`shopping-settings/preferences`), its usuals
 * (`shopping-usuals`, written by the server's put-away) and its recent trips
 * (`trips`, server-only). Same kept-alive listeners as the lists (`useLive`).
 */

const millis = (value: unknown): number | null => (
  value && typeof value === 'object' && typeof (value as { toMillis?: unknown }).toMillis === 'function'
    ? (value as { toMillis: () => number }).toMillis()
    : null
);

/** The remembered receipt choice (SH-17b); "Put away & clear" until a member picks. */
export function useAfterTripPreference(householdId: string | null | undefined): AfterTrip {
  const key = liveKey('shopping-preferences', householdId);
  const state = useLive<AfterTrip>(key, 'putAwayAndClear', (next, fail) => onSnapshot(
    doc(db, 'households', householdId as string, 'shopping-settings', 'preferences'),
    { includeMetadataChanges: true },
    (snapshot) => next(readAfterTrip(snapshot.get('afterTrip')), snapshot.metadata),
    fail,
  ));
  return state.value;
}

/**
 * Remembers the receipt choice for the household. Only `afterTrip` and the server
 * time are written (the rules' allowlist); it queues offline like any write.
 */
export function rememberAfterTrip(householdId: string, choice: AfterTrip): Promise<void> {
  return setDoc(
    doc(db, 'households', householdId, 'shopping-settings', 'preferences'),
    { afterTrip: choice, updatedAt: serverTimestamp() },
    { merge: true },
  );
}

export type UsualRecord = { id: string; name: string; count: number; cadenceDays: number | null; lastBoughtAtMs: number | null };

const NO_USUALS: UsualRecord[] = [];

/** The household's usuals, most recently bought first (at most 60). */
export function useShoppingUsuals(householdId: string | null | undefined): LiveState<UsualRecord[]> {
  const key = liveKey('shopping-usuals', householdId);
  return useLive(key, NO_USUALS, (next, fail) => onSnapshot(
    query(collection(db, 'households', householdId as string, 'shopping-usuals'), orderBy('lastBoughtAt', 'desc'), limit(60)),
    { includeMetadataChanges: true },
    (snapshot) => next(snapshot.docs.map((entry) => {
      const data = entry.data();
      return {
        id: entry.id,
        name: typeof data.name === 'string' ? data.name : '',
        count: typeof data.count === 'number' ? data.count : 0,
        cadenceDays: typeof data.cadenceDays === 'number' ? data.cadenceDays : null,
        lastBoughtAtMs: millis(data.lastBoughtAt),
      };
    }), snapshot.metadata),
    fail,
  ));
}

export type TripRecord = {
  id: string;
  listId: string;
  listName: string;
  mode: TripMode;
  appliedAtMs: number | null;
  appliedByUid: string | null;
  undoneAtMs: number | null;
  items: Array<{ itemId: string; name: string; quantity: number; location: string | null; expiryDate: string | null; credited: boolean; cleared: boolean }>;
};

const NO_TRIPS: TripRecord[] = [];

/** The household's latest trips (receipt history, SH-32c), newest first. */
export function useRecentTrips(householdId: string | null | undefined, count = 10): LiveState<TripRecord[]> {
  const key = liveKey('trips', householdId, String(count));
  return useLive(key, NO_TRIPS, (next, fail) => onSnapshot(
    query(collection(db, 'households', householdId as string, 'trips'), orderBy('appliedAt', 'desc'), limit(count)),
    { includeMetadataChanges: true },
    (snapshot) => next(snapshot.docs.map((entry) => {
      const data = entry.data();
      const items = Array.isArray(data.items) ? data.items as Array<Record<string, unknown>> : [];
      return {
        id: entry.id,
        listId: String(data.listId ?? ''),
        listName: typeof data.listName === 'string' ? data.listName : '',
        mode: data.mode === 'putAway' ? 'putAway' : 'putAwayAndClear',
        appliedAtMs: millis(data.appliedAt),
        appliedByUid: typeof data.appliedByUid === 'string' ? data.appliedByUid : null,
        undoneAtMs: millis(data.undoneAt),
        items: items.map((item) => ({
          itemId: String(item.itemId ?? ''),
          name: String(item.name ?? ''),
          quantity: Number(item.quantity) || 0,
          location: typeof item.location === 'string' ? item.location : null,
          expiryDate: typeof item.expiryDate === 'string' ? item.expiryDate : null,
          credited: item.credited === true,
          cleared: item.cleared === true,
        })),
      } satisfies TripRecord;
    }), snapshot.metadata),
    fail,
  ));
}
