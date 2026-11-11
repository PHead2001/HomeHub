import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { addAndReportDetached, failedEntries, notAddedNotice, type NotAddedNotice, type QuickAddOutcome } from '../../src/lib/shopping/quick-add-outcome';

const milk = { name: 'Milk', quantity: 1 };
const eggs = { name: 'Eggs', quantity: 1 };

describe('quick-add outcome reporting (shared by the quick-add field and the usual chips)', () => {
  test('failed entries and the "Not added" notice', () => {
    assert.deepEqual(failedEntries(null, [milk, eggs]), [milk, eggs], 'nothing saved: all failed');
    assert.deepEqual(failedEntries({ failed: [eggs] }, [milk, eggs]), [eggs]);
    assert.equal(notAddedNotice('Weekly', []), null);
    assert.deepEqual(notAddedNotice('Weekly', [milk, eggs]), { variant: 'destructive', title: 'Not added to Weekly', description: 'Milk, Eggs' });
  });

  test('a detached add reports an immediate failure, a thrown save, and a pending entry that fails later', async () => {
    const notices: NotAddedNotice[] = [];
    const notify = (notice: NotAddedNotice) => notices.push(notice);

    await addAndReportDetached('Weekly', [milk], async () => ({ failed: [milk] }), notify);
    assert.deepEqual(notices.map((notice) => notice.description), ['Milk']);

    await addAndReportDetached('Weekly', [eggs], async () => { throw new Error('offline'); }, notify);
    await addAndReportDetached('Weekly', [eggs], async () => null, notify);
    assert.equal(notices.length, 3);

    let settle: (late: typeof milk[]) => void = () => undefined;
    const outcome: QuickAddOutcome = { failed: [], pending: { entries: [milk], label: 'Still sending…', settled: new Promise((resolve) => { settle = resolve; }) } };
    await addAndReportDetached('Weekly', [milk], async () => outcome, notify);
    assert.equal(notices.length, 3, 'nothing yet while pending');
    settle([milk]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(notices.length, 4);
    assert.equal(notices[3].title, 'Not added to Weekly');

    // A save that succeeds says nothing here (the list reports what was added).
    await addAndReportDetached('Weekly', [milk], async () => ({ failed: [] }), notify);
    assert.equal(notices.length, 4);
  });

  test('the usual chips and the quick-add field use the shared reporting', () => {
    const read = (...parts: string[]) => readFileSync(join(__dirname, '..', '..', 'src', ...parts), 'utf8');
    assert.match(read('components', 'shopping', 'use-trip-flow.tsx'), /onAdd=\{\(name\) => void addAndReportDetached\(/);
    const bar = read('components', 'shopping', 'quick-add-bar.tsx');
    assert.match(bar, /failedEntries\(outcome, entries\)/);
    assert.equal(bar.match(/notAddedNotice\(listName/g)?.length, 2);
  });
});
