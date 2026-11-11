import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { Timestamp, type DocumentReference } from 'firebase-admin/firestore';
import { adminAuth, adminDb } from '../../src/lib/server/firebase-admin';
import { putAwayAndClear, undoTrip } from '../../src/app/shopping/actions';
import { applyTrip, undoTripOnServer } from '../../src/lib/server/shopping-trips';
import { restoreItemData } from '../../src/lib/shopping/items';
import { TRIP_UNDO_WINDOW_MS, type TripChoice, type TripMode } from '../../src/lib/shopping/trip-plan';

// S5 (SH-2, SH-17c, SH-32a): put away and clear as one trip, idempotent by its
// id, and its Undo, against the Auth and Firestore emulators.
const HOUSE = 'shopping-trips-house';
const OTHER = 'shopping-trips-other';
const house = adminDb.collection('households').doc(HOUSE);
const other = adminDb.collection('households').doc(OTHER);
const list = house.collection('shopping-lists').doc('weekly');
const items = list.collection('items');
const pantry = house.collection('pantry-inventory');
const trips = house.collection('trips');
const usuals = house.collection('shopping-usuals');

const CALLERS = {
  owner: { uid: 'trip-owner', email: 'trip.owner@example.test' },
  editor: { uid: 'trip-editor', email: 'trip.editor@example.test' },
  viewer: { uid: 'trip-viewer', email: 'trip.viewer@example.test' },
  outsider: { uid: 'trip-outsider', email: 'trip.outsider@example.test' },
} as const;
type Caller = keyof typeof CALLERS;
const tokens = new Map<Caller, string>();

async function idTokenFor(caller: Caller) {
  const { uid, email } = CALLERS[caller];
  await adminAuth.deleteUser(uid).catch(() => undefined);
  await adminAuth.createUser({ uid, email });
  const customToken = await adminAuth.createCustomToken(uid);
  const response = await fetch(`http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}/identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=fake-api-key`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: customToken, returnSecureToken: true }),
  });
  assert.ok(response.ok, `emulator sign-in for ${caller}`);
  return ((await response.json()) as { idToken: string }).idToken;
}

const bought = (name: string, quantity: number, category: string, opId = `op-${name}`) => ({
  name, quantity, category, status: 'purchased', purchaseOpId: opId, purchasedByUid: CALLERS.owner.uid, purchasedAt: Timestamp.now(), addedByUid: CALLERS.owner.uid,
});

const seed = async () => {
  await list.set({ name: 'Weekly', type: 'Grocery' });
  await items.doc('milk').set(bought('Milk', 2, 'Dairy'));
  await items.doc('rice').set(bought('Rice', 1, 'Pantry'));
};

const pick = (itemId: string, name: string, quantity: number, location: TripChoice['location'], expiryDate: string | null = null, opId = `op-${name}`): TripChoice =>
  ({ itemId, seen: { name, quantity, purchaseOpId: opId }, location, expiryDate });
const tripChoices = () => [pick('milk', 'Milk', 2, 'Fridge', '2026-11-17'), pick('rice', 'Rice', 1, 'Pantry')];

const run = (caller: Caller, tripId: string, mode: TripMode = 'putAwayAndClear', choices = tripChoices(), householdId = HOUSE) =>
  putAwayAndClear({ idToken: tokens.get(caller)!, householdId, listId: 'weekly', tripId, mode, items: choices });
const undo = (caller: Caller, tripId: string) => undoTrip({ idToken: tokens.get(caller)!, householdId: HOUSE, tripId });

const pantryRows = async () => (await pantry.orderBy('name').get()).docs.map((entry) => {
  const data = entry.data();
  return { name: data.name, location: data.location, packages: data.packages, expiryDate: data.expiryDate };
});
const exists = async (ref: DocumentReference) => (await ref.get()).exists;

before(async () => {
  for (const caller of Object.keys(CALLERS) as Caller[]) tokens.set(caller, await idTokenFor(caller));
});

