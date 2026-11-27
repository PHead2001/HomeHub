import 'server-only';

import { FieldValue, Timestamp, type DocumentReference, type DocumentSnapshot, type Firestore } from 'firebase-admin/firestore';
import { isDocId } from '@functions/shared/push-media';
import { publicDisplayName } from '@/lib/member-directory';
import { DEFAULT_SHOPPING_CATEGORIES, buildShoppingListItem, normalizeStoredCategories } from '@/lib/shopping-items';
import { findMergeTarget } from '@/lib/shopping/items';
import { deviceAddEntries, type AddEntryInput } from '@/lib/devices/tablet-shopping';
import { initialCategory, rememberedCategories } from '@/lib/shopping/local-categories';
import type { OperationContext } from '@/lib/server/operation-context';
import { assertActorRule, type DeviceAuthority } from '@/lib/server/device-gate';
import { DeviceActionError } from '@/lib/server/device-errors';
import { assertUndoable, createdRecordUnchanged, opRef, type DeviceOp } from '@/lib/server/device-ops';

// Shopping item writes as an actor, on the server (docs/modules/shopping/README.md, "Wall
// tablets"; docs/modules/devices/README.md, "Device actions: shopping"). The personal Shopping
// page writes items with the client SDK under the rules (add-items.ts, tick.ts); a wall tablet
// has no client write rules, so its add and tick run here with the Admin SDK, in one
// transaction each, in the order every `…As` operation follows (operation-context.ts):
// the device hooks' precheck first, then the reads, then the writes, the finalize last. The
// documents are the personal path's: `buildShoppingListItem` builds a new item, a name still
// needed on the list merges into that item (`findMergeTarget`, re-read inside the
// transaction), the category comes from `initialCategory` without AI (`ai.categorize` is not
// on tablets: a name nothing knows is saved under Other as `fallback`), and a tick writes the
// fields of `tickUpdate` with the server's time and the device opId as `purchaseOpId`. The
// actor's uid goes into `addedByUid` / `purchasedByUid` (WT-18c); the tablet's attribution
// goes into `deviceAttribution` (a new item) and `purchaseDeviceAttribution` (a tick, bound to
// its `purchaseOpId`, so a later personal un-tick or re-tick never leaves a stale claim).

const householdRefOf = (db: Firestore, householdId: string) => db.collection('households').doc(householdId);

/** Every write lives under a list that still exists (the rules' `shoppingListExists`, SH-9b). */
const listRefOf = (db: Firestore, householdId: string, listId: string) =>
  db.collection('households').doc(householdId).collection('shopping-lists').doc(listId);

export class ShoppingOperationError extends Error {
  constructor(readonly code: 'invalid') {
    super(`shopping-${code}`);
  }
}

const idOf = (value: unknown): string => {
  if (!isDocId(value)) throw new ShoppingOperationError('invalid');
  return value;
};

/** The entries of one add, checked as the personal quick add parses them (`deviceAddEntries`). */
const entriesOf = (value: unknown): AddEntryInput[] => {
  const entries = deviceAddEntries(value);
  if (!entries) throw new ShoppingOperationError('invalid');
  return entries;
};

/** One entry of an add as stored in the op ledger: a new item, or a needed item it merged into. */
export type AddedItem =
  | { itemId: string; name: string; quantity: number; created: true }
  | { itemId: string; name: string; quantity: number; created: false; before: number; after: number };

export type AddResult =
  | { status: 'added'; listId: string; items: AddedItem[] }
  /** The list was deleted meanwhile: nothing was written. */
  | { status: 'gone'; listId: string };

/** The quantity a merge may store (the rules' item bound). */
const QUANTITY_CEILING = 100_000;

/**
 * Adds items to a list as the actor (`shopping.add` on a tablet). Each entry merges into the
 * list's still-needed item of the same name (its quantity raised, read in this transaction)
 * or creates a new needed item with the actor as `addedByUid`. A list deleted meanwhile is
 * `gone` (nothing is written; the ledger records a no-op). The op ledger's target is the list,
 * so the same opId sent for another list is a `conflict`.
 */
