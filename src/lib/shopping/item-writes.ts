import { deleteField, increment, serverTimestamp } from 'firebase/firestore';

/**
 * The update that merges `add` more of an item into an existing shopping-list
 * item. Always an atomic `increment()`, never a total computed from a local read:
 * two members (or a device with a stale list) adding the same item both count,
 * and the increment queues offline like any other write.
 */
export function quantityIncrement(add: number) {
  return { quantity: increment(add) };
}

/**
 * A tick (S3): who bought it and when (the server's clock), and a fresh
 * `purchaseOpId` that this tick's Undo must match. `undoOpId` is removed, so any
 * later Undo is a new key the rules check against the current purchase.
 */
export function tickUpdate(uid: string | null | undefined, purchaseOpId: string) {
  return {
    status: 'purchased' as const,
    purchasedByUid: uid ?? null,
    purchasedAt: uid ? serverTimestamp() : null,
    purchaseOpId,
    undoOpId: deleteField(),
  };
}

/** Un-ticking from Purchased (a new decision, not an Undo): back to needed, purchase cleared. */
export function untickUpdate() {
  return { status: 'needed' as const, purchasedByUid: null, purchasedAt: null };
}

/**
 * The Undo of the tick `purchaseOpId`. Only these fields are written (never a
 * copy of the item), and the rules accept it only while the item's
 * `purchaseOpId` is still `purchaseOpId`: if someone ticked it again meanwhile,
 * the Undo is refused and their change stays.
 */
export function undoTickUpdate(purchaseOpId: string) {
  return { status: 'needed' as const, undoOpId: purchaseOpId, purchasedByUid: null, purchasedAt: null };
}

/** An edit from the item sheet (SH-8a): the changed fields, signed by the editor with the server's clock. */
export function editUpdate(uid: string, changes: { name?: string; nameKey?: string; quantity?: number; category?: string; categorySource?: 'manual' }) {
  return { ...changes, editedByUid: uid, editedAt: serverTimestamp() };
}
