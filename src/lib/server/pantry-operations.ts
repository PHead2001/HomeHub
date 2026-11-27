import 'server-only';

import { Timestamp, type DocumentReference, type DocumentSnapshot, type Firestore } from 'firebase-admin/firestore';
import { isDocId } from '@functions/shared/push-media';
import { slugify } from '@/lib/utils';
import { normalizeGtin } from '@/lib/barcode/gtin';
import { planRestock, planUsedUp } from '@/lib/barcode/pantry-by-barcode';
import { clampPantryName, isCountUnit, pantryBatchFields, readPantryBatch, type PantryBatch } from '@/lib/shopping/pantry-batches';
import type { OperationContext } from '@/lib/server/operation-context';
import { assertActorRule, type DeviceAuthority } from '@/lib/server/device-gate';
import { DeviceActionError } from '@/lib/server/device-errors';
import { assertUndoable, createdRecordUnchanged, opRef, type DeviceOp } from '@/lib/server/device-ops';

// Pantry stock from a wall tablet's scan (docs/modules/devices/README.md, "Device actions:
// pantry"; audit BL-20, BL-21, 17.3, D-8). The personal scan station writes the pantry with
// the client SDK under the rules (src/lib/barcode/product-stock.ts); a tablet has no client
// write rules, so its Used up and Restock run here with the Admin SDK, one transaction each,
// in the order every `…As` operation follows (operation-context.ts): the device hooks'
// precheck first, then the reads, then the writes, the finalize last. The decisions are the
// personal path's (`planUsedUp`, `planRestock`): the product is found by barcode (either
// form), then by name; Used up takes ONE package from the soonest-expiring batch (never 1 g
// of a measured amount); Restock adds one package to the soonest batch, or creates a one-item
// batch on the Pantry shelf. At zero the tablet asks "Add to list?" (D-8): nothing is added
// here. The actor is `updatedByUid` (and `addedByUid` on a new batch); the tablet is recorded
// in the op ledger (pantry documents carry no device fields, so phones keep editing them
// under the pantry rules). A batch still in the legacy shape is left to a phone
// (`needs_phone`), as the personal page upgrades it in its own transaction.

const pantryOf = (db: Firestore, householdId: string) => db.collection('households').doc(householdId).collection('pantry-inventory');

export class PantryOperationError extends Error {
  constructor(readonly code: 'invalid') {
    super(`pantry-${code}`);
  }
}

/** The scanned product: a barcode (6 to 32 digits, normalised) and the name the tablet looked up. */
const scannedOf = (input: { barcode?: unknown; name?: unknown } | null | undefined) => {
  const normalized = normalizeGtin(input?.barcode);
  if (!normalized.ok) throw new PantryOperationError('invalid');
  const name = typeof input?.name === 'string' ? clampPantryName(input.name) : '';
  if (!name) throw new PantryOperationError('invalid');
  return { barcode: normalized.id, name };
};

export type PantryUseResult =
  | { status: 'used'; itemId: string; name: string; before: number; after: number; remaining: number; askAddToList: boolean }
  /** Nothing of this product is in the pantry (no batch with stock). */
  | { status: 'not_stocked'; name: string }
  /** The batch is in the older shape: a phone upgrades it first. */
  | { status: 'needs_phone'; name: string };

export type PantryRestockResult =
  | { status: 'restocked'; itemId: string; name: string; created: true }
  | { status: 'restocked'; itemId: string; name: string; created: false; before: number; after: number }
  | { status: 'needs_phone'; name: string };

const batchesIn = async (tx: FirebaseFirestore.Transaction, db: Firestore, householdId: string): Promise<PantryBatch[]> =>
  (await tx.get(pantryOf(db, householdId))).docs.map((doc) => readPantryBatch(doc.id, doc.data()));

/** The ledger's replay, for the same product only (an opId sent for another product is a conflict). */
const replayFor = <T,>(replay: { summary: Record<string, unknown> } | undefined, barcode: string): T | null => {
  if (!replay) return null;
  if (replay.summary.barcode !== barcode) throw new DeviceActionError('conflict');
  return replay.summary.result as T;
};

/** The writes of a new package count on a v2 batch (counted units dual-write `quantity`). */
const packagesUpdate = (batch: Pick<PantryBatch, 'unit'>, packages: number, uid: string, now: Date) => ({
  packages,
  ...(isCountUnit(batch.unit) ? { quantity: packages } : {}),
  updatedByUid: uid,
  updatedAt: Timestamp.fromDate(now),
});

