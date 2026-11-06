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
  Timestamp,
  type CollectionReference,
  type Query,
  type QueryDocumentSnapshot,
} from 'firebase/firestore';
import { format } from 'date-fns';
import { db } from '@/lib/firebase';
import { mergeById, newestFirst, pendingWindowStart, toDate } from '@/lib/pets/care';
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
type KeyedLogs<T> = { key: string | null; logs: T[]; error: unknown };
const EMPTY_KEYED = { key: null, logs: [], error: null };

/**
 * Log `date` values exist in two shapes: Firestore timestamps (feedings written by
 * this app) and ISO strings (medication and care entries, and legacy feedings).
 * Firestore orders different types separately, so a single `orderBy('date')` with
 * a limit can drop every entry of one shape. Each shape is queried on its own with
 * the same order and limit, then merged chronologically (no migration needed).
 */
const MIN_TIMESTAMP = Timestamp.fromMillis(-62135596800000); // 0001-01-01

function dateShapeQueries(ref: CollectionReference, since: Date | null, max?: number): Query[] {
  const stringFloor = since ? new Date(since.getTime() - 24 * 3_600_000).toISOString().slice(0, 10) : '';
  const shapes: Query[] = [
    query(ref, where('date', '>=', since ? Timestamp.fromDate(since) : MIN_TIMESTAMP), orderBy('date', 'desc')),
    // Date-only or differently formatted ISO strings compare as text; a one-day
    // margin keeps them in range (extra entries are harmless to the callers).
    query(ref, where('date', '>=', stringFloor), orderBy('date', 'desc')),
  ];
  return max ? shapes.map((shape) => query(shape, limitTo(max))) : shapes;
}

/** Feeding dates become `Date`; other kinds keep ISO strings (timestamps are converted). */
function normalizeEntry(kind: PetLogKind, entry: QueryDocumentSnapshot): { id: string; date: unknown } & Record<string, unknown> {
  const data = entry.data();
  const date = toDate(data.date);
  if (kind === 'feeding-logs') return { id: entry.id, ...data, date: date ?? new Date(0) };
  return { id: entry.id, ...data, date: typeof data.date === 'string' ? data.date : (date?.toISOString() ?? '') };
}

type UnionSpec = {
  key: string | null;
  householdId: string | null | undefined;
  petId: string;
  kind: PetLogKind;
  /** `shapes`: both date shapes (optionally from `sinceMs`, limited to `max`); `dated`: entries with a next due date. */
  mode: 'shapes' | 'dated';
  sinceMs?: number | null;
  max?: number;
};

/** Subscribes to one or more queries; resolves once each has answered, keyed so stale results never show. */
function useLiveUnion({ key, householdId, petId, kind, mode, sinceMs, max }: UnionSpec) {
  const [state, setState] = useState<KeyedLogs<Record<string, unknown>[]>>(EMPTY_KEYED);

  useEffect(() => {
    if (!key || !householdId) return;
    const ref = petLogsCollection(householdId, petId, kind);
    const queries = mode === 'dated'
      ? [query(ref, where('nextDueDate', '>=', ''))]
      : dateShapeQueries(ref, sinceMs == null ? null : new Date(sinceMs), max);
    const results: (Record<string, unknown>[] | undefined)[] = queries.map(() => undefined);
    let failed = false;
    const unsubscribes = queries.map((shape, index) =>
      onSnapshot(
        shape,
        (snapshot) => {
          results[index] = snapshot.docs.map((entry) => normalizeEntry(kind, entry));
          if (!failed && results.every(Boolean)) setState({ key, logs: results as Record<string, unknown>[][], error: null });
        },
        (error) => {
          failed = true;
          console.error(`Error loading ${kind}:`, error);
          setState({ key, logs: [], error });
        },
      ),
    );
    return () => unsubscribes.forEach((unsubscribe) => unsubscribe());
  }, [key, householdId, petId, kind, mode, sinceMs, max]);

  return state;
}

/** Live, newest-first log entries for one pet, correct across both date shapes. */
export function usePetLogs<T extends PetFeedingLog | PetMedicationLog | PetCareLog>(
  householdId: string | null | undefined,
  petId: string,
  kind: PetLogKind,
  max = 50,
): LiveLogs<T> {
  const key = householdId ? `${householdId}/${petId}/${kind}/${max}` : null;
  const state = useLiveUnion({ key, householdId, petId, kind, mode: 'shapes', max });

  if (!key) return { logs: [], loading: false, error: null };
  // Until the current subscriptions answer, show loading (never another pet's logs).
  if (state.key !== key) return { logs: [], loading: true, error: null };
  if (state.error) return { logs: [], loading: false, error: state.error };
  const lists = state.logs as unknown as (T & { id: string; date: unknown })[][];
  return { logs: newestFirst(lists, max) as T[], loading: false, error: null };
}

/**
 * Medication entries needed for the next-dose countdown, independent of any
 * history window: every entry with a `nextDueDate`, plus every entry (in both
 * date shapes) from the oldest pending medication's latest dated dose onward, so a
 * monthly dose stays visible however many daily doses are logged, and a later
 * dose of the same medication still supersedes it. All queries are live and use
 * single-field indexes.
 */
export function useMedicationCountdownLogs(householdId: string | null | undefined, petId: string): LiveLogs<PetMedicationLog> {
  const key = householdId ? `${householdId}/${petId}` : null;
  const dated = useLiveUnion({ key, householdId, petId, kind: 'medication-logs', mode: 'dated' });

  const datedReady = dated.key === key && !dated.error;
  const datedLogs = datedReady ? ((dated.logs as unknown as PetMedicationLog[][])[0] ?? []) : [];
  const since = datedReady ? pendingWindowStart(datedLogs) : null;
  const sinceKey = key && since ? `${key}@${since.toISOString()}` : null;
  const recent = useLiveUnion({ key: sinceKey, householdId, petId, kind: 'medication-logs', mode: 'shapes', sinceMs: since?.getTime() ?? null });

  if (!key) return { logs: [], loading: false, error: null };
  if (dated.key !== key) return { logs: [], loading: true, error: null };
  if (dated.error) return { logs: [], loading: false, error: dated.error };
  if (!sinceKey) return { logs: [], loading: false, error: null };
  if (recent.key !== sinceKey) return { logs: [], loading: true, error: null };
  if (recent.error) return { logs: [], loading: false, error: recent.error };
  const recentLogs = (recent.logs as unknown as PetMedicationLog[][]).flat();
  return { logs: mergeById(datedLogs, recentLogs), loading: false, error: null };
}