beforeEach(async () => {
  await Promise.all([adminDb.recursiveDelete(house), adminDb.recursiveDelete(other)]);
  await house.set({ name: 'Trip House', ownerUid: CALLERS.owner.uid });
  await house.collection('members').doc(CALLERS.owner.uid).set({ ...CALLERS.owner, role: 'owner', status: 'active', permissions: {} });
  await house.collection('members').doc(CALLERS.editor.uid).set({
    ...CALLERS.editor, role: 'member', status: 'active', permissions: { 'shopping.view': true, 'shopping.edit': true, 'shopping.delete': false },
  });
  await house.collection('members').doc(CALLERS.viewer.uid).set({
    ...CALLERS.viewer, role: 'member', status: 'active', permissions: { 'shopping.view': true, 'shopping.edit': false, 'shopping.delete': false },
  });
  await other.set({ name: 'Other House', ownerUid: CALLERS.outsider.uid });
  await other.collection('members').doc(CALLERS.outsider.uid).set({ ...CALLERS.outsider, role: 'owner', status: 'active', permissions: {} });
  await seed();
});

after(async () => {
  await Promise.all([adminDb.recursiveDelete(house), adminDb.recursiveDelete(other)]);
  await Promise.all(Object.values(CALLERS).map(({ uid }) => adminAuth.deleteUser(uid).catch(() => undefined)));
});

