/**
 * Skipping days of repeating chores from the calendar (audit CA-27, the skip mechanism of
 * CH-3 and CA-5): one transaction records each day's occurrence key on its template
 * (`withSkippedOccurrences`, as deleting a day on the Chores page does) and deletes the
 * open chores upkeep already generated for those days. Upkeep and the calendar never
 * bring a skipped day back. Undo removes the keys again; upkeep then generates the days
 * that are inside its lookahead and the calendar plans the rest.
 *
 * Rules: a `chores.delete` holder may change a template's `skippedOccurrences` and nothing
 * else, and delete chores, so the calendar offers Skip only with `chores.delete`.
 */
import { doc, runTransaction } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { withSkippedOccurrences } from '../../../functions/src/shared/skips';
import { withoutSkippedOccurrences } from './calendar';

export async function skipCalendarDays(householdId: string, plan: { keys: ReadonlyMap<string, readonly string[]>; deletes: readonly string[] }, householdDay: string): Promise<void> {
  await runTransaction(db, async (transaction) => {
    const refs = [...plan.keys.keys()].map(templateId => doc(db, 'households', householdId, 'chore-templates', templateId));
    const snaps = await Promise.all(refs.map(ref => transaction.get(ref)));
    snaps.forEach((snap, index) => {
      if (!snap.exists()) return;
      transaction.update(refs[index], { skippedOccurrences: withSkippedOccurrences(snap.get('skippedOccurrences'), plan.keys.get(snap.id) ?? [], householdDay) });
    });
    plan.deletes.forEach(choreId => transaction.delete(doc(db, 'households', householdId, 'chores', choreId)));
  });
}

export async function unskipCalendarDays(householdId: string, keys: ReadonlyMap<string, readonly string[]>): Promise<void> {
  await runTransaction(db, async (transaction) => {
    const refs = [...keys.keys()].map(templateId => doc(db, 'households', householdId, 'chore-templates', templateId));
    const snaps = await Promise.all(refs.map(ref => transaction.get(ref)));
    snaps.forEach((snap, index) => {
      if (!snap.exists()) return;
      transaction.update(refs[index], { skippedOccurrences: withoutSkippedOccurrences(snap.get('skippedOccurrences'), keys.get(snap.id) ?? []) });
    });
  });
}
