import 'server-only';

import { randomUUID } from 'node:crypto';
import { Timestamp, type Firestore } from 'firebase-admin/firestore';
import { isChoreDocId } from '@/lib/chores/completion';
import { householdToday } from '@/lib/chores/completion';
import { safeTimeZone } from '@functions/shared/calendar';
import { isDocId } from '@functions/shared/push-media';
import { normalizeRecurrence, occursOn } from '@functions/shared/recurrence';
import { assigneeEmailOf, resolveAssigneeUid } from '@functions/shared/assignee';
import { choreOccurrenceKey, occurrenceChoreId, storedOccurrenceKey } from '@functions/shared/ids';
import { skippedOccurrenceKeys } from '@functions/shared/skips';
import { generatedOccurrence } from '@functions/shared/occurrence-chore';
import { occurrenceNumber, rotationAnchor, rotationOf, rotationTurn } from '@functions/shared/rotation';

/**
 * Moving a planned day of a repeating chore (audit CA-15, CA-27). A planned day is an
 * occurrence upkeep has not generated yet (it makes the next 30). Moving it creates that
 * occurrence now, with the id, occurrence key and fields upkeep would give it
 * (`generatedOccurrence`, shared with the generator), due on the new day; upkeep then
 * never generates it again (its id exists). Undo deletes it while it is still exactly
 * that untouched planned move, so upkeep (or the calendar's planning) brings the original
 * day back. Both run in one Admin SDK transaction, after the server action verified the
 * caller and `chores.edit` (`authorizeHouseholdAction`).
 *
 * Undo is bound to the move (review finding 1): the move writes a server-only operation
 * record (`households/{h}/calendar-ops/{opId}`, no client may read or write it) naming the
 * chore it created, its day, who moved it and when, and returns its `opId`. Undo takes only
 * that `opId`, from the same person, within `CALENDAR_OP_UNDO_MS`; a chore id alone can
 * never delete anything.
 */

/** Server-only records of calendar operations that can be undone (moves and skips). */
export const CALENDAR_OPS = 'calendar-ops';
/** How long after an operation its Undo is accepted (the toast shows 10 s; this leaves room for a slow connection). */
export const CALENDAR_OP_UNDO_MS = 10 * 60 * 1000;

/** The operation record for `opId`, or null when it is not this caller's live operation of `kind`. */
export const readCalendarOp = async (tx: FirebaseFirestore.Transaction, house: FirebaseFirestore.DocumentReference, opId: unknown, kind: 'move' | 'skip', uid: string, now: Date) => {
  if (!isDocId(opId)) return null;
  const snap = await tx.get(house.collection(CALENDAR_OPS).doc(opId));
  if (!snap.exists || snap.get('kind') !== kind || snap.get('createdByUid') !== uid) return null;
  const created = snap.get('createdAt');
  const createdMs = created instanceof Timestamp ? created.toMillis() : NaN;
  if (!Number.isFinite(createdMs) || now.getTime() - createdMs > CALENDAR_OP_UNDO_MS) return null;
  return snap;
};

export class PlannedMoveError extends Error {
  constructor(readonly code: 'invalid' | 'not-found' | 'conflict') {
    super(code);
    this.name = 'PlannedMoveError';
  }
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const isDay = (value: unknown): value is string => typeof value === 'string' && DAY.test(value);

export type PlannedMoveInput = { templateId: unknown; roomId: unknown; day: unknown; toDay: unknown };
export type PlannedMoveOutcome = { choreId: string; day: string; toDay: string; opId: string };

/**
 * Creates the planned occurrence (`templateId`, `roomId`, its own `day`) due on `toDay`.
 * Refused (`invalid`) for a day the template does not repeat on, a day before today
 * (household time zone), a skipped day, a template assigned by email only or to someone
 * who is not an approved member; `conflict` when the occurrence already exists (generated
 * meanwhile: the calendar then shows the real chore, which moves like any other).
 */
export async function movePlannedOccurrence(db: Firestore, householdId: string, input: PlannedMoveInput, now = new Date(), actorUid = ''): Promise<PlannedMoveOutcome> {
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
    // Same assignee rule as upkeep (functions/src/reminders.ts): the person whose turn it is
    // for a rotation (CH-28; kid profiles take no turns yet, someone who left passes theirs
    // on), else an approved member by uid; a template that still carries an email waits for
    // upkeep, which resolves it through the contact documents.
    const memberSnaps = await tx.get(house.collection('members'));
    const members = memberSnaps.docs
      .filter(member => (member.get('status') ?? 'active') === 'active' && member.get('role') !== 'newuser')
      .map(member => ({
        uid: member.id,
        displayName: typeof member.get('displayName') === 'string' ? member.get('displayName') as string : null,
        identity: member.get('kind') === 'identity',
      }));
    const rotation = rotationOf(data);
    let uid: string | null;
    if (rotation.length > 0) {
      uid = rotationTurn(rotation, occurrenceNumber(recurrence, rotationAnchor(data), day), candidate => members.some(member => member.uid === candidate && !member.identity));
    } else {
      if (assigneeEmailOf(data)) throw new PlannedMoveError('invalid');
      uid = resolveAssigneeUid(data, members);
    }
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
    const opId = randomUUID();
    tx.create(house.collection(CALENDAR_OPS).doc(opId), {
      kind: 'move', choreId: occurrence.id, toDay, createdByUid: actorUid, createdAt: Timestamp.fromDate(now),
      expiresAt: Timestamp.fromMillis(now.getTime() + CALENDAR_OP_UNDO_MS),
    });
    return { choreId: occurrence.id, day, toDay, opId };
  });
}

/**
 * Undo of a planned move, by its `opId` only (the caller's own move, within
 * `CALENDAR_OP_UNDO_MS`): deletes the chore that move created while it is still the
 * untouched planned move (a generated occurrence, open, no step ticked, due on the move's
 * day), so a completion or another change made meanwhile is never lost (`stale`).
 * `missing` when it is already gone; `invalid` for anything that is not such a move.
 */
export async function undoPlannedMove(db: Firestore, householdId: string, input: { opId: unknown }, actorUid: string, now = new Date()): Promise<{ status: 'undone' | 'stale' | 'missing' }> {
  if (!isDocId(householdId) || !actorUid) throw new PlannedMoveError('invalid');
  const house = db.collection('households').doc(householdId);
  return db.runTransaction(async (tx) => {
    const op = await readCalendarOp(tx, house, input?.opId, 'move', actorUid, now);
    const choreId = op?.get('choreId');
    const toDay = op?.get('toDay');
    if (!op || !isChoreDocId(choreId) || !isDay(toDay)) throw new PlannedMoveError('invalid');
    const ref = house.collection('chores').doc(choreId);
    const snap = await tx.get(ref);
    tx.delete(op.ref);
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
