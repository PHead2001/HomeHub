'use client';

import { useEffect, useState } from 'react';
import { collection, onSnapshot, type QuerySnapshot } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { resilientListener } from '@/lib/dashboard/resilient-listener';
import type { MedicationDue } from '@/lib/pets/care';
import { medicationDues, pendingLegacyGroups, readCourse, takenLegacyKeys, type CourseView, type LegacyGroup } from '@/lib/pets/medication-course';
import type { PetMedicationLog } from '@/lib/pets/types';
import type { LiveFailure } from '@/lib/pets/live-listener';
import { useMedicationCountdownLogs } from './pet-log-api';

type LiveCourses = { courses: CourseView[]; loading: boolean; error: unknown };

/**
 * A pet's medication courses, live (P3). A resilient listener (PE-8g): a failed
 * read resubscribes with bounded backoff and on `online` / visibility, and is
 * reported as unavailable (`error`), never as "no courses".
 */
export function useMedicationCourses(householdId: string | null | undefined, petId: string): LiveCourses {
  const key = householdId ? `${householdId}/${petId}` : null;
  const [state, setState] = useState<{ key: string | null; courses: CourseView[]; error: unknown }>({ key: null, courses: [], error: null });

  useEffect(() => {
    if (!key || !householdId) return;
    const handle = resilientListener<QuerySnapshot>(
      (next, error) => onSnapshot(collection(db, 'households', householdId, 'pets', petId, 'medication-courses'), next, error),
      {
        next: (snapshot) => {
          const courses = snapshot.docs.flatMap((entry) => {
            // A pending server time (just finished or created here) reads as its local estimate.
            const course = readCourse(entry.id, entry.data({ serverTimestamps: 'estimate' }));
            return course ? [course] : [];
          });
          setState({ key, courses, error: null });
        },
        status: (status) => {
          if (status.kind === 'live') return;
          console.error('Error loading medication courses:', status.error);
          setState({ key, courses: [], error: status.error ?? new Error('unavailable') });
        },
      },
    );
    return () => handle.stop();
  }, [key, householdId, petId]);

  if (!key) return { courses: [], loading: false, error: null };
  if (state.key !== key) return { courses: [], loading: true, error: null };
  return { courses: state.courses, loading: false, error: state.error };
}

export type MedicationState = {
  courses: CourseView[];
  /** Every current countdown (courses and legacy), most urgent first; empty while loading or unavailable. */
  dues: MedicationDue[];
  /** Legacy medications waiting for a member to confirm a schedule or finish them (D-P8). */
  legacy: LegacyGroup[];
  legacyLogs: PetMedicationLog[];
  loading: boolean;
  error: unknown;
  /** Why `error` is set (`retrying` or `unauthorized`), for the unavailable copy. */
  failure?: LiveFailure;
};

/** Courses plus the legacy countdown entries, combined into one countdown list for a pet. */
export function useMedicationState(householdId: string | null | undefined, petId: string, now: Date, timeZone: string | null): MedicationState {
  const courses = useMedicationCourses(householdId, petId);
  const legacy = useMedicationCountdownLogs(householdId, petId);
  const loading = courses.loading || legacy.loading;
  const error = courses.error || legacy.error;
  if (loading || error) return { courses: courses.courses, dues: [], legacy: [], legacyLogs: [], loading, error };
  return {
    courses: courses.courses,
    dues: medicationDues(courses.courses, legacy.logs, now, timeZone),
    legacy: pendingLegacyGroups(legacy.logs, takenLegacyKeys(courses.courses), timeZone ?? ''),
    legacyLogs: legacy.logs,
    loading: false,
    error: null,
  };
}
