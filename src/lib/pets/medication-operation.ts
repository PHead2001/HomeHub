'use client';

/**
 * Medication course actions bound to the app's Firestore (P3). The Firestore
 * work is in `medication-transaction.ts` (each takes the instance, so tests run
 * the same code on the emulator); the pure planning is in `medication-course.ts`.
 * Every Give dose entry point (card chip, Medication tab, reminder deep link)
 * goes through `giveDose`; every dose removal (Undo, history delete) through
 * `undoDose`.
 */
import { db } from '@/lib/firebase';
import {
  runConfirmLegacy,
  runFinishCourse,
  runFinishLegacy,
  runGiveDose,
  runMergeLegacy,
  runOneOffDose,
  runResumeCourse,
  runSaveCourse,
  runUndoDose,
  type GiveDoseInput,
  type GiveDoseResult,
} from './medication-transaction';

export type { GiveDoseInput, GiveDoseResult } from './medication-transaction';
export { MedicationActionError } from './medication-transaction';

type Rest<T extends (...args: never[]) => unknown> = Parameters<T>[1];

export const giveDose = (input: GiveDoseInput): Promise<GiveDoseResult> => runGiveDose(db, input);
export const undoDose = (input: Rest<typeof runUndoDose>) => runUndoDose(db, input);
export const logOneOffDose = (input: Rest<typeof runOneOffDose>) => runOneOffDose(db, input);
export const saveCourse = (input: Rest<typeof runSaveCourse>) => runSaveCourse(db, input);
export const finishCourse = (input: Rest<typeof runFinishCourse>) => runFinishCourse(db, input);
export const resumeCourse = (input: Rest<typeof runResumeCourse>) => runResumeCourse(db, input);
export const confirmLegacy = (input: Rest<typeof runConfirmLegacy>) => runConfirmLegacy(db, input);
export const finishLegacy = (input: Rest<typeof runFinishLegacy>) => runFinishLegacy(db, input);
export const mergeLegacy = (input: Rest<typeof runMergeLegacy>) => runMergeLegacy(db, input);
