import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import {
  MAX_TRIP_ITEMS,
  TRIP_UNDO_WINDOW_MS,
  cadenceDays,
  decideTripItems,
  expiryForPick,
  isAlreadyCredited,
  offerEmptyListDelete,
  parseTripInput,
  pickAfterShelfChange,
  planPantryReversal,
  planTripPantry,
  readAfterTrip,
  shelfDefaultExpiry,
  shelfDefaultPick,
  tripOutcomeText,
  tripPlanWrites,
  tripTargetStillValid,
  tripUndoOpen,
  undoableTripId,
  usualAfterTrip,
  usualId,
  usualSuggestions,
  usualWithoutTrip,
  type TripChoice,
} from '../../src/lib/shopping/trip-plan';
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
    ], [{ id: 'm1', data: v2(3) }, { id: 'm2', data: v2(1, { expiryDate: '2026-12-01' }) }]);
    assert.deepEqual(plans.map((plan) => [plan.location, plan.expiryDate, plan.packages, plan.targetId]), [
      ['Fridge', null, 3, 'm1'],
      ['Fridge', '2026-11-17', 1, null],
      ['Freezer', null, 1, null],
    ]);
  });

  test('a target is re-checked inside the transaction and filled up to 10,000 with the rest split', () => {
    const plan = { name: 'Milk', location: 'Fridge' as const, expiryDate: null, packages: 12_500, targetId: 'm1' };
    assert.equal(tripTargetStillValid(v2(9_000), plan), true);
    assert.equal(tripTargetStillValid(v2(9_000, { location: 'Pantry' }), plan), false);
    assert.equal(tripTargetStillValid(v2(9_000, { expiryDate: '2026-11-17' }), plan), false);
    assert.equal(tripTargetStillValid(undefined, plan), false);
    assert.deepEqual(tripPlanWrites(plan, { packages: 9_000 }), { toTarget: 1_000, newBatches: [10_000, 1_500] });
    assert.deepEqual(tripPlanWrites({ ...plan, packages: 25_000 }, null), { toTarget: 0, newBatches: [10_000, 10_000, 5_000] });
  });
});

describe('Undo of the pantry credit (SH-2d)', () => {
  const effect = { pantryId: 'm1', kind: 'increment' as const, packages: 3, name: 'Milk', location: 'Fridge' as const, expiryDate: null };
  const batch = (packages: number, extra: Record<string, unknown> = {}) => ({ name: 'Milk', location: 'Fridge', unit: 'items', packages, packageSize: null, expiryDate: null, ...extra });

  test('subtracts only what the trip added, never below zero', () => {
    assert.deepEqual(planPantryReversal(effect, batch(5), false), { kind: 'set', packages: 2, clamped: false });
    // Someone already used two of the three: only what is left comes off.
    assert.deepEqual(planPantryReversal(effect, batch(1), false), { kind: 'set', packages: 0, clamped: true });
  });

  test('leaves a batch someone changed or removed since; deletes an untouched batch the trip created', () => {
    assert.deepEqual(planPantryReversal(effect, batch(5, { location: 'Pantry' }), false), { kind: 'skip', reason: 'changed' });
    assert.deepEqual(planPantryReversal(effect, batch(5, { expiryDate: '2026-12-01' }), false), { kind: 'skip', reason: 'changed' });
    assert.deepEqual(planPantryReversal(effect, undefined, false), { kind: 'skip', reason: 'gone' });
    const created = { ...effect, kind: 'create' as const };
    assert.deepEqual(planPantryReversal(created, batch(3), true), { kind: 'delete' });
    assert.deepEqual(planPantryReversal(created, batch(3), false), { kind: 'set', packages: 0, clamped: false });
    assert.deepEqual(planPantryReversal(created, batch(4), true), { kind: 'set', packages: 1, clamped: false });
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

  test('ids are safe document ids', () => {
    assert.equal(usualId('Whole  Milk'), 'whole%20milk');
    assert.equal(usualId('a/b'), 'a%2Fb');
    assert.equal(usualId('..'), 'k-..');
    assert.equal(usualId('   '), null);
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