/**
 * Used up (`pantry.useUp` on a tablet): one package of the scanned product, from its
 * soonest-expiring batch, for the actor. Not stocked, nothing left, or an older batch shape
 * write nothing (a no-op in the ledger).
 */
export async function takePantryItemAs(db: Firestore, householdId: string, input: { barcode?: unknown; name?: unknown }, ctx: OperationContext): Promise<PantryUseResult> {
  const scanned = scannedOf(input);
  const pantry = pantryOf(db, householdId);
  return db.runTransaction(async (tx): Promise<PantryUseResult> => {
    const { replay } = (await ctx.hooks?.precheck(tx)) ?? {};
    const replayed = replayFor<PantryUseResult>(replay, scanned.barcode);
    if (replayed) return replayed;
    const plan = planUsedUp(await batchesIn(tx, db, householdId), scanned);
    const noop = (result: PantryUseResult) => {
      ctx.hooks?.finalize(tx, { targetPath: pantry.path, summary: { result, barcode: scanned.barcode, noop: true } });
      return result;
    };
    if (plan.kind !== 'use') return noop({ status: 'not_stocked', name: plan.kind === 'nothing-left' ? plan.product.name : scanned.name });
    if (plan.batch.legacy || plan.batch.needsRepair) return noop({ status: 'needs_phone', name: plan.product.name });
    const before = plan.batch.packages;
    const after = before - 1;
    const ref = pantry.doc(plan.batch.id);
    tx.update(ref, packagesUpdate(plan.batch, after, ctx.actor.uid, ctx.now));
    const result: PantryUseResult = {
      status: 'used', itemId: plan.batch.id, name: plan.product.name, before, after, remaining: plan.remaining, askAddToList: plan.askAddToList,
    };
    ctx.hooks?.finalize(tx, { targetPath: ref.path, summary: { result, barcode: scanned.barcode }, targetName: plan.product.name });
    return result;
  });
}

/**
 * Restock (`pantry.restock` on a tablet): one more package of the scanned product's soonest
 * batch, or (nothing stocked, or that batch full) a new batch of one on the Pantry shelf with
 * the barcode and the actor as `addedByUid`.
 */
export async function restockPantryItemAs(db: Firestore, householdId: string, input: { barcode?: unknown; name?: unknown }, ctx: OperationContext): Promise<PantryRestockResult> {
  const scanned = scannedOf(input);
  const pantry = pantryOf(db, householdId);
  return db.runTransaction(async (tx): Promise<PantryRestockResult> => {
    const { replay } = (await ctx.hooks?.precheck(tx)) ?? {};
    const replayed = replayFor<PantryRestockResult>(replay, scanned.barcode);
    if (replayed) return replayed;
    const plan = planRestock(await batchesIn(tx, db, householdId), scanned);
    if (plan.kind === 'add-one' && plan.plan.kind === 'increment') {
      const batch = plan.plan.batch;
      if (batch.legacy || batch.needsRepair) {
        const result: PantryRestockResult = { status: 'needs_phone', name: plan.product.name };
        ctx.hooks?.finalize(tx, { targetPath: pantry.path, summary: { result, barcode: scanned.barcode, noop: true } });
        return result;
      }
      const ref = pantry.doc(batch.id);
      const before = batch.packages;
      const after = before + 1;
      tx.update(ref, packagesUpdate(batch, after, ctx.actor.uid, ctx.now));
      const result: PantryRestockResult = { status: 'restocked', itemId: batch.id, name: plan.product.name, created: false, before, after };
      ctx.hooks?.finalize(tx, { targetPath: ref.path, summary: { result, barcode: scanned.barcode }, targetName: plan.product.name });
      return result;
    }
    // Nothing stocked: a new batch of one; the soonest batch full (10,000): an overflow batch of one.
    const batchInput = plan.kind === 'new' ? plan.input
      : plan.plan.kind === 'create' ? { ...plan.plan.input, packages: 1, barcode: plan.plan.input.barcode ?? scanned.barcode }
        : null;
    if (!batchInput) throw new PantryOperationError('invalid');
    const fields = pantryBatchFields(batchInput);
    const ref = pantry.doc(slugify(fields.name));
    tx.create(ref, { ...fields, addedByUid: ctx.actor.uid, updatedByUid: ctx.actor.uid, updatedAt: Timestamp.fromDate(ctx.now) });
    const result: PantryRestockResult = { status: 'restocked', itemId: ref.id, name: fields.name, created: true };
    ctx.hooks?.finalize(tx, { targetPath: ref.path, summary: { result, barcode: scanned.barcode }, targetName: fields.name });
    return result;
  });
}