describe('putAwayAndClear', () => {
  test('credits the pantry, clears the items and writes one trip; the same trip id again does nothing twice', async () => {
    const first = await run('owner', 'trip-aaaa-0001');
    assert.equal(first.ok, true);
    assert.deepEqual(first.ok && { applied: first.trip.applied, already: first.trip.alreadyApplied, credited: first.trip.credited, cleared: first.trip.cleared.sort() },
      { applied: true, already: false, credited: 2, cleared: ['milk', 'rice'] });
    assert.deepEqual(await pantryRows(), [
      { name: 'Milk', location: 'Fridge', packages: 2, expiryDate: '2026-11-17' },
      { name: 'Rice', location: 'Pantry', packages: 1, expiryDate: null },
    ]);
    assert.equal((await items.get()).size, 0);

    // A retry (or a response lost on the way back) with the same id.
    const retry = await run('owner', 'trip-aaaa-0001');
    assert.equal(retry.ok && retry.trip.alreadyApplied, true);
    assert.equal(retry.ok && retry.trip.credited, 2);
    assert.equal((await pantry.get()).size, 2);
    assert.deepEqual((await pantryRows()).map((row) => row.packages), [2, 1]);
    assert.equal((await trips.get()).size, 1);

    const trip = (await trips.doc('trip-aaaa-0001').get()).data()!;
    assert.equal(trip.listId, 'weekly');
    assert.equal(trip.listName, 'Weekly');
    assert.equal(trip.appliedByUid, CALLERS.owner.uid);
    assert.ok(trip.appliedAt instanceof Timestamp);
    assert.equal(trip.items.length, 2);
    assert.equal(trip.pantryEffects.length, 2);
    assert.equal(trip.undoneAt, null);
  });

  test('two shoppers putting the same trip away at once credit and clear once, with one trip in history', async () => {
    const [a, b] = await Promise.all([run('owner', 'trip-conc-000a'), run('owner', 'trip-conc-000b')]);
    assert.equal(a.ok && b.ok, true);
    const outcomes = [a, b].map((result) => (result.ok ? result.trip : null)!);
    assert.equal(outcomes.filter((trip) => trip.applied).length, 1);
    assert.equal(outcomes.reduce((sum, trip) => sum + trip.credited, 0), 2);
    assert.deepEqual((await pantryRows()).map((row) => row.packages), [2, 1]);
    assert.equal((await trips.get()).size, 1);
  });

  test('an item changed or added while the trip is open stays on the list and is not credited', async () => {
    // Another member raises the milk after the dialog opened, and adds bread.
    await items.doc('milk').update({ quantity: 3 });
    await items.doc('bread').set(bought('Bread', 1, 'Bakery'));
    const result = await run('owner', 'trip-chg-00001');
    assert.equal(result.ok, true);
    assert.deepEqual(result.ok && result.trip.skipped.map(({ itemId, reason }) => [itemId, reason]), [['milk', 'changed']]);
    assert.deepEqual(await pantryRows(), [{ name: 'Rice', location: 'Pantry', packages: 1, expiryDate: null }]);
    assert.equal((await items.doc('milk').get()).data()?.quantity, 3);
    assert.equal(await exists(items.doc('bread')), true);
    assert.equal(await exists(items.doc('rice')), false);
  });

  test('a re-ticked item (new purchase id) is a newer purchase and is left alone', async () => {
    await items.doc('rice').update({ purchaseOpId: 'op-retick' });
    const result = await run('owner', 'trip-tick-0001');
    assert.deepEqual(result.ok && result.trip.skipped.map(({ itemId }) => itemId), ['rice']);
    assert.equal(await exists(items.doc('rice')), true);
  });

  test('merges into a batch with the same key and splits above 10,000 packages per batch', async () => {
    await pantry.doc('milk-old').set({ name: 'Milk', nameKey: 'milk', location: 'Fridge', unit: 'items', packages: 9_999, packageSize: null, expiryDate: '2026-11-17', quantity: 9_999, schemaVersion: 2 });
    await items.doc('milk').update({ quantity: 25_000 });
    const result = await run('owner', 'trip-big-00001', 'putAwayAndClear', [pick('milk', 'Milk', 25_000, 'Fridge', '2026-11-17')]);
    assert.equal(result.ok, true);
    const milk = (await pantry.where('nameKey', '==', 'milk').get()).docs.map((entry) => entry.data().packages).sort((a, b) => a - b);
    assert.deepEqual(milk, [4_999, 10_000, 10_000, 10_000]);
    assert.equal(milk.reduce((sum, packages) => sum + packages, 0), 9_999 + 25_000);
  });

  test('a member who cannot delete may put away (stamped, not cleared) but not clear; a stamped purchase is never credited twice', async () => {
    const denied = await run('editor', 'trip-edit-0001');
    assert.equal(!denied.ok && denied.code, 'forbidden');
    assert.equal((await pantry.get()).size, 0);

    const put = await run('editor', 'trip-edit-0002', 'putAway');
    assert.equal(put.ok && put.trip.credited, 2);
    const milk = (await items.doc('milk').get()).data()!;
    assert.ok(milk.pantryCreditedAt instanceof Timestamp);
    assert.equal(milk.creditTripId, 'trip-edit-0002');
    assert.equal(milk.status, 'purchased');

    // Again with a new trip id: nothing is credited, no history is written.
    const again = await run('editor', 'trip-edit-0003', 'putAway');
    assert.equal(again.ok && again.trip.applied, false);
    assert.equal((await trips.get()).size, 1);
    // Clearing later (by a member who can delete) clears without crediting again.
    const clear = await run('owner', 'trip-edit-0004');
    assert.equal(clear.ok && clear.trip.credited, 0);
    assert.deepEqual(clear.ok && clear.trip.cleared.sort(), ['milk', 'rice']);
    assert.deepEqual((await pantryRows()).map((row) => row.packages), [2, 1]);
  });

  test('is refused for viewers, other households and malformed trips; a deleted list puts nothing away', async () => {
    const viewer = await run('viewer', 'trip-view-0001', 'putAway');
    assert.equal(!viewer.ok && viewer.code, 'forbidden');
    const outsider = await run('outsider', 'trip-out-00001', 'putAwayAndClear', tripChoices(), HOUSE);
    assert.equal(!outsider.ok && outsider.code, 'forbidden');
    const malformed = await run('owner', 'bad id', 'putAwayAndClear');
    assert.equal(!malformed.ok && malformed.code, 'invalid_input');
    const badDay = await run('owner', 'trip-day-00001', 'putAwayAndClear', [pick('milk', 'Milk', 2, 'Fridge', '2026-02-30')]);
    assert.equal(!badDay.ok && badDay.code, 'invalid_input');
    const unsigned = await putAwayAndClear({ idToken: 'nope', householdId: HOUSE, listId: 'weekly', tripId: 'trip-tok-00001', mode: 'putAway', items: tripChoices() });
    assert.equal(!unsigned.ok && unsigned.code, 'unauthenticated');
    await list.delete();
    const missing = await run('owner', 'trip-gone-0001');
    assert.equal(!missing.ok && missing.code, 'list_missing');
    assert.equal((await pantry.get()).size, 0);
    assert.equal((await trips.get()).size, 0);
  });

  test('keeps usuals from Grocery trips, one count per trip, with a cadence after two', async () => {
    const day = 86_400_000;
    const t0 = Date.parse('2026-11-01T12:00:00Z');
    await applyTrip(adminDb, { householdId: HOUSE, uid: CALLERS.owner.uid, nowMs: t0, input: { listId: 'weekly', tripId: 'trip-usual-001', mode: 'putAwayAndClear', items: tripChoices() } });
    await applyTrip(adminDb, { householdId: HOUSE, uid: CALLERS.owner.uid, nowMs: t0, input: { listId: 'weekly', tripId: 'trip-usual-001', mode: 'putAwayAndClear', items: tripChoices() } });
    await items.doc('milk').set(bought('Milk', 1, 'Dairy', 'op-2'));
    await applyTrip(adminDb, { householdId: HOUSE, uid: CALLERS.owner.uid, nowMs: t0 + 6 * day, input: { listId: 'weekly', tripId: 'trip-usual-002', mode: 'putAwayAndClear', items: [pick('milk', 'Milk', 1, 'Fridge', null, 'op-2')] } });
    const milk = (await usuals.doc('milk').get()).data()!;
    assert.equal(milk.count, 2);
    assert.equal(milk.cadenceDays, 6);
    assert.equal(milk.category, 'Dairy');
    assert.equal((milk.lastBoughtAt as Timestamp).toMillis(), t0 + 6 * day);
    assert.equal((await usuals.doc('rice').get()).data()?.count, 1);
  });

  test('"Put away & clear" after "Put away" counts only the purchases not counted yet in the usuals', async () => {
    await run('editor', 'trip-cnt-00001', 'putAway');
    // A new purchase that is cleared without going on a shelf still counts once.
    await items.doc('bread').set(bought('Bread', 1, 'Bakery'));
    const clear = await run('owner', 'trip-cnt-00002', 'putAwayAndClear', [...tripChoices(), pick('bread', 'Bread', 1, null)]);
    assert.deepEqual(clear.ok && { credited: clear.trip.credited, cleared: clear.trip.cleared.sort() }, { credited: 0, cleared: ['bread', 'milk', 'rice'] });
    const milk = (await usuals.doc('milk').get()).data()!;
    assert.equal(milk.count, 1);
    assert.deepEqual(milk.recent.map((entry: { tripId: string }) => entry.tripId), ['trip-cnt-00001']);
    assert.equal(milk.cadenceDays, null);
    assert.equal((await usuals.doc('rice').get()).data()?.count, 1);
    assert.equal((await usuals.doc('bread').get()).data()?.count, 1);
    assert.deepEqual((await trips.doc('trip-cnt-00002').get()).data()?.usualIds, ['bread']);
  });

  test('a put-away purchase deleted and restored by Undo is not credited again; after the trip is undone it can be', async () => {
    // Delete, then the client's Undo writes the item back without the server-only stamps.
    const deleteAndRestore = async () => {
      const before = (await items.doc('milk').get()).data()!;
      await items.doc('milk').delete();
      const restored = restoreItemData(before, CALLERS.owner.uid, 'restore-0001');
      assert.equal('pantryCreditedAt' in restored || 'creditTripId' in restored, false);
      await items.doc('milk').set(restored);
    };
    await run('editor', 'trip-del-00001', 'putAway');
    assert.deepEqual((await trips.doc('trip-del-00001').get()).data()?.creditedPurchaseOpIds.sort(), ['op-Milk', 'op-Rice']);
    await deleteAndRestore();
    const again = await run('editor', 'trip-del-00002', 'putAway', [pick('milk', 'Milk', 2, 'Fridge', '2026-11-17')]);
    assert.equal(again.ok && again.trip.applied, false);
    assert.deepEqual((await pantryRows()).map((row) => row.packages), [2, 1]);

    // Once that trip is undone the purchase is no longer in the pantry, so it can be put away again (once).
    assert.equal((await undo('editor', 'trip-del-00001')).ok, true);
    assert.equal((await pantry.get()).size, 0);
    const redo = await run('editor', 'trip-del-00003', 'putAway', [pick('milk', 'Milk', 2, 'Fridge', '2026-11-17')]);
    assert.equal(redo.ok && redo.trip.credited, 1);

    // Deleted and restored again, then cleared: cleared without a second credit or usual count.
    await deleteAndRestore();
    const clear = await run('owner', 'trip-del-00004', 'putAwayAndClear', [pick('milk', 'Milk', 2, 'Fridge', '2026-11-17')]);
    assert.deepEqual(clear.ok && { credited: clear.trip.credited, cleared: clear.trip.cleared }, { credited: 0, cleared: ['milk'] });
    assert.deepEqual(await pantryRows(), [{ name: 'Milk', location: 'Fridge', packages: 2, expiryDate: '2026-11-17' }]);
    assert.equal((await usuals.doc('milk').get()).data()?.count, 1);
  });

  test('a name longer than the pantry keeps is recorded as stored, so Undo takes the untouched batch back', async () => {
    const long = `Extra ${'creamy '.repeat(30)}yogurt`;
    assert.ok(long.length > 120);
    await items.doc('yogurt').set(bought(long, 3, 'Dairy', 'op-yogurt'));
    await run('owner', 'trip-long-0001', 'putAwayAndClear', [pick('yogurt', long, 3, 'Fridge', null, 'op-yogurt')]);
    const [batch] = (await pantry.get()).docs;
    assert.ok(batch.data().name.length <= 120);
    assert.equal((await trips.doc('trip-long-0001').get()).data()?.pantryEffects[0].name, batch.data().name);

    const result = await undo('owner', 'trip-long-0001');
    assert.deepEqual(result.ok && { reversed: result.undo.reversed, kept: result.undo.kept, restored: result.undo.restored }, { reversed: 1, kept: [], restored: 1 });
    assert.equal((await pantry.get()).size, 0);
    assert.equal((await items.doc('yogurt').get()).data()?.name, long);
  });

  test('a trip larger than one transaction applies the longest run that fits and leaves the rest for another trip', async () => {
    await items.doc('milk').delete();
    await items.doc('rice').delete();
    const names = Array.from({ length: 200 }, (_, index) => `Item ${String(index).padStart(3, '0')}`);
    const writer = adminDb.bulkWriter();
    names.forEach((name, index) => void writer.set(items.doc(`i${index}`), bought(name, 1, 'Pantry')));
    await writer.close();
    const choices = names.map((name, index) => pick(`i${index}`, name, 1, 'Pantry'));

    // Each item needs a clear, a new batch and a usual: 200 items are more writes than one trip may make.
    const first = await run('owner', 'trip-many-0001', 'putAwayAndClear', choices);
    assert.equal(first.ok, true);
    const trip = first.ok ? first.trip : null;
    assert.ok(trip && trip.cleared.length > 0 && trip.deferred.length > 0);
    assert.equal(trip!.cleared.length + trip!.deferred.length, 200);
    assert.deepEqual(trip!.deferred.map((entry) => entry.itemId), choices.slice(trip!.cleared.length).map((entry) => entry.itemId), 'the items after the run');
    assert.equal((await items.get()).size, trip!.deferred.length);
    assert.equal((await pantry.get()).size, trip!.cleared.length);
    // A retry reports the same split.
    const retry = await run('owner', 'trip-many-0001', 'putAwayAndClear', choices);
    assert.equal(retry.ok && retry.trip.deferred.length, trip!.deferred.length);

    // The rest go in another trip.
    const rest = choices.slice(trip!.cleared.length);
    const second = await run('owner', 'trip-many-0002', 'putAwayAndClear', rest);
    assert.deepEqual(second.ok && { cleared: second.trip.cleared.length, deferred: second.trip.deferred.length }, { cleared: rest.length, deferred: 0 });
    assert.equal((await items.get()).size, 0);
    assert.equal((await pantry.get()).size, 200);
  });
});

