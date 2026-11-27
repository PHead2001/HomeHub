import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { MAX_MISSED_ENTRIES, missedDayExpired, readMissedEntries, recentMissed, withMissedEntries } from '../../functions/src/shared/missed';

const entry = (day: string, key = `t|general|${day}`) => ({ key, day, task: 'Trash', assignedToUid: 'sam', assignedToDisplayName: 'Sam' });

describe('missed days (CH-7)', () => {
  test('a missed day expires after a week, not before', () => {
    assert.equal(missedDayExpired('2026-11-20', '2026-11-27'), false, 'exactly 7 days ago stays');
    assert.equal(missedDayExpired('2026-11-19', '2026-11-27'), true);
  });

  test('entries are read defensively, kept once per key, for 28 days, latest first, capped', () => {
    assert.deepEqual(readMissedEntries({ entries: [entry('2026-11-10'), { key: 3 }, null, { key: 'x', day: 'nope' }] }), [entry('2026-11-10')]);
    assert.deepEqual(readMissedEntries(null), []);
    const next = withMissedEntries([entry('2026-10-20'), entry('2026-11-10')], [entry('2026-11-12'), entry('2026-11-10')], '2026-11-27');
    assert.deepEqual(next.map(e => e.day), ['2026-11-12', '2026-11-10'], 'older than 28 days dropped, duplicate key kept once');
    const many = Array.from({ length: MAX_MISSED_ENTRIES + 5 }, (_, i) => entry('2026-11-20', `t|r${i}|2026-11-20`));
    assert.equal(withMissedEntries([], many, '2026-11-27').length, MAX_MISSED_ENTRIES);
  });

  test('the summary counts the last two weeks', () => {
    assert.deepEqual(recentMissed([entry('2026-11-19'), entry('2026-11-13'), entry('2026-11-12')], '2026-11-27').map(e => e.day), ['2026-11-19', '2026-11-13']);
  });
});