export async function addShoppingItemsAs(
  db: Firestore,
  householdId: string,
  input: { listId: unknown; entries: unknown },
  ctx: OperationContext,
): Promise<AddResult> {
  const listId = idOf(input?.listId);
  const entries = entriesOf(input?.entries);
  const listRef = listRefOf(db, householdId, listId);
  return db.runTransaction(async (tx): Promise<AddResult> => {
    const { replay } = (await ctx.hooks?.precheck(tx)) ?? {};
    if (replay) {
      if (replay.targetPath !== listRef.path) throw new DeviceActionError('conflict');
      return replay.summary.result as AddResult;
    }
    const [list, config, itemsSnapshot] = await Promise.all([
      tx.get(listRef),
      tx.get(listRef.collection('config').doc('categories')),
      tx.get(listRef.collection('items')),
    ]);
    if (!list.exists) {
      const result: AddResult = { status: 'gone', listId };
      ctx.hooks?.finalize(tx, { targetPath: listRef.path, summary: { result, noop: true } });
      return result;
    }
    const categories = (config.exists ? normalizeStoredCategories(config.data()) : null) ?? DEFAULT_SHOPPING_CATEGORIES;
    const known = itemsSnapshot.docs.map((doc) => ({
      id: doc.id,
      name: typeof doc.get('name') === 'string' ? doc.get('name') as string : '',
      status: doc.get('status') === 'purchased' ? 'purchased' as const : 'needed' as const,
      category: typeof doc.get('category') === 'string' ? doc.get('category') as string : null,
      categorySource: typeof doc.get('categorySource') === 'string' ? doc.get('categorySource') as string : null,
      nameKey: typeof doc.get('nameKey') === 'string' ? doc.get('nameKey') as string : null,
      quantity: typeof doc.get('quantity') === 'number' ? doc.get('quantity') as number : 1,
    }));
    const remembered = rememberedCategories(known);
    const actor = ctx.actor;
    const items: AddedItem[] = [];
    for (const entry of entries) {
      const target = findMergeTarget(known, entry.name);
      if (target) {
        const before = target.quantity;
        const after = Math.min(QUANTITY_CEILING, before + entry.quantity);
        tx.update(listRef.collection('items').doc(target.id), { quantity: after });
        items.push({ itemId: target.id, name: target.name || entry.name, quantity: entry.quantity, created: false, before, after });
        continue;
      }
      const { category, categorySource } = initialCategory({ name: entry.name, categories, remembered, aiAvailable: false });
      const { itemId, data } = buildShoppingListItem({ name: entry.name, quantity: entry.quantity, category, categorySource, addedByUid: actor.uid });
      tx.create(listRef.collection('items').doc(itemId), {
        ...data,
        createdAt: Timestamp.fromDate(ctx.now),
        ...(actor.device ? { deviceAttribution: actor.device } : {}),
      });
      items.push({ itemId, name: entry.name, quantity: entry.quantity, created: true });
    }
    const result: AddResult = { status: 'added', listId, items };
    ctx.hooks?.finalize(tx, { targetPath: listRef.path, summary: { result }, targetName: typeof list.get('name') === 'string' ? list.get('name') as string : null });
    return result;
  });
}

export type TickResult =
  | { status: 'ticked'; listId: string; itemId: string; name: string }
  /** Someone ticked it first: their purchase stays (never ticked again). */
  | { status: 'already'; listId: string; itemId: string; name: string; byName: string | null }
  /** The item or its list was removed meanwhile. */
  | { status: 'gone'; listId: string; itemId: string };

/**
 * Ticks a needed item as the actor (`shopping.tick` on a tablet): `status: 'purchased'`, the
 * actor as `purchasedByUid`, the server's time as `purchasedAt`, the opId as `purchaseOpId`
 * (an earlier `undoOpId` removed), as `tickUpdate` writes it. An item already purchased keeps
 * its buyer (`already`), one gone (or its list) is `gone`; both are no-ops in the ledger.
 */
