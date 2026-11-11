// The write of rekey-chore-ids.mjs: one chore moved to its email-free id in one
// transaction. Separate from the script so tests/server/chore-id-rekey.test.ts
// can run it against the Firestore emulator.

import { rekeyTargets, rekeyedChoreData } from './chore-id-rekey.mjs';

/**
 * Moves one chore to its occurrence id: creates the same document under the
 * first free id of `rekeyTargets(plan.base)` and deletes the old one, in one
 * transaction that re-reads the household, the chore and every target first.
 * @param {import('firebase-admin/firestore').Firestore} db
 * @param {import('firebase-admin/firestore').DocumentReference} choreRef The chore under its old id.
 * @param {import('firebase-admin/firestore').Timestamp | undefined} updateTime Update time the plan was made from.
 * @param {{ base: string, occurrenceKey: string | null }} plan From choreIdRekeyPlan.
 * @returns {Promise<'moved' | 'duplicate' | 'changed' | 'no-free-id' | 'stopped'>}
 *   - `moved`: now under `plan.base`;
 *   - `duplicate`: `plan.base` already held a chore, so it went to a numbered slot;
 *   - `changed`: the chore was changed or deleted since it was read (nothing written; a re-run picks it up);
 *   - `no-free-id`: every slot is taken (nothing written);
 *   - `stopped`: the household is gone or being deleted (nothing written).
 */
export async function moveChoreToOccurrenceId(db, choreRef, updateTime, plan) {
  const choresRef = choreRef.parent;
  const householdRef = choresRef.parent;
  const targets = rekeyTargets(plan.base).map(id => choresRef.doc(id));
  return db.runTransaction(async tx => {
    const [home, source, ...slots] = await tx.getAll(householdRef, choreRef, ...targets);
    if (!home.exists || home.get('deletingAt')) return 'stopped';
    if (!source.exists || !updateTime || !source.updateTime?.isEqual(updateTime)) return 'changed';
    const free = slots.findIndex(slot => !slot.exists);
    if (free < 0) return 'no-free-id';
    tx.create(targets[free], rekeyedChoreData(source.data() ?? {}, plan));
    tx.delete(choreRef);
    return free === 0 ? 'moved' : 'duplicate';
  });
}
