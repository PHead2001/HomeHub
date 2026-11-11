import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import {
  MAX_TRIP_ITEMS,
  TRIP_UNDO_WINDOW_MS,
  cadenceDays,
  chunked,
  decideTripItems,
  firestoreDocumentBytes,
  firestoreValueBytes,
  MAX_TRIP_DOCUMENT_BYTES,
  expiryForPick,
  isAlreadyCredited,
  largestFittingCount,
  offerEmptyListDelete,
  parseTripInput,
  pickAfterShelfChange,
  planPantryReversal,
  planTripPantry,
  purchasesCreditedBy,
  readAfterTrip,
  shelfDefaultExpiry,
  shelfDefaultPick,
  tripGroup,
  tripOutcomeText,
  tripUndoAfterAnswer,
  tripPlanWrites,
  tripTargetStillValid,
  tripUndoOpen,
  undoableTripId,
  usualAfterTrip,
  usualSuggestions,
  usualWithoutTrip,
  type TripChoice,
} from '../../src/lib/shopping/trip-plan';
import { pantryBatchFields } from '../../src/lib/shopping/pantry-batches';
import { closeIfCurrent, createRequestGate } from '../../src/lib/shopping/request-gate';
import { usualDigest, usualId } from '../../src/lib/shopping/usual-id';
import { pushJournal, readJournal, type JournalStorage, type UndoEntry } from '../../src/lib/shopping/undo';

const ts = (ms: number) => ({ toMillis: () => ms });
const DAY = 86_400_000;

const choice = (itemId: string, name: string, quantity = 1, extra: Partial<TripChoice> = {}): TripChoice => ({
  itemId,
  seen: { name, quantity, purchaseOpId: `op-${itemId}` },
  location: 'Fridge',
  expiryDate: null,
  ...extra,
});

describe('trip input (server boundary)', () => {
  const valid = { listId: 'weekly', tripId: 'trip-1234-abcd', mode: 'putAwayAndClear', items: [choice('milk', 'Milk')] };

  test('accepts a well-formed trip and drops the expiry of an item that is not shelved', () => {
    const parsed = parseTripInput({ ...valid, items: [choice('milk', 'Milk', 1, { location: null, expiryDate: '2026-11-17' })] });
    assert.ok(parsed);
    assert.equal(parsed.items[0].expiryDate, null);
  });

  test('refuses malformed ids, modes, shelves, dates, duplicates and oversized trips', () => {
    assert.equal(parseTripInput(null), null);
    assert.equal(parseTripInput({ ...valid, tripId: 'short' }), null);
    assert.equal(parseTripInput({ ...valid, tripId: 'a/b-cdefghij' }), null);
    assert.equal(parseTripInput({ ...valid, listId: 'a/b' }), null);
    assert.equal(parseTripInput({ ...valid, listId: '__x__' }), null);
    assert.equal(parseTripInput({ ...valid, mode: 'everything' }), null);
    assert.equal(parseTripInput({ ...valid, items: [] }), null);
    assert.equal(parseTripInput({ ...valid, items: [choice('a', 'A', 1, { location: 'Garage' as never })] }), null);
    assert.equal(parseTripInput({ ...valid, items: [choice('a', 'A', 1, { expiryDate: '2026-02-30' })] }), null);
    assert.equal(parseTripInput({ ...valid, items: [choice('a', 'A', 1, { expiryDate: '2026-11-17T00:00:00Z' })] }), null);
    assert.equal(parseTripInput({ ...valid, items: [choice('a', 'A'), choice('a', 'A')] }), null);
    const many = Array.from({ length: MAX_TRIP_ITEMS + 1 }, (_, index) => choice(`i${index}`, `I${index}`));
    assert.equal(parseTripInput({ ...valid, items: many }), null);
  });
});