export async function tickShoppingItemAs(
  db: Firestore,
  householdId: string,
  input: { listId: unknown; itemId: unknown },
  ctx: OperationContext,
): Promise<TickResult> {
  const listId = idOf(input?.listId);
  const itemId = idOf(input?.itemId);
  const listRef = listRefOf(db, householdId, listId);
  const itemRef = listRef.collection('items').doc(itemId);
  const opId = ctx.opId;
  if (!opId) throw new ShoppingOperationError('invalid');
  return db.runTransaction(async (tx): Promise<TickResult> => {
    const { replay } = (await ctx.hooks?.precheck(tx)) ?? {};
    if (replay) {
      if (replay.targetPath !== itemRef.path) throw new DeviceActionError('conflict');
      return replay.summary.result as TickResult;
    }
    const [list, item] = await Promise.all([tx.get(listRef), tx.get(itemRef)]);
    const name = typeof item.get('name') === 'string' ? item.get('name') as string : 'Item';
    if (!list.exists || !item.exists) {
      const result: TickResult = { status: 'gone', listId, itemId };
      ctx.hooks?.finalize(tx, { targetPath: itemRef.path, summary: { result, noop: true } });
      return result;
    }
    if (item.get('status') === 'purchased') {
      const buyer = item.get('purchasedByUid');
      const member = typeof buyer === 'string' && isDocId(buyer) ? await tx.get(listRef.parent.parent!.collection('members').doc(buyer)) : null;
      const byName = member?.exists ? publicDisplayName(member.get('displayName'), '') || null : null;
      const result: TickResult = { status: 'already', listId, itemId, name, byName };
      ctx.hooks?.finalize(tx, { targetPath: itemRef.path, summary: { result, noop: true } });
      return result;
    }
    tx.update(itemRef, {
      status: 'purchased',
      purchasedByUid: ctx.actor.uid,
      purchasedAt: Timestamp.fromDate(ctx.now),
      purchaseOpId: opId,
      undoOpId: FieldValue.delete(),
      ...(ctx.actor.device ? { purchaseDeviceAttribution: { ...ctx.actor.device, purchaseOpId: opId } } : {}),
    });
    const result: TickResult = { status: 'ticked', listId, itemId, name };
    ctx.hooks?.finalize(tx, { targetPath: itemRef.path, summary: { result }, targetName: name });
    return result;
  });
}

/* -------------------------------------------------------------------------- */
/* Device Undo (WT-20a/b): by the original's opId, compare-and-revert           */
/* -------------------------------------------------------------------------- */

export type ShoppingUndoResult =
  | { status: 'undone' }
  /** Undone before, or the action changed nothing (a no-op): nothing to take back. */
  | { status: 'already' }
  /** The action never arrived: a tombstone now holds its opId, so it is refused if it comes later. */
  | { status: 'not_applied' };

export type ShoppingUndoContext = OperationContext & { authority: DeviceAuthority };

/**
 * The device ledger's verdict, as chores and maintenance: already undone; never applied (a
 * tombstone); applied: the original person (`original-actor`), this tablet at the same
 * credential generation, inside the window (with the queued-Undo allowance of R1). A no-op
 * action's Undo answers `already` and touches nothing.
 */
const deviceUndoPlan = async (tx: FirebaseFirestore.Transaction, ctx: ShoppingUndoContext): Promise<ShoppingUndoResult | DeviceOp> => {
  const authority = ctx.authority;
  if (!ctx.hooks || !authority?.actor) throw new DeviceActionError('invalid_input');
  const plan = await ctx.hooks.precheck(tx);
  if (plan.undo === 'already') return { status: 'already' };
  if (plan.undo !== 'applied' || !plan.original) {
    ctx.hooks.finalize(tx, { targetPath: '', summary: {}, undo: 'tombstone' });
    return { status: 'not_applied' };
  }
  const original = plan.original;
  assertActorRule(authority, original.actorUid);
  if (original.summary.noop === true) return { status: 'already' };
  assertUndoable(original, {
    generation: authority.generation, actorUid: authority.actor!.uid, now: authority.now, actorRuleAllows: false,
    queuedUndo: authority.queued, queuedUndoCreatedAt: authority.queuedCreatedAt,
  });
  return original;
};

const isOp = (value: ShoppingUndoResult | DeviceOp): value is DeviceOp => 'capability' in value;

/** The list a ledger entry of `shopping.add` points at (`households/h/shopping-lists/<id>`). */
const listOfEntry = (db: Firestore, householdId: string, entry: DeviceOp): DocumentReference => {
  const prefix = `households/${householdId}/shopping-lists/`;
  const id = entry.targetPath?.startsWith(prefix) ? entry.targetPath.slice(prefix.length) : '';
  if (!isDocId(id)) throw new DeviceActionError('not_undoable');
  return listRefOf(db, householdId, id);
};

/** The item a ledger entry of `shopping.tick` points at. */
const itemOfEntry = (db: Firestore, householdId: string, entry: DeviceOp): DocumentReference => {
  const prefix = `households/${householdId}/shopping-lists/`;
  const rest = entry.targetPath?.startsWith(prefix) ? entry.targetPath.slice(prefix.length).split('/') : [];
  if (rest.length !== 3 || rest[1] !== 'items' || !isDocId(rest[0]) || !isDocId(rest[2])) throw new DeviceActionError('not_undoable');
  return listRefOf(db, householdId, rest[0]).collection('items').doc(rest[2]);
};

