import 'server-only';

import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import { choreUndoPlan, itemUndoPlan, type ItemUndo } from '@/lib/dashboard/quick-add-undo';

/**
 * Takes back quick-add shopping entries (QA-9), each in its own transaction so one
 * changed item never blocks the others. Returns how many were taken back and which
 * were kept (bought, changed or no longer this member's to undo).
 */
export async function undoQuickAddItemsOnServer(
  db: Firestore,
  input: { householdId: string; uid: string; listId: string; items: ItemUndo[]; nowMs?: number },
): Promise<{ undone: number; kept: string[] }> {
  const items = db.collection('households').doc(input.householdId).collection('shopping-lists').doc(input.listId).collection('items');
  let undone = 0;
  const kept: string[] = [];
  for (const request of input.items) {
    const ref = items.doc(request.itemId);
    const done = await db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(ref);
      const data = snapshot.data() ?? {};
      const plan = itemUndoPlan({
        exists: snapshot.exists,
        addedByUid: data.addedByUid,
        status: data.status,
        quantity: data.quantity,
        createdMs: snapshot.createTime?.toMillis() ?? null,
      }, request, input.uid, input.nowMs ?? Date.now());
      if (plan.action === 'delete') transaction.delete(ref);
      else if (plan.action === 'decrement') transaction.update(ref, { quantity: FieldValue.increment(-plan.by) });
      return plan.action !== 'keep';
    });
    if (done) undone += 1;
    else kept.push(request.itemId);
  }
  return { undone, kept };
}

/**
 * Takes back a one-time chore the member added from quick add a moment ago (QA-9),
 * with its assignment notifications. Returns false when it was kept.
 */
export async function undoQuickAddChoreOnServer(
  db: Firestore,
  input: { householdId: string; uid: string; choreId: string; nowMs?: number },
): Promise<boolean> {
  const household = db.collection('households').doc(input.householdId);
  const ref = household.collection('chores').doc(input.choreId);
  const notices = await household.collection('notifications')
    .where('sourceType', '==', 'chore-assignment').where('sourceId', '==', input.choreId).get();
  return db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref);
    const data = snapshot.data() ?? {};
    const plan = choreUndoPlan({
      exists: snapshot.exists,
      createdByUid: data.createdByUid,
      sourceType: data.sourceType,
      isCompleted: data.isCompleted,
      createdMs: snapshot.createTime?.toMillis() ?? null,
    }, input.uid, input.nowMs ?? Date.now());
    if (plan.action !== 'delete') return false;
    transaction.delete(ref);
    for (const notice of notices.docs) transaction.delete(notice.ref);
    return true;
  });
}
