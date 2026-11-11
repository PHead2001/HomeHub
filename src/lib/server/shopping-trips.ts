import 'server-only';

import { FieldValue, Timestamp, type DocumentSnapshot, type Firestore } from 'firebase-admin/firestore';
import { slugify } from '@/lib/utils';
import { safeTimeZone } from '../../../functions/src/shared/calendar';
import { usualId } from '@/lib/shopping/usual-id';
import { pantryBatchFields, planLegacyUpgrade, readPantryBatch } from '@/lib/shopping/pantry-batches';
import {
  MAX_TRIP_DOCUMENT_BYTES,
  MAX_TRIP_WRITES,
  chunked,
  decideTripItems,
  firestoreDocumentBytes,
  largestFittingCount,
  planPantryReversal,
  planTripPantry,
  purchasesCreditedBy,
  tripPlanWrites,
  tripTargetStillValid,
  tripUndoOpen,
  usualAfterTrip,
  usualWithoutTrip,
  type PantryEffect,
  type SkipReason,
  type TripInput,
  type TripMode,
  type TripPantryPlan,
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
  /** Items left exactly as they were because the trip was full (writes or size), for another trip. */
  deferred: Array<{ itemId: string; name: string }>;
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
  /** The purchase this record is (the item's `purchaseOpId` when the trip applied it). */
  purchaseOpId: string | null;
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
    deferred: (Array.isArray(data.deferred) ? data.deferred : []) as TripSummary['deferred'],
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
 * 2. Reads the list, every chosen item and the earlier trips (not undone) that
 *    credited any of those purchases (`creditedPurchaseOpIds`), and keeps only
 *    the items that are still exactly the purchase the member confirmed
 *    (`decideTripItems`); items gone, un-ticked, renamed, re-counted or bought
 *    again stay as they are. A purchase already in the pantry (its credit
 *    stamp, or an earlier trip that credited its purchase id, which survives a
 *    delete and its Undo) is cleared but never credited or counted again.
 * 3. Re-reads each planned pantry merge target (planned from a read made just
 *    before the transaction) and the usuals.
 * 4. Takes the longest run of those items, in the order sent, whose writes fit
 *    `MAX_TRIP_WRITES` and whose trip document fits `MAX_TRIP_DOCUMENT_BYTES`
 *    (Firestore's storage size in UTF-8 bytes, `firestoreDocumentBytes`); the
 *    others are left exactly as they are and reported as `deferred`, for
 *    another trip.
 * 5. Writes: the pantry credit (Pantry v2 batches, split at 10,000 packages per
 *    batch), then for `putAwayAndClear` deletes exactly the applied items, for
 *    `putAway` stamps the credited ones with `pantryCreditedAt`/`creditTripId`
 *    (server-only fields), updates the usuals (Grocery lists only), and creates
 *    one trip document with item snapshots, the purchase ids it credited and the
 *    pantry effects for Undo.
 *
 * Concurrent shoppers serialize on the items: the second transaction finds them
 * deleted or credited and applies nothing (no trip document is written when
 * nothing applies, so history has no empty duplicates).
 */
export async function applyTrip(
  db: Firestore,
  { householdId, uid, input, nowMs }: { householdId: string; uid: string; input: TripInput; nowMs: number },
): Promise<TripSummary> {
  const house = householdRef(db, householdId);
  const listRef = house.collection('shopping-lists').doc(input.listId);
  const trips = house.collection('trips');
  const tripRef = trips.doc(input.tripId);
  const pantry = house.collection('pantry-inventory');
  const itemRef = (id: string) => listRef.collection('items').doc(id);
  // Merge candidates; each target is re-read and re-checked inside the transaction.
  const existing = (await pantry.get()).docs.map((snapshot) => ({ id: snapshot.id, data: snapshot.data() }));
  const stamp = () => ({ updatedByUid: uid, updatedAt: FieldValue.serverTimestamp() });
  const purchaseIds = [...new Set(input.items.flatMap((choice) => (choice.seen.purchaseOpId ? [choice.seen.purchaseOpId] : [])))];

  return db.runTransaction(async (transaction) => {
    // --- Reads (all before any write; recomputed on every retry) ---
    const trip = await transaction.get(tripRef);
    if (trip.exists) return summaryOf(input.tripId, trip.data() ?? {}, true);
    // Expiry days are household days (D-6): a legacy ISO expiry is read in the household's zone.
    const timeZone = safeTimeZone((await transaction.get(house)).get('timeZone'));
    const list = await transaction.get(listRef);
    if (!list.exists) throw new TripRefused('list_missing');
    const listData = list.data() ?? {};
    const itemSnapshots = await transaction.getAll(...input.items.map((choice) => itemRef(choice.itemId)));
    const read = new Map(itemSnapshots.map((snapshot, index) => [input.items[index].itemId, snapshot.exists ? snapshot.data() : undefined]));
    const earlier: Array<Record<string, unknown>> = [];
    for (const group of chunked(purchaseIds)) {
      const found = await transaction.get(trips.where('creditedPurchaseOpIds', 'array-contains-any', group));
      earlier.push(...found.docs.map((snapshot) => snapshot.data()));
    }
    const decision = decideTripItems(input.items, read, purchasesCreditedBy(earlier, purchaseIds));
    // "Put away" keeps the items on the list: only the ones it credits are part of it.
    const eligible = input.mode === 'putAwayAndClear' ? decision.apply : decision.apply.filter((entry) => entry.credit);
    const nothing: TripSummary = {
      tripId: input.tripId, listId: input.listId, mode: input.mode, applied: false, alreadyApplied: false, credited: 0, cleared: [], skipped: decision.skipped, deferred: [],
    };
    if (eligible.length === 0) return nothing;
    type Entry = (typeof eligible)[number];

    const creditsOf = (entries: readonly Entry[]) => entries.filter((entry) => entry.credit).map((entry) => ({
      name: String(entry.data.name),
      quantity: Number(entry.data.quantity),
      location: entry.choice.location!,
      expiryDate: entry.choice.expiryDate,
    }));
    // Every target any run of the items can plan (a plan's target depends only on its merge key).
    const allPlans = planTripPantry(creditsOf(eligible), existing, timeZone);
    const targetIds = [...new Set(allPlans.flatMap((plan) => (plan.targetId ? [plan.targetId] : [])))];
    const targets = targetIds.length > 0 ? await transaction.getAll(...targetIds.map((id) => pantry.doc(id))) : [];
    const targetById = new Map(targets.map((snapshot) => [snapshot.id, snapshot]));

    // Usuals (Grocery lists): one per name bought; a purchase an earlier trip already counted is not counted again.
    const usualOf = (entry: Entry) => (listData.type === 'Grocery' && !entry.alreadyCredited ? usualId(String(entry.data.name)) : null);
    const allUsualIds = [...new Set(eligible.flatMap((entry) => {
      const id = usualOf(entry);
      return id ? [id] : [];
    }))];
    const usualSnapshots = allUsualIds.length > 0 ? await transaction.getAll(...allUsualIds.map((id) => house.collection('shopping-usuals').doc(id))) : [];
    const usualById = new Map(usualSnapshots.map((snapshot) => [snapshot.id, snapshot]));

    // --- Plan every write of a run of the items from those reads ---
    const clear = input.mode === 'putAwayAndClear';
    const build = (entries: readonly Entry[]) => {
      const writes: Array<() => void> = [];
      const effects: PantryEffect[] = [];
      const createBatch = (plan: TripPantryPlan, packages: number) => {
        const ref = pantry.doc(slugify(plan.name));
        effects.push({ pantryId: ref.id, kind: 'create', packages, name: plan.name, location: plan.location, expiryDate: plan.expiryDate });
        writes.push(() => transaction.set(ref, {
          ...pantryBatchFields({ name: plan.name, location: plan.location, unit: 'items', packages, packageSize: null, expiryDate: plan.expiryDate }),
          addedByUid: uid,
          ...stamp(),
        }));
      };
      for (const plan of planTripPantry(creditsOf(entries), existing, timeZone)) {
        const snapshot = plan.targetId ? targetById.get(plan.targetId) : undefined;
        const data = snapshot?.exists ? snapshot.data() : undefined;
        const valid = Boolean(snapshot && tripTargetStillValid(data, plan, timeZone));
        const batch = valid ? readPantryBatch(snapshot!.id, data, timeZone) : null;
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

      const records: TripItemRecord[] = entries.map(({ choice, data, credit }) => ({
        itemId: choice.itemId,
        name: String(data.name),
        quantity: Number(data.quantity),
        category: typeof data.category === 'string' ? data.category : 'Other',
        purchaseOpId: choice.seen.purchaseOpId,
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
      const usuals = new Map<string, { name: string; category: string }>();
      for (const entry of entries) {
        const id = usualOf(entry);
        if (id && !usuals.has(id)) {
          usuals.set(id, {
            name: String(entry.data.name),
            category: typeof entry.data.category === 'string' && entry.data.category ? entry.data.category : 'Other',
          });
        }
      }
      for (const [id, bought] of usuals) {
        const snapshot = usualById.get(id)!;
        const fields = usualAfterTrip(snapshot.exists ? snapshot.data() : undefined, { ...bought, tripId: input.tripId, atMs: nowMs });
        writes.push(() => transaction.set(snapshot.ref, usualWrite(fields), { merge: true }));
      }
      const creditedPurchaseOpIds = [...new Set(records.flatMap((record) => (record.credited && record.purchaseOpId ? [record.purchaseOpId] : [])))];
      return { writes, effects, records, usualIds: [...usuals.keys()], creditedPurchaseOpIds };
    };
    // The trip document for the first `count` items (the rest are deferred).
    const tripOf = (count: number) => {
      const plan = build(eligible.slice(0, count));
      const deferred = eligible.slice(count).map(({ choice, data }) => ({ itemId: choice.itemId, name: String(data.name) }));
      const document = {
        listId: input.listId,
        listName: typeof listData.name === 'string' ? listData.name : '',
        listType: typeof listData.type === 'string' ? listData.type : null,
        mode: input.mode,
        appliedAt: FieldValue.serverTimestamp(),
        appliedByUid: uid,
        items: plan.records,
        creditedPurchaseOpIds: plan.creditedPurchaseOpIds,
        pantryEffects: plan.effects,
        skipped: decision.skipped,
        deferred,
        usualIds: plan.usualIds,
        undoneAt: null,
        undoneByUid: null,
      };
      return { plan, document };
    };
    // Monotone in `count`: each item adds writes, and its record is larger than its deferred entry.
    const fits = (count: number) => {
      const { plan, document } = tripOf(count);
      return plan.writes.length + 1 <= MAX_TRIP_WRITES && firestoreDocumentBytes(tripRef.path, document) <= MAX_TRIP_DOCUMENT_BYTES;
    };
    const count = largestFittingCount(eligible.length, fits);
    // Thrown before any write is applied: the transaction commits nothing.
    if (count === 0) throw new TripRefused('too_large');
    const { plan: { writes, records }, document } = tripOf(count);
    const { deferred } = document;

    // --- Writes ---
    for (const write of writes) write();
    transaction.create(tripRef, document);
    return summaryOf(input.tripId, { listId: input.listId, mode: input.mode, items: records, skipped: decision.skipped, deferred }, false);
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
    const timeZone = safeTimeZone((await transaction.get(house)).get('timeZone'));

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
      const reversal = planPantryReversal(effect, current, untouched, timeZone);
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
      const batch = readPantryBatch(snapshot.id, current, timeZone);
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
