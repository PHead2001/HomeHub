import { deleteField, increment, runTransaction, serverTimestamp, type DocumentReference, type Firestore } from 'firebase/firestore';

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

/**
 * The restore document (Undo of a delete): `restoreItemData`'s output plus
 * `restoredAt` = the server's time. The rules require it on every restore and
 * accept it only on a create, so replaying the same restore onto an item that
 * exists again (and may have changed since) is refused: its restoredAt resolves
 * to a new time, a changed key on an update.
 */
export function restoreDocument<T extends object>(data: T) {
  return { ...data, restoredAt: serverTimestamp() };
}

/**
 * Re-creates a deleted item only if it is absent, online: a transaction that reads
 * the item and writes nothing when it exists ('exists'). Offline, transactions
 * cannot run; the caller queues `setDoc(itemRef, restoreDocument(data))`, which
 * the rules accept only as a create.
 */
export function restoreIfAbsent(firestore: Firestore, itemRef: DocumentReference, data: Record<string, unknown>): Promise<'restored' | 'exists'> {
  return runTransaction(firestore, async (transaction) => {
    const current = await transaction.get(itemRef);
    if (current.exists()) return 'exists' as const;
    transaction.set(itemRef, restoreDocument(data));
    return 'restored' as const;
  });
}
