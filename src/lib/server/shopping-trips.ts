import 'server-only';

import { FieldValue, Timestamp, type DocumentReference, type DocumentSnapshot, type Firestore } from 'firebase-admin/firestore';
import { slugify } from '@/lib/utils';
import { pantryBatchFields, planLegacyUpgrade, readPantryBatch } from '@/lib/shopping/pantry-batches';
import {
  MAX_TRIP_WRITES,
  decideTripItems,
  planPantryReversal,
  planTripPantry,
  tripPlanWrites,
  tripTargetStillValid,
  tripUndoOpen,
  usualAfterTrip,
  usualId,
  usualWithoutTrip,
  type PantryEffect,
  type SkipReason,
  type TripInput,
  type TripMode,
  type UsualFields,
} from '@/lib/shopping/trip-plan';

/** Why the server refused a trip or its Undo (the action maps each to a message). */
export type TripRefusalCode = 'list_missing' | 'too_large' | 'not_found' | 'not_latest' | 'expired';

export class TripRefused extends Error {
  constructor(readonly code: TripRefusalCode) {
    super(code);
    this.name = 'TripRefused';
  }
}

export type TripSummary = {
  tripId: string;
  listId: string;
  mode: TripMode;
  /** True when a trip document was written (now or by an earlier attempt with the same id). */
  applied: boolean;
  /** True when an earlier attempt with this id had already applied it (a retry or an interrupted response). */
  alreadyApplied: boolean;
  /** Shopping items whose purchase was credited to the pantry. */
  credited: number;
  /** Shopping item ids deleted from the list. */
  cleared: string[];
  /** Items left exactly as they were, with why. */
  skipped: Array<{ itemId: string; name: string; reason: SkipReason }>;
};

export type TripUndoSummary = {
  tripId: string;
  alreadyUndone: boolean;
  /** Cleared items put back on the list (only those still absent). */
  restored: number;
  /** Pantry documents whose credit was taken back (`clamped` ones had already been partly used). */
  reversed: number;
  clamped: number;
  /** Names of pantry batches left alone because someone changed or removed them since. */
  kept: string[];
};

type TripItemRecord = {
  itemId: string;
  name: string;
  quantity: number;
  category: string;
  location: string | null;
  expiryDate: string | null;
  credited: boolean;
  cleared: boolean;
  /** The cleared item as it was, to put back if Undo finds it absent. */
  data: Record<string, unknown> | null;
};

const householdRef = (db: Firestore, householdId: string) => db.collection('households').doc(householdId);

const summaryOf = (tripId: string, data: Record<string, unknown>, alreadyApplied: boolean): TripSummary => {
  const items = (Array.isArray(data.items) ? data.items : []) as TripItemRecord[];
  return {
    tripId,
    listId: String(data.listId ?? ''),
    mode: data.mode === 'putAway' ? 'putAway' : 'putAwayAndClear',
    applied: true,
    alreadyApplied,
    credited: items.filter((item) => item.credited).length,
    cleared: items.filter((item) => item.cleared).map((item) => item.itemId),
    skipped: (Array.isArray(data.skipped) ? data.skipped : []) as TripSummary['skipped'],
  };
};

const usualWrite = (fields: UsualFields) => ({
  name: fields.name,
  nameKey: fields.nameKey,
  category: fields.category,
  count: fields.count,
  recent: fields.recent,
  lastBoughtAt: fields.lastBoughtAtMs === null ? null : Timestamp.fromMillis(fields.lastBoughtAtMs),
  cadenceDays: fields.cadenceDays,
  updatedAt: FieldValue.serverTimestamp(),
});

/**
 * Applies one trip (S5: SH-2b/c, SH-32a) in a single Admin SDK transaction,
 * idempotent by `input.tripId`:
 *
 * 1. Reads `trips/{tripId}` first: if it exists, an earlier attempt applied this
 *    trip (a retry, or a response lost on the way back), so nothing is done
 *    twice and its summary is returned.
 * 2. Reads the list and every chosen item, and keeps only the items that are
 *    still exactly the purchase the member confirmed (`decideTripItems`); items
 *    gone, un-ticked, renamed, re-counted or bought again stay as they are.
 * 3. Re-reads each planned pantry merge target (planned from a read made just
 *    before the transaction) and the usuals.
 * 4. Writes: the pantry credit (Pantry v2 batches, split at 10,000 packages per
 *    batch), then for `putAwayAndClear` deletes exactly the applied items, for
 *    `putAway` stamps the credited ones with `pantryCreditedAt`/`creditTripId`
 *    (server-only fields), updates the usuals (Grocery lists only), and creates
 *    one trip document with item snapshots and the pantry effects for Undo.
 *
 * Concurrent shoppers serialize on the items: the second transaction finds them
 * deleted or credited and applies nothing (no trip document is written when
 * nothing applies, so history has no empty duplicates). A trip above
 * `MAX_TRIP_WRITES` writes is refused before anything is written.
 */
