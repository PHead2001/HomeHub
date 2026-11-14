/**
 * Who may do what with medication courses (P3; design requirement R5): one
 * table, read by the Pets UI to show controls and by any server action that
 * runs a course action (the registered-tablet device gate reuses these
 * constants for `pets.dose.give`, `pets.dose.undo`, `pets.course.finish`,
 * `pets.course.edit` and `pets.medication.confirmLegacy`, never a separate
 * mapping). Firestore rules enforce the same permissions
 * (`firestore.rules`, medication courses and logs); `tests/unit/pets-medication-course.test.ts`
 * checks this table against the rules' permission names.
 *
 * An actor needs at least one of the listed permissions. `pets.dose.undo`
 * additionally limits `pets.addLogs` holders to their own dose within the
 * 10-minute author window (the rules' `medicationAuthorWithinUndoWindow`);
 * `pets.deleteLogs` may remove any dose record.
 */
import type { HouseholdPermission } from '../types';

export const MEDICATION_ACTION_PERMISSIONS = {
  /** Record a dose of an active course (Give dose), now or at an earlier given-at time. */
  'pets.dose.give': ['pets.addLogs'],
  /** Remove a dose record (Undo or the history's delete). */
  'pets.dose.undo': ['pets.addLogs', 'pets.deleteLogs'],
  /** Record a dose outside any course (no schedule, no reminders). */
  'pets.dose.oneOff': ['pets.addLogs'],
  /** Finish a course (and its Undo or a later resume), or finish a legacy medication without a schedule. */
  'pets.course.finish': ['pets.addLogs'],
  /**
   * Create a course, edit its name, dosage or schedule, or merge a legacy name
   * into it. `pets.addLogs`, not `pets.editProfiles` (lead decision 2026-11-14):
   * in 2.1 anyone who logged a dose could enter its next due date, which is a
   * schedule, so this must not regress. On a registered tablet the device policy
   * still makes these PIN-level (F4).
   */
  'pets.course.edit': ['pets.addLogs'],
  /** Confirm a schedule for a legacy medication (D-P8 confirmation card); same reasoning. */
  'pets.medication.confirmLegacy': ['pets.addLogs'],
} as const satisfies Record<string, readonly HouseholdPermission[]>;

export type MedicationAction = keyof typeof MEDICATION_ACTION_PERMISSIONS;

/** Whether effective permissions allow a medication action (at least one listed permission). */
export function mayMedication(action: MedicationAction, permissions: Partial<Record<HouseholdPermission, boolean>>): boolean {
  return MEDICATION_ACTION_PERMISSIONS[action].some((permission) => permissions[permission] === true);
}