describe('which items a trip applies to (SH-2b/c)', () => {
  const stored = (name: string, quantity = 1, extra: Record<string, unknown> = {}) => ({ name, quantity, status: 'purchased', purchaseOpId: `op-${name.toLowerCase()}`, ...extra });

  test('applies only items still exactly as confirmed; changed, un-ticked, re-bought and gone items are left alone', () => {
    const read = new Map<string, Record<string, unknown> | undefined>([
      ['milk', stored('Milk')],
      ['eggs', stored('Eggs', 12)], // re-counted meanwhile
      ['bread', { ...stored('Bread'), status: 'needed' }],
      ['jam', stored('Jam', 1, { purchaseOpId: 'op-new' })], // bought again
      ['tea', undefined],
    ]);
    const { apply, skipped } = decideTripItems([
      choice('milk', 'Milk'), choice('eggs', 'Eggs', 6), choice('bread', 'Bread'), choice('jam', 'Jam'), choice('tea', 'Tea'),
    ], read);
    assert.deepEqual(apply.map((entry) => entry.choice.itemId), ['milk']);
    assert.deepEqual(skipped.map(({ itemId, reason }) => [itemId, reason]), [
      ['eggs', 'changed'], ['bread', 'not-purchased'], ['jam', 'changed'], ['tea', 'gone'],
    ]);
  });

  test('an item without a shelf, or whose purchase is already credited, is applied without credit', () => {
    const read = new Map<string, Record<string, unknown> | undefined>([
      ['milk', stored('Milk', 1, { pantryCreditedAt: ts(2_000), purchasedAt: ts(1_000) })],
      ['soap', stored('Soap')],
    ]);
    const { apply } = decideTripItems([choice('milk', 'Milk'), choice('soap', 'Soap', 1, { location: null })], read);
    assert.deepEqual(apply.map((entry) => [entry.choice.itemId, entry.credit]), [['milk', false], ['soap', false]]);
  });

  test('a purchase an earlier trip credited is not credited (or counted) again, even without its stamp', () => {
    // Deleted after "Put away" and restored by Undo: the stamp is gone, the purchase id is not.
    const read = new Map<string, Record<string, unknown> | undefined>([
      ['milk', stored('Milk')],
      ['rice', stored('Rice')],
    ]);
    const { apply } = decideTripItems([choice('milk', 'Milk'), choice('rice', 'Rice')], read, new Set(['op-milk']));
    assert.deepEqual(apply.map((entry) => [entry.choice.itemId, entry.credit, entry.alreadyCredited]), [['milk', false, true], ['rice', true, false]]);
    // A stamped purchase is already credited as well; one only cleared (no shelf) is a new purchase.
    const stamped = decideTripItems(
      [choice('milk', 'Milk', 1, { location: null }), choice('rice', 'Rice', 1, { location: null })],
      new Map([['milk', stored('Milk', 1, { pantryCreditedAt: ts(2_000), purchasedAt: ts(1_000) })], ['rice', stored('Rice')]]),
    );
    assert.deepEqual(stamped.apply.map((entry) => [entry.choice.itemId, entry.alreadyCredited]), [['milk', true], ['rice', false]]);
  });

  test('earlier credits are found by purchase id on trips that are not undone', () => {
    const trips = [
      { creditedPurchaseOpIds: ['op-a', 'op-b'], undoneAt: null },
      { creditedPurchaseOpIds: ['op-c'], undoneAt: ts(5) },
      { creditedPurchaseOpIds: 'op-d' },
      {},
    ];
    assert.deepEqual([...purchasesCreditedBy(trips, ['op-a', 'op-c', 'op-d', 'op-x'])], ['op-a']);
    assert.deepEqual(chunked(Array.from({ length: 65 }, (_, index) => index)).map((group) => group.length), [30, 30, 5]);
    assert.deepEqual(chunked([]), []);
  });

  test('a credit stamp counts only until the item is bought again', () => {
    assert.equal(isAlreadyCredited({}), false);
    assert.equal(isAlreadyCredited({ pantryCreditedAt: ts(2_000) }), true);
    assert.equal(isAlreadyCredited({ pantryCreditedAt: ts(2_000), purchasedAt: ts(1_000) }), true);
    assert.equal(isAlreadyCredited({ pantryCreditedAt: ts(2_000), purchasedAt: ts(3_000) }), false);
  });
});

