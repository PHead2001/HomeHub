import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { addScannedProduct, dialogAfterScan, type ScanAddDeps } from '../../src/lib/shopping/scan-add';
import type { AddEntry, EntryOutcome } from '../../src/lib/shopping/add-items';

const entry = { name: 'E2E Yogurt Multipack', quantity: 1 as const, size: 450, sizeUnit: 'g' };

function outcome(state: EntryOutcome['state'], settled: 'saved' | 'failed' = 'saved'): EntryOutcome {
  return { entry: { name: entry.name, quantity: 1 }, name: entry.name, merged: false, state, category: 'Dairy', settled: Promise.resolve(settled), ...(state === 'failed' ? { error: new Error('nope') } : {}) };
}

function recorder(result: EntryOutcome[] | null) {
  const calls: { added: { entries: AddEntry[]; options: Record<string, unknown> }[]; reported: EntryOutcome[][]; failed: unknown[] } = { added: [], reported: [], failed: [] };
  const deps: ScanAddDeps<{ imageUrl?: string }> = {
    add: async (entries, options) => {
      calls.added.push({ entries, options });
      return result;
    },
    report: (outcomes) => calls.reported.push(outcomes),
    fail: (error) => calls.failed.push(error),
  };
  return { calls, deps };
}

describe('a scanned product is added without the Add Item form (S7)', () => {
  test('Scan to tick\'s Add: one package, no category from the form, reported honestly', async () => {
    // The Add Item form (a typed draft with a chosen category) is not an input at
    // all: the only things that run are the save path and the reporting.
    const form = { name: 'half-typed draft', category: 'Bakery', resets: 0 };
    const { calls, deps } = recorder([outcome('saved')]);
    assert.equal(await addScannedProduct(entry, { barcode: '009900045000' }, deps), 'saved');
    assert.deepEqual(calls.added, [{
      entries: [{ name: entry.name, quantity: 1, size: 450, sizeUnit: 'g' }],
      options: { selectedCategory: undefined, libraryItem: undefined, barcode: '009900045000' },
    }]);
    assert.equal(calls.reported.length, 1);
    assert.deepEqual(form, { name: 'half-typed draft', category: 'Bakery', resets: 0 });
  });

  test('the scanner inside Add Item passes the category chosen when the scan started', async () => {
    const { calls, deps } = recorder([outcome('saved')]);
    await addScannedProduct(entry, { barcode: '1', selectedCategory: 'Dairy' }, deps);
    assert.equal(calls.added[0].options.selectedCategory, 'Dairy');
  });

  test('a pending save is reported once it is confirmed; a failure is reported, not swallowed', async () => {
    let pending = recorder([outcome('sending', 'saved')]);
    assert.equal(await addScannedProduct(entry, { barcode: '1' }, pending.deps), 'saved');
    assert.equal(pending.calls.reported[0][0].state, 'saved');
    pending = recorder([outcome('uncertain', 'failed')]);
    assert.equal(await addScannedProduct(entry, { barcode: '1' }, pending.deps), 'failed');
    assert.equal(pending.calls.reported.length, 0);
    const failed = recorder([outcome('failed')]);
    assert.equal(await addScannedProduct(entry, { barcode: '1' }, failed.deps), 'failed');
    assert.equal(failed.calls.failed.length, 1);
    assert.equal((await addScannedProduct(entry, { barcode: '1' }, recorder(null).deps)), null);
  });

  test('after a scan inside Add Item the draft is never reset; only the same opening closes', () => {
    const started = { session: 3, listId: 'a', revision: 7 };
    assert.deepEqual(dialogAfterScan(started, { ...started, open: true }), { reset: false, close: true });
    assert.deepEqual(dialogAfterScan(started, { ...started, revision: 8, open: true }), { reset: false, close: false });
    assert.deepEqual(dialogAfterScan(started, { ...started, session: 4, open: true }), { reset: false, close: false });
    assert.deepEqual(dialogAfterScan(started, { ...started, listId: 'b', open: true }), { reset: false, close: false });
    assert.deepEqual(dialogAfterScan(started, { ...started, open: false }), { reset: false, close: false });
  });
});