describe('undoTrip', () => {
  test('reverses the credit and puts the cleared items back, once; a repeat (or a reload) reports it already undone', async () => {
    await run('owner', 'trip-undo-0001');
    const result = await undo('owner', 'trip-undo-0001');
    assert.equal(result.ok, true);
    assert.deepEqual(result.ok && { restored: result.undo.restored, reversed: result.undo.reversed, kept: result.undo.kept },
      { restored: 2, reversed: 2, kept: [] });
    // Untouched batches the trip created are deleted; the items are back as they were.
    assert.equal((await pantry.get()).size, 0);
    const milk = (await items.doc('milk').get()).data()!;
    assert.equal(milk.status, 'purchased');
    assert.equal(milk.quantity, 2);
    assert.equal(milk.addedByUid, CALLERS.owner.uid);
    assert.equal((await usuals.get()).size, 0);
    const trip = (await trips.doc('trip-undo-0001').get()).data()!;
    assert.ok(trip.undoneAt instanceof Timestamp);
    assert.equal(trip.undoneByUid, CALLERS.owner.uid);

    const again = await undo('owner', 'trip-undo-0001');
    assert.equal(again.ok && again.undo.alreadyUndone, true);
    assert.equal((await items.get()).size, 2);
  });

  test('never replaces another member\'s newer edit: used, moved and re-added stay as they are', async () => {
    await pantry.doc('rice-old').set({ name: 'Rice', nameKey: 'rice', location: 'Pantry', unit: 'items', packages: 4, packageSize: null, expiryDate: null, quantity: 4, schemaVersion: 2 });
    await run('owner', 'trip-newer-001');
    assert.equal((await pantry.doc('rice-old').get()).data()?.packages, 5);
    const milkBatch = (await pantry.where('nameKey', '==', 'milk').get()).docs[0];
    // Meanwhile on another device: all five rice were used, the milk moved to the
    // Freezer, and someone added a new Rice item under the same id.
    await pantry.doc('rice-old').update({ packages: 0, quantity: 0, updatedByUid: CALLERS.editor.uid, updatedAt: Timestamp.now() });
    await milkBatch.ref.update({ location: 'Freezer', updatedByUid: CALLERS.editor.uid, updatedAt: Timestamp.now() });
    await items.doc('rice').set({ ...bought('Rice', 7, 'Pantry', 'op-newer'), status: 'needed' });

    const result = await undo('owner', 'trip-newer-001');
    assert.equal(result.ok, true);
    assert.deepEqual(result.ok && { restored: result.undo.restored, clamped: result.undo.clamped, kept: result.undo.kept },
      { restored: 1, clamped: 1, kept: ['Milk'] });
    assert.equal((await pantry.doc('rice-old').get()).data()?.packages, 0, 'never below zero');
    assert.equal((await milkBatch.ref.get()).data()?.location, 'Freezer');
    assert.equal((await milkBatch.ref.get()).data()?.packages, 2);
    assert.equal((await items.doc('rice').get()).data()?.quantity, 7, 'the newer item is not overwritten');
    assert.equal(await exists(items.doc('milk')), true);
  });

  test('takes a "Put away" trip\'s credit stamps off only while they are still that trip\'s', async () => {
    await run('editor', 'trip-stamp-001', 'putAway');
    const result = await undo('editor', 'trip-stamp-001');
    assert.equal(result.ok, true);
    const milk = (await items.doc('milk').get()).data()!;
    assert.equal(milk.pantryCreditedAt, undefined);
    assert.equal(milk.creditTripId, undefined);
    assert.equal((await pantry.get()).size, 0);
  });

  test('only the latest trip, only within 15 minutes, and only for members who can edit', async () => {
    await run('owner', 'trip-old-00001', 'putAwayAndClear', [pick('rice', 'Rice', 1, 'Pantry')]);
    await run('owner', 'trip-new-00001', 'putAwayAndClear', [pick('milk', 'Milk', 2, 'Fridge')]);
    const older = await undo('owner', 'trip-old-00001');
    assert.equal(!older.ok && older.code, 'not_latest');
    const viewer = await undo('viewer', 'trip-new-00001');
    assert.equal(!viewer.ok && viewer.code, 'forbidden');
    const missing = await undo('owner', 'trip-none-0001');
    assert.equal(!missing.ok && missing.code, 'not_found');

    const appliedAt = ((await trips.doc('trip-new-00001').get()).data()!.appliedAt as Timestamp).toMillis();
    await assert.rejects(
      undoTripOnServer(adminDb, { householdId: HOUSE, uid: CALLERS.owner.uid, tripId: 'trip-new-00001', nowMs: appliedAt + TRIP_UNDO_WINDOW_MS + 1 }),
      { name: 'TripRefused', code: 'expired' },
    );
    const inside = await undoTripOnServer(adminDb, { householdId: HOUSE, uid: CALLERS.owner.uid, tripId: 'trip-new-00001', nowMs: appliedAt + TRIP_UNDO_WINDOW_MS - 1 });
    assert.equal(inside.restored, 1);
  });
});