describe('pantry credit plan (Pantry v2, 10,000 per batch)', () => {
  const v2 = (packages: number, extra: Record<string, unknown> = {}) => ({
    name: 'Milk', nameKey: 'milk', location: 'Fridge', unit: 'items', packages, packageSize: null, expiryDate: null, schemaVersion: 2, quantity: packages, ...extra,
  });

  test('combines same name, shelf and expiry; keeps other expiries and shelves apart; merges only with the same key', () => {
    const plans = planTripPantry([
      { name: 'Milk', quantity: 1, location: 'Fridge', expiryDate: null },
      { name: 'milk', quantity: 2, location: 'Fridge', expiryDate: null },
      { name: 'Milk', quantity: 1, location: 'Fridge', expiryDate: '2026-11-17' },
      { name: 'Milk', quantity: 1, location: 'Freezer', expiryDate: null },
    ], [{ id: 'm1', data: v2(3) }, { id: 'm2', data: v2(1, { expiryDate: '2026-12-01' }) }], 'America/Chicago');
    assert.deepEqual(plans.map((plan) => [plan.location, plan.expiryDate, plan.packages, plan.targetId]), [
      ['Fridge', null, 3, 'm1'],
      ['Fridge', '2026-11-17', 1, null],
      ['Freezer', null, 1, null],
    ]);
  });

  test('a name longer than the pantry keeps is planned, matched and recorded as the pantry stores it', () => {
    const long = `Organic ${'very '.repeat(40)}long oat milk`;
    assert.ok(long.length > 120);
    const stored = pantryBatchFields({ name: long, location: 'Fridge', unit: 'items', packages: 2, packageSize: null, expiryDate: null });
    assert.equal(stored.name.length <= 120, true);
    const [plan] = planTripPantry([{ name: long, quantity: 1, location: 'Fridge', expiryDate: null }], [{ id: 'm1', data: stored }], 'America/Chicago');
    assert.equal(plan.name, stored.name, 'the plan (and so the trip effect) carries the stored name');
    assert.equal(plan.targetId, 'm1', 'merges into the batch an earlier trip created');
    assert.equal(tripTargetStillValid(stored, { ...plan, name: long }, 'America/Chicago'), true);
    // Undo recognises the untouched batch, also for an effect recorded with the full shopping name.
    const effect = { pantryId: 'm1', kind: 'create' as const, packages: 2, name: long, location: 'Fridge' as const, expiryDate: null };
    assert.deepEqual(planPantryReversal(effect, stored, true, 'America/Chicago'), { kind: 'delete' });
    assert.deepEqual(planPantryReversal({ ...effect, name: plan.name }, stored, true, 'America/Chicago'), { kind: 'delete' });
  });

  test('a target is re-checked inside the transaction and filled up to 10,000 with the rest split', () => {
    const plan = { name: 'Milk', location: 'Fridge' as const, expiryDate: null, packages: 12_500, targetId: 'm1' };
    assert.equal(tripTargetStillValid(v2(9_000), plan, 'America/Chicago'), true);
    assert.equal(tripTargetStillValid(v2(9_000, { location: 'Pantry' }), plan, 'America/Chicago'), false);
    assert.equal(tripTargetStillValid(v2(9_000, { expiryDate: '2026-11-17' }), plan, 'America/Chicago'), false);
    assert.equal(tripTargetStillValid(undefined, plan, 'America/Chicago'), false);
    assert.deepEqual(tripPlanWrites(plan, { packages: 9_000 }), { toTarget: 1_000, newBatches: [10_000, 1_500] });
    assert.deepEqual(tripPlanWrites({ ...plan, packages: 25_000 }, null), { toTarget: 0, newBatches: [10_000, 10_000, 5_000] });
  });
});