export async function applyTrip(
  db: Firestore,
  { householdId, uid, input, nowMs }: { householdId: string; uid: string; input: TripInput; nowMs: number },
): Promise<TripSummary> {
  const house = householdRef(db, householdId);
  const listRef = house.collection('shopping-lists').doc(input.listId);
  const tripRef = house.collection('trips').doc(input.tripId);
  const pantry = house.collection('pantry-inventory');
  const itemRef = (id: string) => listRef.collection('items').doc(id);
  // Merge candidates; each target is re-read and re-checked inside the transaction.
  const existing = (await pantry.get()).docs.map((snapshot) => ({ id: snapshot.id, data: snapshot.data() }));
  const stamp = () => ({ updatedByUid: uid, updatedAt: FieldValue.serverTimestamp() });

  return db.runTransaction(async (transaction) => {
    // --- Reads (all before any write; recomputed on every retry) ---
    const trip = await transaction.get(tripRef);
    if (trip.exists) return summaryOf(input.tripId, trip.data() ?? {}, true);
    const list = await transaction.get(listRef);
    if (!list.exists) throw new TripRefused('list_missing');
    const listData = list.data() ?? {};
    const itemSnapshots = await transaction.getAll(...input.items.map((choice) => itemRef(choice.itemId)));
    const read = new Map(itemSnapshots.map((snapshot, index) => [input.items[index].itemId, snapshot.exists ? snapshot.data() : undefined]));
    const decision = decideTripItems(input.items, read);
    // "Put away" keeps the items on the list: only the ones it credits are part of it.
    const applied = input.mode === 'putAwayAndClear' ? decision.apply : decision.apply.filter((entry) => entry.credit);
    const nothing: TripSummary = {
      tripId: input.tripId, listId: input.listId, mode: input.mode, applied: false, alreadyApplied: false, credited: 0, cleared: [], skipped: decision.skipped,
    };
    if (applied.length === 0) return nothing;

    const credits = applied.filter((entry) => entry.credit).map((entry) => ({
      name: String(entry.data.name),
      quantity: Number(entry.data.quantity),
      location: entry.choice.location!,
      expiryDate: entry.choice.expiryDate,
    }));
    const plans = planTripPantry(credits, existing);
    const targetPlans = plans.filter((plan) => plan.targetId !== null);
    const targets = targetPlans.length > 0 ? await transaction.getAll(...targetPlans.map((plan) => pantry.doc(plan.targetId!))) : [];
    const targetById = new Map(targets.map((snapshot) => [snapshot.id, snapshot]));

    const usualRefs = new Map<string, { ref: DocumentReference; name: string; category: string }>();
    if (listData.type === 'Grocery') {
      for (const entry of applied) {
        const id = usualId(String(entry.data.name));
        if (id && !usualRefs.has(id)) {
          usualRefs.set(id, {
            ref: house.collection('shopping-usuals').doc(id),
            name: String(entry.data.name),
            category: typeof entry.data.category === 'string' && entry.data.category ? entry.data.category : 'Other',
          });
        }
      }
    }
    const usualEntries = [...usualRefs.values()];
    const usualSnapshots = usualEntries.length > 0 ? await transaction.getAll(...usualEntries.map((entry) => entry.ref)) : [];

    // --- Plan every write from those reads ---
    const writes: Array<() => void> = [];
    const effects: PantryEffect[] = [];
    const createBatch = (plan: (typeof plans)[number], packages: number) => {
      const ref = pantry.doc(slugify(plan.name));
      effects.push({ pantryId: ref.id, kind: 'create', packages, name: plan.name, location: plan.location, expiryDate: plan.expiryDate });
      writes.push(() => transaction.set(ref, {
        ...pantryBatchFields({ name: plan.name, location: plan.location, unit: 'items', packages, packageSize: null, expiryDate: plan.expiryDate }),
        addedByUid: uid,
        ...stamp(),
      }));
    };
    for (const plan of plans) {
      const snapshot = plan.targetId ? targetById.get(plan.targetId) : undefined;
      const data = snapshot?.exists ? snapshot.data() : undefined;
      const valid = Boolean(snapshot && tripTargetStillValid(data, plan));
      const batch = valid ? readPantryBatch(snapshot!.id, data) : null;
      const { toTarget, newBatches } = tripPlanWrites(plan, batch);
      if (batch && toTarget > 0) {
        const ref = snapshot!.ref;
        effects.push({ pantryId: ref.id, kind: batch.legacy ? 'upgrade' : 'increment', packages: toTarget, name: plan.name, location: plan.location, expiryDate: plan.expiryDate });
        writes.push(() => transaction.update(ref, batch.legacy
          ? { ...planLegacyUpgrade(batch, toTarget).fields, ...stamp() }
          : { packages: FieldValue.increment(toTarget), quantity: FieldValue.increment(toTarget), ...stamp() }));
      }
      for (const packages of newBatches) createBatch(plan, packages);
    }

    const clear = input.mode === 'putAwayAndClear';
    const records: TripItemRecord[] = applied.map(({ choice, data, credit }) => ({
      itemId: choice.itemId,
      name: String(data.name),
      quantity: Number(data.quantity),
      category: typeof data.category === 'string' ? data.category : 'Other',
      location: credit ? choice.location : null,
      expiryDate: credit ? choice.expiryDate : null,
      credited: credit,
      cleared: clear,
      data: clear ? data : null,
    }));
    for (const record of records) {
      if (record.cleared) writes.push(() => transaction.delete(itemRef(record.itemId)));
      else if (record.credited) {
        writes.push(() => transaction.update(itemRef(record.itemId), {
          pantryCreditedAt: FieldValue.serverTimestamp(),
          creditTripId: input.tripId,
        }));
      }
    }
    usualEntries.forEach((entry, index) => {
      const previous = usualSnapshots[index].exists ? usualSnapshots[index].data() : undefined;
      const fields = usualAfterTrip(previous, { name: entry.name, category: entry.category, tripId: input.tripId, atMs: nowMs });
      writes.push(() => transaction.set(entry.ref, usualWrite(fields), { merge: true }));
    });
    // Thrown before any write is applied: the transaction commits nothing.
    if (writes.length + 1 > MAX_TRIP_WRITES) throw new TripRefused('too_large');

    // --- Writes ---
    for (const write of writes) write();
    transaction.create(tripRef, {
      listId: input.listId,
      listName: typeof listData.name === 'string' ? listData.name : '',
      listType: typeof listData.type === 'string' ? listData.type : null,
      mode: input.mode,
      appliedAt: FieldValue.serverTimestamp(),
      appliedByUid: uid,
      items: records,
      pantryEffects: effects,
      skipped: decision.skipped,
      usualIds: [...usualRefs.keys()],
      undoneAt: null,
      undoneByUid: null,
    });
    return summaryOf(input.tripId, { listId: input.listId, mode: input.mode, items: records, skipped: decision.skipped }, false);
  });
}

