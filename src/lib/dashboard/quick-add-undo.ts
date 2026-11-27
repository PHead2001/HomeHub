/**
 * Undo for quick-add saves (QA-9): what a member may take back, decided the same way
 * on the server (`src/lib/server/quick-add-undo.ts`) and in tests. Pure.
 *
 * The toast offers Undo for 10 seconds (16.3: one Undo window everywhere). The server
 * accepts it for a minute after the document was created (a slow network still
 * lands), only from the member who added it, and only while nobody has changed it
 * in a way Undo would lose: this is the narrow permission that lets a member without
 * `shopping.delete` remove an item they added a moment ago.
 */
export const QUICK_ADD_UNDO_MS = 10_000;
export const QUICK_ADD_UNDO_GRACE_MS = 60_000;

/** One saved entry to take back: the created item, or the still-needed item it merged into. */
export type ItemUndo = { itemId: string; merged: boolean; quantity: number };

export type ItemUndoPlan =
  | { action: 'delete' }
  | { action: 'decrement'; by: number }
  | { action: 'keep'; reason: 'gone' | 'not-yours' | 'too-late' | 'bought' | 'changed' };

/**
 * What undoing one entry does. A created item is deleted when the member added it,
 * it is still needed and it is younger than the grace window; if someone merged
 * more into it since, only this entry's quantity comes off. A merge takes its
 * quantity back off while more than that remains.
 */
export function itemUndoPlan(
  current: { exists: boolean; addedByUid?: unknown; status?: unknown; quantity?: unknown; createdMs?: number | null },
  request: ItemUndo,
  uid: string,
  nowMs: number,
): ItemUndoPlan {
  if (!current.exists) return { action: 'keep', reason: 'gone' };
  if (current.status !== 'needed') return { action: 'keep', reason: 'bought' };
  const quantity = typeof current.quantity === 'number' && Number.isFinite(current.quantity) ? current.quantity : 1;
  if (request.merged) {
    return quantity > request.quantity ? { action: 'decrement', by: request.quantity } : { action: 'keep', reason: 'changed' };
  }
  if (current.addedByUid !== uid) return { action: 'keep', reason: 'not-yours' };
  if (typeof current.createdMs !== 'number' || nowMs - current.createdMs > QUICK_ADD_UNDO_GRACE_MS) return { action: 'keep', reason: 'too-late' };
  if (quantity > request.quantity) return { action: 'decrement', by: request.quantity };
  return quantity === request.quantity ? { action: 'delete' } : { action: 'keep', reason: 'changed' };
}

export type ChoreUndoPlan = { action: 'delete' } | { action: 'keep'; reason: 'gone' | 'not-yours' | 'too-late' | 'done' | 'not-quick' };

/** A one-time chore the member just added comes back out while nobody has completed it. */
export function choreUndoPlan(
  current: { exists: boolean; createdByUid?: unknown; sourceType?: unknown; isCompleted?: unknown; createdMs?: number | null },
  uid: string,
  nowMs: number,
): ChoreUndoPlan {
  if (!current.exists) return { action: 'keep', reason: 'gone' };
  if (current.sourceType !== 'temporary') return { action: 'keep', reason: 'not-quick' };
  if (current.createdByUid !== uid) return { action: 'keep', reason: 'not-yours' };
  if (current.isCompleted === true) return { action: 'keep', reason: 'done' };
  if (typeof current.createdMs !== 'number' || nowMs - current.createdMs > QUICK_ADD_UNDO_GRACE_MS) return { action: 'keep', reason: 'too-late' };
  return { action: 'delete' };
}

/** Validates the client's undo request: at most 20 entries, real ids, positive whole quantities. */
export function parseItemUndos(value: unknown): ItemUndo[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > 20) return null;
  const out: ItemUndo[] = [];
  for (const entry of value) {
    const candidate = entry as Partial<ItemUndo> | null;
    if (!candidate || !isDocId(candidate.itemId) || typeof candidate.merged !== 'boolean') return null;
    if (typeof candidate.quantity !== 'number' || !Number.isInteger(candidate.quantity) || candidate.quantity < 1 || candidate.quantity > 999) return null;
    out.push({ itemId: candidate.itemId, merged: candidate.merged, quantity: candidate.quantity });
  }
  return out;
}

/** A Firestore document id a client may name. */
export const isDocId = (value: unknown): value is string => typeof value === 'string'
  && value.length > 0 && value.length <= 1500 && !value.includes('/') && value !== '.' && value !== '..' && !/^__.*__$/.test(value);