describe('one trip at a time (MAX_TRIP_ITEMS)', () => {
  const item = (id: string, extra: Record<string, unknown> = {}) => ({ id, name: id, purchaseOpId: `op-${id}`, ...extra });

  test('a trip carries at most MAX_TRIP_ITEMS purchases, by name; the rest are left for another trip', () => {
    const many = Array.from({ length: MAX_TRIP_ITEMS + 25 }, (_, index) => item(`item-${String(index).padStart(3, '0')}`)).reverse();
    for (const mode of ['putAwayAndClear', 'putAway'] as const) {
      const group = tripGroup(many, mode, new Set());
      assert.equal(group.items.length, MAX_TRIP_ITEMS);
      assert.equal(group.left, 25);
      assert.equal(group.items[0].id, 'item-000');
      assert.ok(parseTripInput({
        listId: 'weekly', tripId: 'trip-1234-abcd', mode, items: group.items.map((entry) => choice(entry.id, entry.name)),
      }), 'the group is a valid trip');
    }
    assert.equal(tripGroup(many.slice(0, 3), 'putAwayAndClear', new Set()).left, 0);
  });

  test('purchases already on the shelves: left out of "Put away", only cleared by "Put away & clear"', () => {
    const items = [item('jam'), item('milk', { pantryCreditedAt: ts(2_000), purchasedAt: ts(1_000) }), item('rice')];
    const credited = new Set(['op-rice']);
    const put = tripGroup(items, 'putAway', credited);
    assert.deepEqual(put.items.map((entry) => entry.id), ['jam']);
    const clear = tripGroup(items, 'putAwayAndClear', credited);
    assert.deepEqual(clear.items.map((entry) => entry.id), ['jam', 'milk', 'rice']);
    assert.deepEqual([...clear.shelvedIds].sort(), ['milk', 'rice']);
  });

  test('trip size is counted in Firestore storage bytes (UTF-8), not characters', () => {
    // Firestore's published examples (no allowance): "Task 1" is 7, a document name of users/jeff/tasks/my_task_id is 44.
    assert.equal(firestoreValueBytes('Task 1', 0), 7);
    assert.equal(firestoreValueBytes({ done: false, priority: 1 }, 0), 5 + 1 + 9 + 8);
    assert.equal(firestoreDocumentBytes('users/jeff/tasks/my_task_id', {}) - firestoreValueBytes({}) - 32, 44);
    assert.equal(firestoreValueBytes('牛', 0), 4, 'three UTF-8 bytes + 1');
    assert.equal(firestoreValueBytes({ toMillis: () => 0 }, 0), 8);
    // 149 purchases with 100-character Japanese names and two 2,000-character Japanese links:
    // under 700,000 JSON characters, but well over 1 MiB as stored.
    const record = (index: number) => ({
      itemId: `i${index}`, name: '和'.repeat(100), quantity: 1, category: 'Other', purchaseOpId: `op-${index}`, location: null, expiryDate: null,
      credited: false, cleared: true, data: { name: '和'.repeat(100), sourceUrl: `https://example.test/${'道'.repeat(2_000)}`, imageUrl: `https://example.test/${'画'.repeat(2_000)}`, status: 'purchased', quantity: 1 },
    });
    const documentFor = (count: number) => ({ items: Array.from({ length: count }, (_, index) => record(index)) });
    assert.ok(JSON.stringify(documentFor(149)).length < 700_000);
    assert.ok(firestoreDocumentBytes('households/h/trips/t', documentFor(149)) > 1_048_576);
    const count = largestFittingCount(149, (size) => firestoreDocumentBytes('households/h/trips/t', documentFor(size)) <= MAX_TRIP_DOCUMENT_BYTES);
    assert.ok(count > 0 && count < 149);
    assert.ok(firestoreDocumentBytes('households/h/trips/t', documentFor(count)) <= MAX_TRIP_DOCUMENT_BYTES);
  });

  test('the server takes the longest run of items that fits', () => {
    assert.equal(largestFittingCount(200, (size) => size * 3 + 1 <= 450), 149);
    assert.equal(largestFittingCount(10, () => true), 10);
    assert.equal(largestFittingCount(10, () => false), 0);
    assert.equal(largestFittingCount(0, () => true), 0);
    assert.equal(largestFittingCount(1, (size) => size <= 1), 1);
  });

  test('the outcome text says how many purchases are still on the list', () => {
    const text = tripOutcomeText({ mode: 'putAwayAndClear', credited: 2, cleared: 2, skipped: [], remaining: 30 });
    assert.match(text.description, /30 items still on the list: put them away in another trip./);
    assert.match(tripOutcomeText({ mode: 'putAway', credited: 1, cleared: 0, skipped: [], remaining: 1 }).description, /1 item still on the list: put it away/);
  });
});

