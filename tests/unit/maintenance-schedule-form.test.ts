import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { planDownscale } from '../../src/lib/images/downscale';
import { receiptImagePreparation, RECEIPT_READ_MAX_BYTES } from '../../src/lib/maintenance/receipt-fill';
import { applyScheduleRowEdit, type CalendarDueRow, type RowInterval } from '../../src/lib/maintenance/schedule-form';

// PR #211 review: a suggested due date follows the anchor (never a typed one), and receipt images
// the reader cannot take are always re-encoded.
type Row = CalendarDueRow & { frequencyType: 'days' | 'weeks' | 'months' | 'years' | ''; intervalValue: string };
const yearly = (extra: Partial<Row> = {}): Row => ({
  frequencyType: 'years', intervalValue: '1', anchor: '', anchorMonth: '', anchorDay: '', nextDueDate: '', ...extra,
});
const intervalOf = (row: Row): RowInterval => ({ unit: row.frequencyType || undefined, value: Number(row.intervalValue) || undefined });
const TODAY = '2026-09-20';

describe('calendar due dates in the schedule rows', () => {
  test('checking the calendar box and then picking October 1 saves Oct 1 2026, not a September date', () => {
    let row = applyScheduleRowEdit(yearly(), { anchor: 'calendar' }, intervalOf, TODAY);
    assert.equal(row.nextDueGenerated, true, 'a date is suggested at once');
    row = applyScheduleRowEdit(row, { anchorMonth: '10' }, intervalOf, TODAY);
    row = applyScheduleRowEdit(row, { anchorDay: '1' }, intervalOf, TODAY);
    assert.equal(row.nextDueDate, '2026-10-01');
    assert.equal(row.nextDueGenerated, true);
    // The day first, then the month: the same answer.
    let other = applyScheduleRowEdit(yearly(), { anchor: 'calendar' }, intervalOf, TODAY);
    other = applyScheduleRowEdit(other, { anchorDay: '1' }, intervalOf, TODAY);
    other = applyScheduleRowEdit(other, { anchorMonth: '10' }, intervalOf, TODAY);
    assert.equal(other.nextDueDate, '2026-10-01');
  });

  test('a typed due date is never overwritten by anchor or interval changes', () => {
    let row = applyScheduleRowEdit(yearly(), { anchor: 'calendar' }, intervalOf, TODAY);
    row = applyScheduleRowEdit(row, { nextDueDate: '2027-01-15' }, intervalOf, TODAY);
    assert.equal(row.nextDueGenerated, false);
    for (const patch of [{ anchorMonth: '10' }, { anchorDay: '1' }, { intervalValue: '2' }, { anchor: 'completion' as const }]) {
      row = applyScheduleRowEdit(row, patch, intervalOf, TODAY);
      assert.equal(row.nextDueDate, '2027-01-15');
    }
    // A stored schedule's date (not generated) stays too when the box is checked.
    assert.equal(applyScheduleRowEdit(yearly({ nextDueDate: '2026-12-01' }), { anchor: 'calendar', anchorMonth: '10' }, intervalOf, TODAY).nextDueDate, '2026-12-01');
  });

  test('clearing the date lets the form suggest one again; unrelated edits change nothing', () => {
    let row = applyScheduleRowEdit(yearly({ anchor: 'calendar', anchorMonth: '10', anchorDay: '1', nextDueDate: '2027-02-02' }), { nextDueDate: '' }, intervalOf, TODAY);
    assert.deepEqual([row.nextDueDate, row.nextDueGenerated], ['2026-10-01', true]);
    row = applyScheduleRowEdit(row, { scheduleName: 'Gutters' } as Partial<Row>, intervalOf, TODAY);
    assert.equal(row.nextDueDate, '2026-10-01');
  });

  test("a preset's suggested date follows an interval change; unchecking the calendar falls back to today + interval", () => {
    const preset = yearly({ frequencyType: 'months', intervalValue: '3', nextDueDate: '2026-12-20', nextDueGenerated: true });
    assert.equal(applyScheduleRowEdit(preset, { intervalValue: '6' }, intervalOf, TODAY).nextDueDate, '2027-03-20');
    let row = applyScheduleRowEdit(yearly(), { anchor: 'calendar', anchorMonth: '10', anchorDay: '1' }, intervalOf, TODAY);
    assert.equal(row.nextDueDate, '2026-10-01');
    row = applyScheduleRowEdit(row, { anchor: 'completion' }, intervalOf, TODAY);
    assert.deepEqual([row.nextDueDate, row.nextDueGenerated], ['2027-09-20', true]);
    // Nothing to work it out from: a generated date is cleared rather than left stale.
    assert.deepEqual([applyScheduleRowEdit(row, { intervalValue: '' }, intervalOf, TODAY).nextDueDate], ['']);
  });
});

describe('receipt images the reader cannot take are re-encoded', () => {
  test('GIF, HEIC and AVIF are always converted; small JPEG/PNG/WebP go as they are', () => {
    for (const type of ['image/gif', 'image/heic', 'image/heif', 'image/avif']) {
      assert.equal(receiptImagePreparation(type, 10_000), 'convert', type);
    }
    assert.equal(receiptImagePreparation('image/jpeg', 10_000), 'as_is');
    assert.equal(receiptImagePreparation('image/png', RECEIPT_READ_MAX_BYTES + 1), 'redraw');
  });

  test('forced: a GIF or a small HEIC within the limits is redrawn as JPEG instead of kept', () => {
    const small = { width: 800, height: 600, bytes: 50_000 };
    assert.deepEqual(planDownscale({ ...small, type: 'image/gif' }, { maxEdge: 1600, maxBytes: RECEIPT_READ_MAX_BYTES }), { action: 'keep' });
    for (const type of ['image/gif', 'image/heic', 'image/avif', '']) {
      const plan = planDownscale({ ...small, type }, { maxEdge: 1600, maxBytes: RECEIPT_READ_MAX_BYTES, force: true });
      assert.ok(plan.action === 'redraw' && plan.type === 'image/jpeg' && plan.width === 800 && plan.height === 600, type);
    }
  });
});