/** A new item this tablet's add created, untouched since (no tick, edit or re-create by anyone). */
const createdByThisAdd = (snapshot: DocumentSnapshot, ctx: ShoppingUndoContext): boolean =>
  createdRecordUnchanged(snapshot)
  && snapshot.get('addedByUid') === ctx.authority.actor!.uid
  && snapshot.get('deviceAttribution.deviceId') === ctx.authority.deviceId;

/**
 * The Undo of a tablet's add (`shopping.add.undo`): every item it created is deleted while
 * it is still unchanged since (`createdRecordUnchanged`: no tick, edit or category change by
 * anyone), and every needed item it merged into goes back to its earlier quantity while it is
 * still needed at exactly the quantity this add left. Anything changed since (by a phone,
 * another tablet or this one) is `changed_since` and nothing is written: Undo never
 * overwrites a later change (WT-20b).
 */
export async function undoShoppingAddAs(db: Firestore, householdId: string, ctx: ShoppingUndoContext): Promise<ShoppingUndoResult> {
  return db.runTransaction(async (tx): Promise<ShoppingUndoResult> => {
    const planned = await deviceUndoPlan(tx, ctx);
    if (!isOp(planned)) return planned;
    const listRef = listOfEntry(db, householdId, planned);
    const stored = (planned.summary.result ?? {}) as { status?: unknown; items?: unknown };
    if (stored.status !== 'added' || !Array.isArray(stored.items)) throw new DeviceActionError('not_undoable');
    const added = stored.items as AddedItem[];
    const refs = added.map((entry) => listRef.collection('items').doc(idOf(entry.itemId)));
    // The add's ledger entry was created in the add's own transaction, so its creation time is
    // the commit time of every item the add merged into: an item whose last write is still
    // that one was changed by nobody since (no rename, no quantity there and back, no delete
    // and restore under the same id).
    const ledger = await tx.get(opRef(householdRefOf(db, householdId), ctx.authority.deviceId, ctx.opId!));
    const addedAt = ledger.exists ? ledger.createTime : undefined;
    const snapshots = refs.length > 0 ? await tx.getAll(...refs) : [];
    const unchanged = added.every((entry, index) => {
      const snapshot = snapshots[index];
      if (!snapshot?.exists) return false;
      if (entry.created) return createdByThisAdd(snapshot, ctx);
      return Boolean(addedAt && snapshot.updateTime?.isEqual(addedAt))
        && snapshot.get('status') === 'needed' && snapshot.get('quantity') === entry.after;
    });
    if (!unchanged) throw new DeviceActionError('changed_since');
    added.forEach((entry, index) => {
      if (entry.created) tx.delete(refs[index]);
      else tx.update(refs[index], { quantity: entry.before });
    });
    const result: ShoppingUndoResult = { status: 'undone' };
    ctx.hooks!.finalize(tx, { targetPath: listRef.path, summary: { result }, undo: 'reversed' });
    return result;
  });
}

/**
 * The Undo of a tablet's tick (`shopping.tick.undo`): back to needed with the fields of
 * `undoTickUpdate` (`undoOpId` = the tick's opId, buyer and time cleared) and the purchase
 * attribution removed, only while the item is still purchased under this tick's
 * `purchaseOpId` by the same person. A newer tick or un-tick by anyone, or a removed item, is
 * `changed_since` and nothing is written.
 */
export async function undoShoppingTickAs(db: Firestore, householdId: string, ctx: ShoppingUndoContext): Promise<ShoppingUndoResult> {
  return db.runTransaction(async (tx): Promise<ShoppingUndoResult> => {
    const planned = await deviceUndoPlan(tx, ctx);
    if (!isOp(planned)) return planned;
    const itemRef = itemOfEntry(db, householdId, planned);
    const item = await tx.get(itemRef);
    const opId = ctx.opId!;
    const stillThisTick = item.exists
      && item.get('status') === 'purchased'
      && item.get('purchaseOpId') === opId
      && item.get('purchasedByUid') === ctx.authority.actor!.uid;
    if (!stillThisTick) throw new DeviceActionError('changed_since');
    tx.update(itemRef, {
      status: 'needed',
      undoOpId: opId,
      purchasedByUid: null,
      purchasedAt: null,
      purchaseDeviceAttribution: FieldValue.delete(),
    });
    const result: ShoppingUndoResult = { status: 'undone' };
    ctx.hooks!.finalize(tx, { targetPath: itemRef.path, summary: { result }, undo: 'reversed', targetName: typeof item.get('name') === 'string' ? item.get('name') as string : null });
    return result;
  });
}