describe('Undo of the pantry credit (SH-2d)', () => {
  const effect = { pantryId: 'm1', kind: 'increment' as const, packages: 3, name: 'Milk', location: 'Fridge' as const, expiryDate: null };
  const batch = (packages: number, extra: Record<string, unknown> = {}) => ({ name: 'Milk', location: 'Fridge', unit: 'items', packages, packageSize: null, expiryDate: null, ...extra });

  test('subtracts only what the trip added, never below zero', () => {
    assert.deepEqual(planPantryReversal(effect, batch(5), false, 'America/Chicago'), { kind: 'set', packages: 2, clamped: false });
    // Someone already used two of the three: only what is left comes off.
    assert.deepEqual(planPantryReversal(effect, batch(1), false, 'America/Chicago'), { kind: 'set', packages: 0, clamped: true });
  });

  test('leaves a batch someone changed or removed since; deletes an untouched batch the trip created', () => {
    assert.deepEqual(planPantryReversal(effect, batch(5, { location: 'Pantry' }), false, 'America/Chicago'), { kind: 'skip', reason: 'changed' });
    assert.deepEqual(planPantryReversal(effect, batch(5, { expiryDate: '2026-12-01' }), false, 'America/Chicago'), { kind: 'skip', reason: 'changed' });
    assert.deepEqual(planPantryReversal(effect, undefined, false, 'America/Chicago'), { kind: 'skip', reason: 'gone' });
    const created = { ...effect, kind: 'create' as const };
    assert.deepEqual(planPantryReversal(created, batch(3), true, 'America/Chicago'), { kind: 'delete' });
    assert.deepEqual(planPantryReversal(created, batch(3), false, 'America/Chicago'), { kind: 'set', packages: 0, clamped: false });
    assert.deepEqual(planPantryReversal(created, batch(4), true, 'America/Chicago'), { kind: 'set', packages: 1, clamped: false });
  });

  test('the 15-minute window and the latest-trip offer', () => {
    assert.equal(tripUndoOpen(1_000, 1_000 + TRIP_UNDO_WINDOW_MS), true);
    assert.equal(tripUndoOpen(1_000, 1_001 + TRIP_UNDO_WINDOW_MS), false);
    assert.equal(tripUndoOpen(null, 0), false);
    const now = 10 * DAY;
    const trips = [
      { id: 'b', appliedAtMs: now - 60_000, undoneAtMs: null },
      { id: 'a', appliedAtMs: now - 120_000, undoneAtMs: null },
    ];
    assert.equal(undoableTripId(trips, now), 'b');
    assert.equal(undoableTripId([{ ...trips[0], undoneAtMs: now }, trips[1]], now), null);
    assert.equal(undoableTripId(trips, now + TRIP_UNDO_WINDOW_MS), null);
    assert.equal(undoableTripId([], now), null);
  });
});

describe('usuals (SH-32)', () => {
  test('a trip counts once, keeps the cadence as the median gap, and a member-corrected category wins', () => {
    let usual = usualAfterTrip(undefined, { name: 'Milk', category: 'Dairy', tripId: 't1', atMs: 0 });
    assert.equal(usual.count, 1);
    assert.equal(usual.cadenceDays, null);
    usual = usualAfterTrip(usual as never, { name: 'Milk', category: 'Dairy', tripId: 't2', atMs: 6 * DAY });
    // A retry of the same trip does not count twice.
    usual = usualAfterTrip(usual as never, { name: 'Milk', category: 'Dairy', tripId: 't2', atMs: 6 * DAY });
    usual = usualAfterTrip(usual as never, { name: 'Milk', category: 'Dairy', tripId: 't3', atMs: 13 * DAY });
    assert.equal(usual.count, 3);
    assert.equal(usual.cadenceDays, 7);
    assert.equal(cadenceDays([{ tripId: 'a', atMs: 0 }, { tripId: 'b', atMs: 5 * DAY }, { tripId: 'c', atMs: 11 * DAY }]), 6);
    const corrected = usualAfterTrip({ ...usual, category: 'Drinks', categoryUpdatedAt: ts(1) }, { name: 'Milk', category: 'Dairy', tripId: 't4', atMs: 20 * DAY });
    assert.equal(corrected.category, 'Drinks');
  });

  test('Undo takes the trip back out, and deletes a usual that only had that trip', () => {
    const one = usualAfterTrip(undefined, { name: 'Milk', category: 'Dairy', tripId: 't1', atMs: 0 });
    assert.deepEqual(usualWithoutTrip(one as never, 't1'), { action: 'delete' });
    assert.deepEqual(usualWithoutTrip(one as never, 'other'), { action: 'keep' });
    const two = usualAfterTrip(one as never, { name: 'Milk', category: 'Dairy', tripId: 't2', atMs: 6 * DAY });
    const back = usualWithoutTrip(two as never, 't2');
    assert.equal(back.action, 'set');
    assert.equal(back.action === 'set' && back.fields.count, 1);
    assert.equal(back.action === 'set' && back.fields.lastBoughtAtMs, 0);
  });

  test('ids are safe document ids: readable when short, otherwise a prefix and a SHA-256 digest of the whole name key', () => {
    assert.equal(usualId('Whole  Milk'), 'whole%20milk');
    assert.equal(usualId('a/b'), 'a%2Fb');
    assert.equal(usualId('   '), null);
    // SHA-256 test vector (FIPS 180-2 "abc"), first 128 bits.
    assert.equal(usualDigest('abc'), 'ba7816bf8f01cfea414140de5dae2223');
    assert.equal(usualId('..'), `..~${usualDigest('..')}`);
    assert.equal(usualId('__x__'), `__x__~${usualDigest('__x__')}`);
    // "~" is never in a readable id, so a readable id cannot equal a digested one.
    assert.equal(usualId('a~b'), `a~b~${usualDigest('a~b')}`);
    // Distinct long names sharing a long prefix (CJK: 9 encoded characters each) stay distinct.
    const shared = '牛乳'.repeat(30);
    const a = usualId(`${shared}A`)!;
    const b = usualId(`${shared}B`)!;
    assert.notEqual(a, b);
    assert.equal(usualId(`${shared}A`), a, 'stable');
    assert.equal(usualId(`  ${shared}a `), a, 'from the name key (case and spaces)');
    for (const id of [a, b, usualId('x'.repeat(500))!, usualId('長'.repeat(500))!]) {
      assert.ok(Buffer.byteLength(id, 'utf8') <= 100, id);
      assert.ok(!id.includes('/') && !/^__.*__$/.test(id));
    }
  });

  test('suggestions: due within a day, bought at least twice, not already needed, most overdue first', () => {
    const now = 100 * DAY;
    const usuals = [
      { id: 'milk', name: 'Milk', count: 4, cadenceDays: 6, lastBoughtAtMs: now - 7 * DAY },
      { id: 'eggs', name: 'Eggs', count: 3, cadenceDays: 7, lastBoughtAtMs: now - 6.5 * DAY },
      { id: 'rice', name: 'Rice', count: 5, cadenceDays: 30, lastBoughtAtMs: now - 2 * DAY },
      { id: 'once', name: 'Saffron', count: 1, cadenceDays: 3, lastBoughtAtMs: now - 10 * DAY },
      { id: 'bread', name: 'Bread', count: 6, cadenceDays: 1, lastBoughtAtMs: now - 3 * DAY },
    ];
    const chips = usualSuggestions(usuals, ['bread'], now);
    assert.deepEqual(chips.map((chip) => chip.label), ['Milk · every ~6 days', 'Eggs · every ~7 days']);
  });
});

