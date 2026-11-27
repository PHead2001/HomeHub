import 'server-only';

import type { Firestore } from 'firebase-admin/firestore';
import { isChoreDocId } from '@/lib/chores/completion';
import { householdToday } from '@/lib/chores/completion';
import { safeTimeZone } from '@functions/shared/calendar';
import { isDocId } from '@functions/shared/push-media';
import { normalizeRecurrence, occursOn } from '@functions/shared/recurrence';
import { assigneeEmailOf, resolveAssigneeUid } from '@functions/shared/assignee';
import { choreOccurrenceKey, occurrenceChoreId, storedOccurrenceKey } from '@functions/shared/ids';
import { skippedOccurrenceKeys } from '@functions/shared/skips';
import { generatedOccurrence } from '@functions/shared/occurrence-chore';

/**
 * Moving a planned day of a repeating chore (audit CA-15, CA-27). A planned day is an
 * occurrence upkeep has not generated yet (it makes the next 30). Moving it creates that
 * occurrence now, with the id, occurrence key and fields upkeep would give it
 * (`generatedOccurrence`, shared with the generator), due on the new day; upkeep then
 * never generates it again (its id exists). Undo deletes it while it is still exactly
 * that untouched planned move, so upkeep (or the calendar's planning) brings the original
 * day back. Both run in one Admin SDK transaction, after the server action verified the
 * caller and `chores.edit` (`authorizeHouseholdAction`).
 */

export class PlannedMoveError extends Error {
  constructor(readonly code: 'invalid' | 'not-found' | 'conflict') {
    super(code);
    this.name = 'PlannedMoveError';
  }
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const isDay = (value: unknown): value is string => typeof value === 'string' && DAY.test(value);

export type PlannedMoveInput = { templateId: unknown; roomId: unknown; day: unknown; toDay: unknown };
export type PlannedMoveOutcome = { choreId: string; day: string; toDay: string };

/**
 * Creates the planned occurrence (`templateId`, `roomId`, its own `day`) due on `toDay`.
 * Refused (`invalid`) for a day the template does not repeat on, a day before today
 * (household time zone), a skipped day, a template assigned by email only or to someone
 * who is not an approved member; `conflict` when the occurrence already exists (generated
 * meanwhile: the calendar then shows the real chore, which moves like any other).
 */
export async function movePlannedOccurrence(db: Firestore, householdId: string, input: PlannedMoveInput, now = new Date()): Promise<PlannedMoveOutcome> {
  const { templateId, roomId, day, toDay } = input ?? {};
  if (!isDocId(householdId) || !isDocId(templateId) || typeof roomId !== 'string' || !roomId || roomId.includes('/') || roomId.length > 200 ||
    !isDay(day) || !isDay(toDay) || day === toDay) {
    throw new PlannedMoveError('invalid');
  }
  const house = db.collection('households').doc(householdId);
  return db.runTransaction(async (tx) => {
    const [home, template] = await Promise.all([tx.get(house), tx.get(house.collection('chore-templates').doc(templateId))]);
    if (!home.exists || home.get('deletingAt') || !template.exists) throw new PlannedMoveError('not-found');
    const timeZone = safeTimeZone(home.get('timeZone'));
    const today = householdToday(now, timeZone);
    const data = template.data() ?? {};
    const recurrence = normalizeRecurrence(data.recurrence, today);
    const rooms: string[] = Array.isArray(data.roomIds) && data.roomIds.length > 0 ? data.roomIds : ['general'];
    if (!recurrence || !occursOn(day, recurrence) || day < today || toDay < today || !rooms.includes(roomId)) throw new PlannedMoveError('invalid');
    const key = choreOccurrenceKey(templateId, roomId, day);
    if (skippedOccurrenceKeys(data).has(key)) throw new PlannedMoveError('invalid');
    // Same assignee rule as upkeep: an approved member by uid; a template that still
    // carries an email waits for upkeep, which resolves it through the contact documents.
    if (assigneeEmailOf(data)) throw new PlannedMoveError('invalid');
    const memberSnaps = await tx.get(house.collection('members'));
    const members = memberSnaps.docs
      .filter(member => (member.get('status') ?? 'active') === 'active' && member.get('role') !== 'newuser')
      .map(member => ({ uid: member.id, displayName: typeof member.get('displayName') === 'string' ? member.get('displayName') as string : null }));
    const uid = resolveAssigneeUid(data, members);
    const person = uid ? members.find(member => member.uid === uid) : undefined;
    if (!person) throw new PlannedMoveError('invalid');
    const id = occurrenceChoreId(templateId, roomId, day);
    const [existing, holders] = await Promise.all([
      tx.get(house.collection('chores').doc(id)),
      tx.get(house.collection('chores').where('occurrenceKey', '==', key).limit(1)),
    ]);
    if (existing.exists || !holders.empty) throw new PlannedMoveError('conflict');
    const occurrence = generatedOccurrence({ template: data, templateId, person, roomId, day, dueDay: toDay, timeZone });
    tx.create(house.collection('chores').doc(occurrence.id), occurrence.data);
    return { choreId: occurrence.id, day, toDay };
  });
}

/**
 * Undo of a planned move: deletes the chore only while it is still the untouched
 * planned move (a generated occurrence, open, no step ticked, due on `toDay`), so a
 * completion or another change made meanwhile is never lost (`stale`). `missing`
 * when it is already gone.
 */
export async function undoPlannedMove(db: Firestore, householdId: string, input: { choreId: unknown; toDay: unknown }): Promise<{ status: 'undone' | 'stale' | 'missing' }> {
  const { choreId, toDay } = input ?? {};
  if (!isDocId(householdId) || !isChoreDocId(choreId) || !isDay(toDay)) throw new PlannedMoveError('invalid');
  const ref = db.collection('households').doc(householdId).collection('chores').doc(choreId);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return { status: 'missing' as const };
    const data = snap.data() ?? {};
    const key = storedOccurrenceKey(snap.id, data);
    const untouched = typeof data.templateId === 'string' && key !== null && occurrenceChoreId(data.templateId, key.split('|')[1], key.slice(-10)) === snap.id &&
      data.isCompleted !== true && data.originalDueDate === toDay &&
      (!Array.isArray(data.completedSubTasks) || data.completedSubTasks.length === 0);
    if (!untouched) return { status: 'stale' as const };
    tx.delete(ref);
    return { status: 'undone' as const };
  });
}
