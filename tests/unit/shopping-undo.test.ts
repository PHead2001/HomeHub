import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  UNDO_JOURNAL_KEY,
  UNDO_WINDOW_MS,
  dropJournal,
  fromJournalData,
  isChangedElsewhere,
  journalFor,
  newOpId,
  nextFocusId,
  planRemoveUndo,
  planTickUndo,
  pushJournal,
  readJournal,
  remainingMs,
  toJournalData,
  type JournalStorage,
  type UndoEntry,
} from '../../src/lib/shopping/undo';
import { attributionLabel, memberNameMap, shortAge, toMillis } from '../../src/lib/shopping/attribution';
import { planItemEdit } from '../../src/lib/shopping/edit';
import { restoreItemData } from '../../src/lib/shopping/items';

const memoryStorage = (): JournalStorage & { data: Map<string, string> } => {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => { data.set(key, value); },
    removeItem: (key) => { data.delete(key); },
  };
};

const T0 = Date.parse('2026-11-10T12:00:00.000Z');
const tick = (overrides: Partial<UndoEntry> = {}): UndoEntry => ({
  group: 'shopping-tick', uid: 'sam', householdId: 'h1', listId: 'groceries', itemId: 'milk', name: 'Milk', opId: 'op-1', expiresAt: T0 + UNDO_WINDOW_MS,
  ...overrides,
} as UndoEntry);
const remove = (overrides: Partial<UndoEntry> = {}): UndoEntry => ({
  group: 'shopping-remove', uid: 'sam', householdId: 'h1', listId: 'groceries', itemId: 'eggs', name: 'Eggs', opId: 'restore-1', expiresAt: T0 + UNDO_WINDOW_MS,
  data: { name: 'Eggs', quantity: 2, status: 'needed' },
  ...overrides,
} as UndoEntry);

describe('undo window', () => {
  test('is ten seconds (16.3)', () => {
    assert.equal(UNDO_WINDOW_MS, 10_000);
    assert.equal(remainingMs(tick(), T0 + 4_000), 6_000);
    assert.equal(remainingMs(tick(), T0 + 12_000), 0);
  });

  test('op ids are fresh, short and safe for the rules', () => {
    const a = newOpId();
    const b = newOpId();
    assert.notEqual(a, b);
    assert.ok(a.length > 0 && a.length <= 64);
    assert.equal(newOpId(() => 'a/b c?d'.repeat(20)).length <= 64, true);
    assert.match(newOpId(() => 'a/b c?d'), /^[A-Za-z0-9-]+$/);
    assert.ok(newOpId(() => '///').length > 0, 'never empty');
  });
});

describe('planning an Undo (never a stale whole-document write)', () => {
  test('a tick Undo is written only while that purchase is the current one', () => {
    assert.equal(planTickUndo({ status: 'purchased', purchaseOpId: 'op-1' }, 'op-1'), 'write');
    // Re-ticked by someone else (a new purchase): refused.
    assert.equal(planTickUndo({ status: 'purchased', purchaseOpId: 'op-2' }, 'op-1'), 'refused');
    // Ticked by an older client (no purchaseOpId) after this tick: refused.
    assert.equal(planTickUndo({ status: 'purchased' }, 'op-1'), 'refused');
    // Deleted meanwhile.
    assert.equal(planTickUndo(null, 'op-1'), 'refused');
    // Already back to needed under the same purchase (undone elsewhere): nothing to do.
    assert.equal(planTickUndo({ status: 'needed', purchaseOpId: 'op-1' }, 'op-1'), 'already');
    // Not known here (another list open, or not loaded after a reload): the rules decide.
    assert.equal(planTickUndo(undefined, 'op-1'), 'write');
  });

  test('a delete Undo re-creates the item only if it is absent', () => {
    assert.equal(planRemoveUndo(null), 'write');
    assert.equal(planRemoveUndo(undefined), 'write');
    assert.equal(planRemoveUndo({ status: 'needed' }), 'already');
  });

  test('refusals by the rules read as "changed by someone else"', () => {
    assert.equal(isChangedElsewhere({ code: 'permission-denied' }), true);
    assert.equal(isChangedElsewhere({ code: 'not-found' }), true);
    assert.equal(isChangedElsewhere({ code: 'unavailable' }), false);
    assert.equal(isChangedElsewhere(new Error('boom')), false);
    assert.equal(isChangedElsewhere(null), false);
  });
});