describe('put-away expiry chips (SH-30)', () => {
  test('per-shelf defaults: Fridge +7 d, Freezer +3 mo, Pantry none; chips count from the household day', () => {
    assert.equal(shelfDefaultExpiry('Fridge', '2026-11-10'), '2026-11-17');
    assert.equal(shelfDefaultExpiry('Freezer', '2026-11-30'), '2027-02-28');
    assert.equal(shelfDefaultExpiry('Pantry', '2026-11-10'), null);
    assert.equal(expiryForPick('3d', '2026-12-30'), '2027-01-02');
    assert.equal(expiryForPick('1w', '2026-11-10'), '2026-11-17');
    assert.equal(expiryForPick('none', '2026-11-10'), null);
  });

  test('a shelf change moves the default unless the member picked a chip', () => {
    assert.equal(shelfDefaultPick('Freezer'), '3mo');
    assert.equal(pickAfterShelfChange('Freezer', '1w', false), '3mo');
    assert.equal(pickAfterShelfChange('Freezer', '3d', true), '3d');
  });
});

describe('receipt and empty-list prompt (SH-17b, SH-3a)', () => {
  test('the remembered choice defaults to Put away & clear', () => {
    assert.equal(readAfterTrip(undefined), 'putAwayAndClear');
    assert.equal(readAfterTrip('done'), 'done');
    assert.equal(readAfterTrip('anything'), 'putAwayAndClear');
  });

  test('"Delete empty list?" is never offered for Grocery lists, and only when the server says empty', () => {
    assert.equal(offerEmptyListDelete('Grocery', 0), false);
    assert.equal(offerEmptyListDelete('Hardware', 0), true);
    assert.equal(offerEmptyListDelete('Hardware', 1), false);
    assert.equal(offerEmptyListDelete('Hardware', null), false);
  });

  test('the outcome text names items left on the list', () => {
    const text = tripOutcomeText({ mode: 'putAwayAndClear', credited: 2, cleared: 3, skipped: [{ name: 'Eggs', reason: 'changed' }] });
    assert.equal(text.title, 'Put away and cleared');
    assert.match(text.description, /2 items on the shelves\. 1 item cleared without the pantry\. Left on the list: Eggs/);
    assert.equal(tripOutcomeText({ mode: 'putAwayAndClear', credited: 0, cleared: 0, skipped: [] }).description, 'Someone else already put these away.');
  });

  test('a trip Undo is journaled and survives a reload like the other Undo groups', () => {
    const store = new Map<string, string>();
    const storage: JournalStorage = { getItem: (key) => store.get(key) ?? null, setItem: (key, value) => void store.set(key, value), removeItem: (key) => void store.delete(key) };
    const entry: UndoEntry = { group: 'shopping-trip', uid: 'u', householdId: 'h', listId: 'l', itemId: 'trip-1', name: 'Weekly', opId: 'trip-1', expiresAt: 10_000 };
    pushJournal(storage, entry, 0);
    assert.deepEqual(readJournal(storage, 5_000), [entry]);
    assert.deepEqual(readJournal(storage, 10_000), []);
  });
});

