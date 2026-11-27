import 'server-only';

import { randomUUID } from 'node:crypto';
import { Timestamp, type Firestore } from 'firebase-admin/firestore';
import { householdToday, isChoreDocId } from '@/lib/chores/completion';
import { isGeneratedInstance } from '@/lib/chores/recurrence-edits';
import { withoutSkippedOccurrences } from '@/lib/chores/calendar';
import { safeTimeZone } from '@functions/shared/calendar';
import { isDocId } from '@functions/shared/push-media';
import { storedOccurrenceKey } from '@functions/shared/ids';
import { occurrenceKeyDay, withSkippedOccurrences } from '@functions/shared/skips';
import { CALENDAR_OPS, CALENDAR_OP_UNDO_MS, readCalendarOp } from '@/lib/server/planned-chore-move';

/**
 * Skipping days of repeating chores from the calendar (audit CA-27, the skip mechanism of
 * CH-3 and CA-5), on the server (review findings 2 and 3). One Admin SDK transaction, after
 * the server action verified the caller and `chores.delete`:
 * - records each day's occurrence key on its template (`withSkippedOccurrences`, as
 *   deleting a day on Chores does), only keys of that template, today or later;
 * - re-reads every chore the calendar asked to remove and deletes it only while it is
 *   still that open generated occurrence (same template and occurrence key, not completed,
 *   no one-time `sourceType`): a chore completed or changed into another day's chore
 *   meanwhile is kept, so a completion is never deleted;
 * - keeps each deleted chore's fields in a server-only operation record
 *   (`households/{h}/calendar-ops/{opId}`, no client may read or write it).
 * Undo (the same person, by `opId`, within `CALENDAR_OP_UNDO_MS`) removes the keys again
 * and puts each deleted chore back exactly as it was (its moved day, assignee, ticked steps)
 * while its day is still free (no chore with its id or occurrence key); otherwise upkeep
 * regenerates what is missing.
 */

export class ChoreSkipError extends Error {
  constructor(readonly code: 'invalid' | 'not-found') {
    super(code);
    this.name = 'ChoreSkipError';
  }
}

/** Most days one skip may name (a long "We're away"). */
export const MAX_SKIP_ITEMS = 400;

export type SkipItem = { templateId: string; key: string; choreId?: string };

const readItems = (value: unknown): SkipItem[] => {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_SKIP_ITEMS) throw new ChoreSkipError('invalid');
  return value.map((raw) => {
    const item = raw as Record<string, unknown> | null;
    const templateId = item?.templateId;
    const key = item?.key;
    const choreId = item?.choreId;
    if (!isDocId(templateId) || typeof key !== 'string' || !key.startsWith(`${templateId}|`) || occurrenceKeyDay(key) === null ||
      (choreId !== undefined && choreId !== null && !isChoreDocId(choreId))) {
      throw new ChoreSkipError('invalid');
    }
    return { templateId, key, ...(typeof choreId === 'string' ? { choreId } : {}) };
  });
};

export type SkipOutcome = { opId: string; skipped: number; deleted: number; kept: number };

