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
  type CollectionReference,
} from 'firebase/firestore';
import { format } from 'date-fns';
import { db } from '@/lib/firebase';
import { toDate } from '@/lib/pets/care';
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