describe('wiring (source checks)', () => {
  const read = (...parts: string[]) => readFileSync(join(__dirname, '..', '..', 'src', ...parts), 'utf8');

  test('the trip transaction reads the trip first and applies every write after all reads and the size check', () => {
    const source = read('lib', 'server', 'shopping-trips.ts');
    const body = source.slice(source.indexOf('export async function applyTrip'), source.indexOf('const readEffects'));
    const tripRead = body.indexOf('transaction.get(tripRef)');
    assert.ok(tripRead > 0 && tripRead < body.indexOf('transaction.get(listRef)'), 'the trip document is read first');
    const sizeCheck = body.indexOf("throw new TripRefused('too_large')");
    assert.ok(sizeCheck > 0 && sizeCheck < body.indexOf('for (const write of writes) write();'));
    assert.ok(body.indexOf('for (const write of writes) write();') < body.indexOf('transaction.create(tripRef'));
  });

  test('the client no longer writes pantry credit itself; the dialog keeps one trip id per opening', () => {
    assert.doesNotMatch(read('components', 'shopping-list-client.tsx'), /addPurchasesToPantry/);
    assert.match(read('components', 'shopping', 'put-away-dialog.tsx'), /const \[tripId\] = useState\(\(\) => newOpId\(\)\)/);
  });

  test('the empty-list prompt is cleared whenever it closes (SH-3b)', () => {
    const client = read('components', 'shopping-list-client.tsx');
    assert.match(client, /open=\{emptyList !== null\} onOpenChange=\{\(open\) => \{ if \(!open\) setEmptyList\(null\); \}\}/);
    assert.doesNotMatch(client, /setIsArchiveAlertOpen/);
  });
});

describe('expiry days are household days (D-6) in the put-away plan', () => {
  // A legacy batch saved as the instant of local midnight on 18 November in Auckland.
  const legacy = { name: 'Milk', location: 'Fridge', unit: 'items', quantity: 3, expiryDate: '2026-11-17T11:00:00Z' };
  const AUCKLAND = 'Pacific/Auckland';
  const CHICAGO = 'America/Chicago';

  test('a purchase dated the 17th does not merge into a batch that is the 18th in the household zone', () => {
    const credit = (expiryDate: string) => [{ name: 'Milk', quantity: 1, location: 'Fridge' as const, expiryDate }];
    assert.equal(planTripPantry(credit('2026-11-17'), [{ id: 'old', data: legacy }], AUCKLAND)[0].targetId, null);
    assert.equal(planTripPantry(credit('2026-11-18'), [{ id: 'old', data: legacy }], AUCKLAND)[0].targetId, 'old');
    assert.equal(tripTargetStillValid(legacy, { name: 'Milk', location: 'Fridge', expiryDate: '2026-11-17' }, AUCKLAND), false);
    // The default zone is unchanged: there the same instant is the 17th.
    assert.equal(planTripPantry(credit('2026-11-17'), [{ id: 'old', data: legacy }], CHICAGO)[0].targetId, 'old');
  });

  test('Undo recognises its own batch by its household day', () => {
    const effect = { pantryId: 'old', kind: 'upgrade' as const, packages: 1, name: 'Milk', location: 'Fridge' as const, expiryDate: '2026-11-18' };
    assert.deepEqual(planPantryReversal(effect, legacy, false, AUCKLAND), { kind: 'set', packages: 2, clamped: false });
    assert.deepEqual(planPantryReversal(effect, legacy, false, CHICAGO), { kind: 'skip', reason: 'changed' });
  });
});