describe('undo journal (survives a reload)', () => {
  test('re-offers the remaining window and drops expired entries', () => {
    const storage = memoryStorage();
    pushJournal(storage, tick(), T0);
    assert.deepEqual(readJournal(storage, T0 + 3_000).map((entry) => entry.opId), ['op-1']);
    assert.equal(remainingMs(readJournal(storage, T0 + 3_000)[0], T0 + 3_000), 7_000);
    assert.deepEqual(readJournal(storage, T0 + UNDO_WINDOW_MS), []);
    assert.deepEqual(readJournal(storage, T0 + UNDO_WINDOW_MS + 1), []);
  });

  test('keeps one Undo per group: a newer tick replaces the older, a delete sits beside it', () => {
    const storage = memoryStorage();
    pushJournal(storage, tick(), T0);
    pushJournal(storage, remove(), T0 + 1_000);
    pushJournal(storage, tick({ opId: 'op-2', itemId: 'bread', name: 'Bread', expiresAt: T0 + 2_000 + UNDO_WINDOW_MS }), T0 + 2_000);
    assert.deepEqual(readJournal(storage, T0 + 2_000).map((entry) => entry.opId).sort(), ['op-2', 'restore-1']);
    assert.deepEqual(dropJournal(storage, 'op-2', T0 + 2_500).map((entry) => entry.opId), ['restore-1']);
    dropJournal(storage, 'restore-1', T0 + 2_500);
    assert.equal(storage.data.has(UNDO_JOURNAL_KEY), false, 'an empty journal is removed');
  });

  test('is scoped to the signed-in member and household', () => {
    const entries = [tick(), tick({ uid: 'alex', opId: 'op-a' }), tick({ householdId: 'h2', opId: 'op-h' })];
    assert.deepEqual(journalFor(entries, 'sam', 'h1').map((entry) => entry.opId), ['op-1']);
    assert.deepEqual(journalFor(entries, null, 'h1'), []);
    assert.deepEqual(journalFor(entries, 'sam', null), []);
  });

  test('never throws: missing, blocked, full or corrupt storage', () => {
    assert.deepEqual(readJournal(null, T0), []);
    assert.doesNotThrow(() => pushJournal(null, tick(), T0));
    const blocked: JournalStorage = {
      getItem: () => { throw new Error('SecurityError'); },
      setItem: () => { throw new Error('QuotaExceededError'); },
      removeItem: () => { throw new Error('SecurityError'); },
    };
    assert.deepEqual(readJournal(blocked, T0), []);
    assert.doesNotThrow(() => pushJournal(blocked, tick(), T0));
    assert.doesNotThrow(() => dropJournal(blocked, 'op-1', T0));
    const corrupt = memoryStorage();
    corrupt.setItem(UNDO_JOURNAL_KEY, '{not json');
    assert.deepEqual(readJournal(corrupt, T0), []);
    corrupt.setItem(UNDO_JOURNAL_KEY, JSON.stringify([{ group: 'shopping-tick', opId: 'x' }, tick(), { ...remove(), data: null }]));
    assert.deepEqual(readJournal(corrupt, T0).map((entry) => entry.opId), ['op-1'], 'malformed entries are skipped');
  });

  test('restore data round-trips dates and timestamps; other objects are dropped', () => {
    const createdAt = new Date('2026-11-01T09:30:00.000Z');
    const timestamp = { toMillis: () => createdAt.getTime() };
    const data = toJournalData({ name: 'Eggs', quantity: 2, createdAt, other: timestamp, weird: { nested: true }, gone: undefined, nothing: null });
    assert.deepEqual(JSON.parse(JSON.stringify(data)), data, 'JSON-safe');
    const back = fromJournalData(data);
    assert.deepEqual(back, { name: 'Eggs', quantity: 2, createdAt, other: createdAt, nothing: null });
  });
});

describe('restore document (Undo of a delete)', () => {
  test('keeps the adder, names the restorer, adds restoreOpId and drops writer-only stamps', () => {
    const snapshot = {
      name: 'Milk', quantity: 1, status: 'purchased', addedByUid: 'sam', purchaseOpId: 'op-1',
      purchasedByUid: 'alex', purchasedAt: 'ts', editedByUid: 'alex', editedAt: 'ts', undoOpId: 'op-0', restoreOpId: 'old',
    };
    assert.deepEqual(restoreItemData(snapshot, 'kim', 'restore-9'), {
      name: 'Milk', quantity: 1, status: 'purchased', addedByUid: 'sam', purchaseOpId: 'op-1', restoredByUid: 'kim', restoreOpId: 'restore-9',
    });
  });
});

