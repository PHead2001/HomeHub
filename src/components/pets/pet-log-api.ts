'use client';

import { useEffect, useState } from 'react';
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  limit as limitTo,
  onSnapshot,
  orderBy,
  query,
  where,
  type CollectionReference,
} from 'firebase/firestore';
import { format } from 'date-fns';
import { db } from '@/lib/firebase';
import { mergeById, pendingWindowStart, toDate } from '@/lib/pets/care';
import type { FoodType, LoggedBy, PetCareLog, PetFeedingLog, PetMedicationLog, PortionUnit } from '@/lib/pets/types';

export type PetLogKind = 'feeding-logs' | 'medication-logs' | 'care-logs';

export function petLogsCollection(householdId: string, petId: string, kind: PetLogKind): CollectionReference {
  return collection(db, 'households', householdId, 'pets', petId, kind);
}

/**
 * New log entries get Firestore auto IDs. (Older entries used "count + 1", which
 * could overwrite an existing entry after a deletion.)
 */
export async function addPetLog(householdId: string, petId: string, kind: PetLogKind, data: Record<string, unknown>) {
  return addDoc(petLogsCollection(householdId, petId, kind), data);
}

export async function deletePetLog(householdId: string, petId: string, kind: PetLogKind, logId: string) {
  await deleteDoc(doc(petLogsCollection(householdId, petId, kind), logId));
}

export type NewFeeding = {
  amount: number;
  unit: PortionUnit;
  foodType: FoodType;
  comments?: string;
  date?: Date;
} & Required<LoggedBy>;

/** Writes a feeding in the existing document shape plus who logged it. */
export function addFeedingLog(householdId: string, petId: string, feeding: NewFeeding) {
  const date = feeding.date ?? new Date();
  return addPetLog(householdId, petId, 'feeding-logs', {
    date,
    cups: feeding.amount,
    foodAmountType: feeding.unit,
    foodType: feeding.foodType,
    comments: feeding.comments ?? '',
    ampm: format(date, 'a').toUpperCase(),
    loggedByUid: feeding.loggedByUid,
    loggedByName: feeding.loggedByName,
  });
}

type LiveLogs<T> = { logs: T[]; loading: boolean; error: unknown };

/**
 * Live, newest-first log entries for one pet. Feeding dates may be Firestore
 * timestamps or ISO strings; they are normalized to `Date`.
 */
export function usePetLogs<T extends PetFeedingLog | PetMedicationLog | PetCareLog>(
  householdId: string | null | undefined,
  petId: string,
  kind: PetLogKind,
  max = 50,
): LiveLogs<T> {
  const key = householdId ? `${householdId}/${petId}/${kind}/${max}` : null;
  const [state, setState] = useState<{ key: string | null; logs: T[]; error: unknown }>({ key: null, logs: [], error: null });

  useEffect(() => {
    if (!householdId || !key) return;
    const q = query(petLogsCollection(householdId, petId, kind), orderBy('date', 'desc'), limitTo(max));
    return onSnapshot(
      q,
      (snapshot) => {
        const logs = snapshot.docs.map((entry) => {
          const data = entry.data();
          if (kind === 'feeding-logs') {
            return { id: entry.id, ...data, date: toDate(data.date) ?? new Date(0) } as unknown as T;
          }
          return { id: entry.id, ...data } as unknown as T;
        });
        setState({ key, logs, error: null });
      },
      (error) => {
        console.error(`Error loading ${kind}:`, error);
        setState({ key, logs: [], error });
      },
    );
  }, [householdId, petId, kind, max, key]);

  if (!key) return { logs: [], loading: false, error: null };
  // Until the current subscription answers, show loading (never another pet's logs).
  const ready = state.key === key;
  return { logs: ready ? state.logs : [], loading: !ready, error: ready ? state.error : null };
}

type KeyedLogs<T> = { key: string | null; logs: T[]; error: unknown };
const EMPTY_KEYED = { key: null, logs: [], error: null };

/**
 * Medication entries needed for the next-dose countdown, independent of any
 * history window: every entry with a `nextDueDate` (live), plus every entry from
 * the oldest pending medication's latest dated dose onward (live), so a monthly
 * dose stays visible however many daily doses are logged, and a later dose of the
 * same medication still supersedes it. Both queries use single-field indexes.
 */
export function useMedicationCountdownLogs(householdId: string | null | undefined, petId: string): LiveLogs<PetMedicationLog> {
  const key = householdId ? `${householdId}/${petId}` : null;
  const [dated, setDated] = useState<KeyedLogs<PetMedicationLog>>(EMPTY_KEYED);

  useEffect(() => {
    if (!householdId || !key) return;
    const q = query(petLogsCollection(householdId, petId, 'medication-logs'), where('nextDueDate', '>=', ''));
    return onSnapshot(
      q,
      (snapshot) => setDated({ key, logs: snapshot.docs.map((entry) => ({ id: entry.id, ...entry.data() }) as PetMedicationLog), error: null }),
      (error) => {
        console.error('Error loading medication due dates:', error);
        setDated({ key, logs: [], error });
      },
    );
  }, [householdId, petId, key]);

  const datedReady = dated.key === key;
  const since = datedReady ? pendingWindowStart(dated.logs) : null;
  const sinceKey = key && since ? `${key}@${since}` : null;
  const [recent, setRecent] = useState<KeyedLogs<PetMedicationLog>>(EMPTY_KEYED);

  useEffect(() => {
    if (!householdId || !since || !sinceKey) return;
    const q = query(petLogsCollection(householdId, petId, 'medication-logs'), where('date', '>=', since));
    return onSnapshot(
      q,
      (snapshot) => setRecent({ key: sinceKey, logs: snapshot.docs.map((entry) => ({ id: entry.id, ...entry.data() }) as PetMedicationLog), error: null }),
      (error) => {
        console.error('Error loading recent medication:', error);
        setRecent({ key: sinceKey, logs: [], error });
      },
    );
  }, [householdId, petId, since, sinceKey]);

  if (!key) return { logs: [], loading: false, error: null };
  if (!datedReady) return { logs: [], loading: true, error: null };
  if (dated.error) return { logs: [], loading: false, error: dated.error };
  if (!sinceKey) return { logs: [], loading: false, error: null };
  if (recent.key !== sinceKey) return { logs: [], loading: true, error: null };
  if (recent.error) return { logs: [], loading: false, error: recent.error };
  return { logs: mergeById(dated.logs, recent.logs), loading: false, error: null };
}