/* -------------------------------------------------------------------------- */
/* Device Undo (WT-20a/b): by the original's opId, compare-and-revert           */
/* -------------------------------------------------------------------------- */

export type PantryUndoResult = { status: 'undone' } | { status: 'already' } | { status: 'not_applied' };

export type PantryUndoContext = OperationContext & { authority: DeviceAuthority };

/** The ledger's verdict, as shopping: already undone; never applied (a tombstone); the original's actor, tablet, generation and window. */
const deviceUndoPlan = async (tx: FirebaseFirestore.Transaction, ctx: PantryUndoContext): Promise<PantryUndoResult | DeviceOp> => {
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

const isOp = (value: PantryUndoResult | DeviceOp): value is DeviceOp => 'capability' in value;

/** The batch a ledger entry points at (`households/h/pantry-inventory/<id>`). */
const batchOfEntry = (db: Firestore, householdId: string, entry: DeviceOp): DocumentReference => {
  const prefix = `households/${householdId}/pantry-inventory/`;
  const id = entry.targetPath?.startsWith(prefix) ? entry.targetPath.slice(prefix.length) : '';
  if (!isDocId(id)) throw new DeviceActionError('not_undoable');
  return pantryOf(db, householdId).doc(id);
};

/**
 * A batch this action changed is untouched since: its last write is the action's own (the
 * ledger entry was created in the same transaction, so their times are equal) and it still
 * holds the count the action left. A use, a restock, an edit or a delete and re-create by
 * anyone since is `changed_since`, and nothing is written (WT-20b).
 */
const untouchedSince = (snapshot: DocumentSnapshot, ledger: DocumentSnapshot, packages: number): boolean =>
  Boolean(snapshot.exists && ledger.exists && ledger.createTime && snapshot.updateTime?.isEqual(ledger.createTime))
  && snapshot.get('packages') === packages;

const undoCount = async (db: Firestore, householdId: string, ctx: PantryUndoContext, kind: 'used' | 'restocked'): Promise<PantryUndoResult> =>
  db.runTransaction(async (tx): Promise<PantryUndoResult> => {
    const planned = await deviceUndoPlan(tx, ctx);
    if (!isOp(planned)) return planned;
    const ref = batchOfEntry(db, householdId, planned);
    const stored = (planned.summary.result ?? {}) as Record<string, unknown>;
    if (stored.status !== kind) throw new DeviceActionError('not_undoable');
    const [snapshot, ledger] = await Promise.all([
      tx.get(ref),
      tx.get(opRef(db.collection('households').doc(householdId), ctx.authority.deviceId, ctx.opId!)),
    ]);
    if (stored.created === true) {
      // A batch this restock created: deleted while nobody wrote to it since.
      if (!createdRecordUnchanged(snapshot) || snapshot.get('addedByUid') !== ctx.authority.actor!.uid) throw new DeviceActionError('changed_since');
      tx.delete(ref);
    } else {
      const before = stored.before;
      const after = stored.after;
      if (typeof before !== 'number' || typeof after !== 'number') throw new DeviceActionError('not_undoable');
      if (!untouchedSince(snapshot, ledger, after)) throw new DeviceActionError('changed_since');
      tx.update(ref, packagesUpdate({ unit: snapshot.get('unit') as PantryBatch['unit'] }, before, ctx.authority.actor!.uid, ctx.now));
    }
    const result: PantryUndoResult = { status: 'undone' };
    ctx.hooks!.finalize(tx, { targetPath: ref.path, summary: { result }, undo: 'reversed', targetName: typeof stored.name === 'string' ? stored.name : null });
    return result;
  });

/** The Undo of a tablet's Used up (`pantry.useUp.undo`): the package back while the batch is untouched since. */
export const undoPantryTakeAs = (db: Firestore, householdId: string, ctx: PantryUndoContext) => undoCount(db, householdId, ctx, 'used');

/** The Undo of a tablet's Restock (`pantry.restock.undo`): the package off, or the new batch deleted, while untouched since. */
export const undoPantryRestockAs = (db: Firestore, householdId: string, ctx: PantryUndoContext) => undoCount(db, householdId, ctx, 'restocked');