describe('focus after a tick or delete (SH-26a)', () => {
  test('goes to the next row, else the previous, else nowhere', () => {
    assert.equal(nextFocusId(['a', 'b', 'c'], 'a'), 'b');
    assert.equal(nextFocusId(['a', 'b', 'c'], 'c'), 'b');
    assert.equal(nextFocusId(['a'], 'a'), null);
    assert.equal(nextFocusId(['a', 'b'], 'x'), null);
  });
});

describe('attribution (SH-28b)', () => {
  const names = memberNameMap([
    { uid: 'sam', displayName: 'Sam Member' },
    { uid: 'alex', displayName: 'alex@example.test' },
    { uid: 'kim' },
    { displayName: 'No uid' },
  ]);

  test('display names only, never emails; "Member" otherwise', () => {
    assert.equal(names.get('sam'), 'Sam');
    assert.equal(names.get('alex'), 'Member');
    assert.equal(names.get('kim'), 'Member');
    assert.equal(names.size, 3);
  });

  test('"Sam added · 2d"', () => {
    const createdAt = new Date(T0 - 2 * 86_400_000 - 5_000);
    assert.equal(attributionLabel({ addedByUid: 'sam', createdAt, currentUid: 'kim', names, now: T0 }), 'Sam added · 2d');
    assert.equal(attributionLabel({ addedByUid: 'kim', createdAt, currentUid: 'kim', names, now: T0 }), 'You added · 2d');
    assert.equal(attributionLabel({ addedByUid: 'stranger', createdAt, currentUid: 'kim', names, now: T0 }), 'Member added · 2d');
    assert.equal(attributionLabel({ addedByUid: 'sam', createdAt: undefined, currentUid: 'kim', names, now: T0 }), 'Sam added');
    assert.equal(attributionLabel({ addedByUid: undefined, createdAt, currentUid: 'kim', names, now: T0 }), null, 'older items show nothing');
  });

  test('short ages and timestamp shapes', () => {
    assert.equal(shortAge(T0 - 30_000, T0), 'now');
    assert.equal(shortAge(T0 + 60_000, T0), 'now', 'a clock ahead is never negative');
    assert.equal(shortAge(T0 - 5 * 60_000, T0), '5m');
    assert.equal(shortAge(T0 - 3 * 3_600_000, T0), '3h');
    assert.equal(shortAge(T0 - 13 * 86_400_000, T0), '13d');
    assert.equal(shortAge(T0 - 21 * 86_400_000, T0), '3w');
    assert.equal(toMillis({ toMillis: () => 5 }), 5);
    assert.equal(toMillis('2026-11-10T12:00:00.000Z'), T0);
    assert.equal(toMillis('not a date'), null);
    assert.equal(toMillis(new Date(Number.NaN)), null);
  });
});

describe('item edit (SH-8a)', () => {
  const item = { name: 'Milk', quantity: 1, category: 'Dairy' };

  test('writes only what changed; a rename gets its nameKey, a new category is manual', () => {
    assert.deepEqual(planItemEdit(item, { name: 'Milk', quantity: 1, category: 'Dairy' }), { changes: {} });
    assert.deepEqual(planItemEdit(item, { name: '  oat   milk ', quantity: 1, category: 'Dairy' }), { changes: { name: 'Oat milk', nameKey: 'oat milk' } });
    assert.deepEqual(planItemEdit(item, { name: 'Milk', quantity: 3, category: 'Drinks' }), { changes: { quantity: 3, category: 'Drinks', categorySource: 'manual' } });
  });

  test('invalid values are explained', () => {
    assert.deepEqual(planItemEdit(item, { name: '   ', quantity: 1, category: 'Dairy' }), { error: { field: 'name', message: 'Item name is required.' } });
    const long = planItemEdit(item, { name: 'x'.repeat(200), quantity: 1, category: 'Dairy' });
    assert.ok('changes' in long && (long.changes.name ?? '').length <= 120, 'a long name is cut to the limit');
    assert.equal('error' in planItemEdit(item, { name: 'Milk', quantity: 0, category: 'Dairy' }), true);
    assert.equal('error' in planItemEdit(item, { name: 'Milk', quantity: 1.5, category: 'Dairy' }), true);
    assert.equal('error' in planItemEdit(item, { name: 'Milk', quantity: 1000, category: 'Dairy' }), true);
    assert.equal('error' in planItemEdit(item, { name: 'Milk', quantity: Number.NaN, category: 'Dairy' }), true);
  });
});