describe('opening the put-away dialog after a lookup', () => {
  test('a pending opening is stale once the tab is left or a newer opening starts', () => {
    const gate = createRequestGate();
    const first = gate.begin();
    assert.equal(gate.isCurrent(first), true);
    gate.invalidate();
    assert.equal(gate.isCurrent(first), false, 'left the tab while the lookup was pending');
    const second = gate.begin();
    const third = gate.begin();
    assert.equal(gate.isCurrent(second), false, 'a newer opening wins');
    assert.equal(gate.isCurrent(third), true);
  });

  test('a dialog closes only its own opening: a slow earlier submission never closes a newer dialog', () => {
    const older = { openingId: 1 };
    const newer = { openingId: 2 };
    assert.equal(closeIfCurrent(older, older), null);
    assert.equal(closeIfCurrent(newer, older), newer);
    assert.equal(closeIfCurrent(null, older), null);
    const source = readFileSync(join(__dirname, '..', '..', 'src', 'components', 'shopping', 'use-trip-flow.tsx'), 'utf8');
    assert.ok(source.includes('onOpenChange={(open) => { if (!open) setPutAway((current) => closeIfCurrent(current, opening)); }}'));
    assert.ok(source.includes('key={opening.openingId}'));
  });

  test('a pending opening is stale once the household or list changes; the same scope keeps it', () => {
    const gate = createRequestGate();
    assert.equal(gate.setScope('house/weekly'), true);
    const ticket = gate.begin();
    assert.equal(gate.setScope('house/weekly'), false);
    assert.equal(gate.isCurrent(ticket), true, 'a re-render of the same list');
    assert.equal(gate.setScope('house/'), true, 'back to the overview');
    assert.equal(gate.isCurrent(ticket), false);
    const next = gate.begin();
    gate.setScope('other-house/weekly');
    assert.equal(gate.isCurrent(next), false, 'another household');
  });

  test('the hook checks the gate after the lookup and only shows the dialog on the active tab', () => {
    const source = readFileSync(join(__dirname, '..', '..', 'src', 'components', 'shopping', 'use-trip-flow.tsx'), 'utf8');
    const open = source.slice(source.indexOf('const openPutAway'), source.indexOf('const confirm'));
    assert.ok(open.indexOf('openGate.begin()') < open.indexOf('await purchasesAlreadyPutAway'));
    assert.ok(open.indexOf('await purchasesAlreadyPutAway') < open.indexOf('if (!openGate.isCurrent(ticket)) return;'));
    assert.ok(open.indexOf('if (!openGate.isCurrent(ticket)) return;') < open.indexOf('setPutAway('));
    assert.match(source, /useOnTabDeactivate\(\(\) => \{\s*openGate\.invalidate\(\);\s*setPutAway\(null\);/);
    assert.match(source, /const dialog: ReactNode = opening && tabActive &&/);
    assert.match(source, /useLayoutEffect\(\(\) => \{\s*openGate\.setScope\(scope\);[\s\S]*?return \(\) => openGate\.invalidate\(\);\s*\}, \[openGate, scope\]\);/);
  });
});

describe('the trip Undo survives a reload while the answer is on its way', () => {
  test('journaled before the request; shown when applied, dropped when not, kept when the answer was lost', () => {
    assert.equal(tripUndoAfterAnswer({ ok: true, applied: true }), 'show');
    assert.equal(tripUndoAfterAnswer({ ok: true, applied: false }), 'drop');
    assert.equal(tripUndoAfterAnswer({ ok: false }), 'drop');
    assert.equal(tripUndoAfterAnswer('lost'), 'keep');
    // A reload in that moment finds the journaled entry (it is re-offered on mount).
    const store = new Map<string, string>();
    const storage: JournalStorage = { getItem: (key) => store.get(key) ?? null, setItem: (key, value) => void store.set(key, value), removeItem: (key) => void store.delete(key) };
    const entry: UndoEntry = { group: 'shopping-trip', uid: 'u', householdId: 'h', listId: 'l', itemId: 'trip-1', name: 'Weekly', opId: 'trip-1', expiresAt: 10_000 };
    pushJournal(storage, entry, 0);
    assert.deepEqual(readJournal(storage, 1_000), [entry]);
    const source = readFileSync(join(__dirname, '..', '..', 'src', 'components', 'shopping', 'use-trip-flow.tsx'), 'utf8');
    const confirm = source.slice(source.indexOf('const confirm = async'), source.indexOf('const undo = useCallback'));
    assert.ok(confirm.indexOf('pushJournal(browserJournalStorage(), early') > 0);
    assert.ok(confirm.indexOf('pushJournal(browserJournalStorage(), early') < confirm.indexOf('await putAwayAndClear('));
    assert.ok(confirm.includes("settle('lost')"));
  });
});