export async function skipChoreDays(db: Firestore, householdId: string, input: { items: unknown }, actorUid: string, now = new Date()): Promise<SkipOutcome> {
  if (!isDocId(householdId) || !actorUid) throw new ChoreSkipError('invalid');
  const items = readItems(input?.items);
  const house = db.collection('households').doc(householdId);
  return db.runTransaction(async (tx) => {
    const home = await tx.get(house);
    if (!home.exists || home.get('deletingAt')) throw new ChoreSkipError('not-found');
    const today = householdToday(now, safeTimeZone(home.get('timeZone')));
    const templateIds = [...new Set(items.map(item => item.templateId))];
    const choreIds = [...new Set(items.flatMap(item => (item.choreId ? [item.choreId] : [])))];
    const [templates, chores] = await Promise.all([
      Promise.all(templateIds.map(id => tx.get(house.collection('chore-templates').doc(id)))),
      Promise.all(choreIds.map(id => tx.get(house.collection('chores').doc(id)))),
    ]);
    const choreById = new Map(chores.map(snap => [snap.id, snap]));
    const keysByTemplate = new Map<string, string[]>();
    const removed: { id: string; key: string; data: FirebaseFirestore.DocumentData }[] = [];
    let kept = 0;
    for (const item of items) {
      const day = occurrenceKeyDay(item.key);
      if (!day || day < today) continue;
      const list = keysByTemplate.get(item.templateId) ?? [];
      if (!list.includes(item.key)) list.push(item.key);
      keysByTemplate.set(item.templateId, list);
      if (!item.choreId) continue;
      const snap = choreById.get(item.choreId);
      if (!snap?.exists || removed.some(entry => entry.id === snap.id)) continue;
      const data = snap.data() ?? {};
      // Only the open generated occurrence the calendar showed; never a completion.
      const same = data.isCompleted !== true && data.templateId === item.templateId &&
        isGeneratedInstance({ id: snap.id, ...data }) && storedOccurrenceKey(snap.id, data) === item.key;
      if (same) removed.push({ id: snap.id, key: item.key, data });
      else kept += 1;
    }
    let skipped = 0;
    templates.forEach((snap) => {
      const keys = keysByTemplate.get(snap.id);
      if (!snap.exists || !keys || keys.length === 0) return;
      skipped += keys.length;
      tx.update(snap.ref, { skippedOccurrences: withSkippedOccurrences(snap.get('skippedOccurrences'), keys, today) });
    });
    removed.forEach(entry => tx.delete(house.collection('chores').doc(entry.id)));
    const opId = randomUUID();
    tx.create(house.collection(CALENDAR_OPS).doc(opId), {
      kind: 'skip',
      createdByUid: actorUid,
      createdAt: Timestamp.fromDate(now),
      expiresAt: Timestamp.fromMillis(now.getTime() + CALENDAR_OP_UNDO_MS),
      keys: [...keysByTemplate.entries()].map(([templateId, keys]) => ({ templateId, keys })),
      removed,
    });
    return { opId, skipped, deleted: removed.length, kept };
  });
}

export type UnskipOutcome = { restored: number; regenerate: number };

export async function undoSkipChoreDays(db: Firestore, householdId: string, input: { opId: unknown }, actorUid: string, now = new Date()): Promise<UnskipOutcome> {
  if (!isDocId(householdId) || !actorUid) throw new ChoreSkipError('invalid');
  const house = db.collection('households').doc(householdId);
  return db.runTransaction(async (tx) => {
    const op = await readCalendarOp(tx, house, input?.opId, 'skip', actorUid, now);
    if (!op) throw new ChoreSkipError('invalid');
    const keys = (op.get('keys') as { templateId: string; keys: string[] }[] | undefined) ?? [];
    const removed = (op.get('removed') as { id: string; key: string; data: FirebaseFirestore.DocumentData }[] | undefined) ?? [];
    const templates = await Promise.all(keys.map(entry => tx.get(house.collection('chore-templates').doc(entry.templateId))));
    // A day is free when neither its document nor any chore holding its key exists.
    const checks = await Promise.all(removed.map(async (entry) => {
      const [byId, byKey] = await Promise.all([
        tx.get(house.collection('chores').doc(entry.id)),
        tx.get(house.collection('chores').where('occurrenceKey', '==', entry.key).limit(1)),
      ]);
      return !byId.exists && byKey.empty;
    }));
    templates.forEach((snap, index) => {
      if (!snap.exists) return;
      tx.update(snap.ref, { skippedOccurrences: withoutSkippedOccurrences(snap.get('skippedOccurrences'), keys[index].keys) });
    });
    let restored = 0;
    removed.forEach((entry, index) => {
      if (!checks[index]) return;
      tx.set(house.collection('chores').doc(entry.id), entry.data);
      restored += 1;
    });
    tx.delete(op.ref);
    return { restored, regenerate: removed.length - restored };
  });
}