const readEffects = (value: unknown): PantryEffect[] => (Array.isArray(value) ? value : [])
  .filter((effect): effect is PantryEffect => Boolean(effect) && typeof effect.pantryId === 'string' && typeof effect.packages === 'number');

const sameTime = (a: unknown, b: unknown) => a instanceof Timestamp && b instanceof Timestamp && a.isEqual(b);

/**
 * Undoes a trip (SH-2d, SH-17c) in one Admin SDK transaction: only the
 * household's latest trip, only within `TRIP_UNDO_WINDOW_MS` of when it was
 * applied (server clock), and only once (`undoneAt`; a repeat reports
 * `alreadyUndone`). It never writes back a stale copy:
 *
 * - each pantry effect is reversed on the batch as just read: what the trip
 *   added is subtracted, never below zero; a batch someone renamed, moved or
 *   re-dated since (a newer edit) or removed is left alone and named in `kept`;
 *   a batch the trip created that nobody touched since is deleted when empty;
 * - a cleared item is put back as it was only if it is absent (and its list
 *   still exists), so an item someone re-added or restored is not overwritten;
 * - a credit stamp is removed only while the item still carries this trip's
 *   `creditTripId`;
 * - the usuals drop this trip.
 */
export async function undoTripOnServer(
  db: Firestore,
  { householdId, uid, tripId, nowMs }: { householdId: string; uid: string; tripId: string; nowMs: number },
): Promise<TripUndoSummary> {
  const house = householdRef(db, householdId);
  const trips = house.collection('trips');
  const tripRef = trips.doc(tripId);
  const pantry = house.collection('pantry-inventory');

  return db.runTransaction(async (transaction) => {
    const trip = await transaction.get(tripRef);
    if (!trip.exists) throw new TripRefused('not_found');
    const data = trip.data() ?? {};
    if (data.undoneAt) return { tripId, alreadyUndone: true, restored: 0, reversed: 0, clamped: 0, kept: [] };
    const latest = await transaction.get(trips.orderBy('appliedAt', 'desc').limit(1));
    if (latest.docs[0]?.id !== tripId) throw new TripRefused('not_latest');
    const appliedAt = data.appliedAt instanceof Timestamp ? data.appliedAt : null;
    if (!tripUndoOpen(appliedAt?.toMillis() ?? null, nowMs)) throw new TripRefused('expired');

    const listRef = house.collection('shopping-lists').doc(String(data.listId));
    const items = (Array.isArray(data.items) ? data.items : []) as TripItemRecord[];
    const effects = readEffects(data.pantryEffects);
    const usualIds = (Array.isArray(data.usualIds) ? data.usualIds : []).filter((id): id is string => typeof id === 'string');
    const list = await transaction.get(listRef);
    const pantrySnapshots = effects.length > 0 ? await transaction.getAll(...effects.map((effect) => pantry.doc(effect.pantryId))) : [];
    const itemSnapshots: DocumentSnapshot[] = items.length > 0
      ? await transaction.getAll(...items.map((item) => listRef.collection('items').doc(item.itemId)))
      : [];
    const usualSnapshots = usualIds.length > 0 ? await transaction.getAll(...usualIds.map((id) => house.collection('shopping-usuals').doc(id))) : [];

    const summary: TripUndoSummary = { tripId, alreadyUndone: false, restored: 0, reversed: 0, clamped: 0, kept: [] };
    const stamp = { updatedByUid: uid, updatedAt: FieldValue.serverTimestamp() };
    effects.forEach((effect, index) => {
      const snapshot = pantrySnapshots[index];
      const current = snapshot.exists ? snapshot.data() : undefined;
      const untouched = Boolean(current) && sameTime(current!.updatedAt, appliedAt) && current!.updatedByUid === data.appliedByUid;
      const reversal = planPantryReversal(effect, current, untouched);
      if (reversal.kind === 'skip') {
        summary.kept.push(effect.name);
        return;
      }
      summary.reversed += 1;
      if (reversal.kind === 'delete') {
        transaction.delete(snapshot.ref);
        return;
      }
      if (reversal.clamped) summary.clamped += 1;
      const batch = readPantryBatch(snapshot.id, current);
      transaction.update(snapshot.ref, {
        packages: reversal.packages,
        quantity: reversal.packages,
        schemaVersion: 2,
        ...(current?.nameKey === undefined ? { nameKey: batch.nameKey } : {}),
        ...stamp,
      });
    });
    items.forEach((item, index) => {
      const snapshot = itemSnapshots[index];
      if (item.cleared) {
        if (!snapshot.exists && list.exists && item.data) {
          transaction.set(snapshot.ref, item.data);
          summary.restored += 1;
        }
      } else if (item.credited && snapshot.exists && snapshot.get('creditTripId') === tripId) {
        transaction.update(snapshot.ref, { pantryCreditedAt: FieldValue.delete(), creditTripId: FieldValue.delete() });
      }
    });
    usualSnapshots.forEach((snapshot) => {
      const reversal = usualWithoutTrip(snapshot.exists ? snapshot.data() : undefined, tripId);
      if (reversal.action === 'delete') transaction.delete(snapshot.ref);
      else if (reversal.action === 'set') transaction.set(snapshot.ref, usualWrite(reversal.fields), { merge: true });
    });
    transaction.update(tripRef, {
      undoneAt: FieldValue.serverTimestamp(),
      undoneByUid: uid,
      undo: { restored: summary.restored, reversed: summary.reversed, clamped: summary.clamped, kept: summary.kept },
    });
    return summary;
  });
}
