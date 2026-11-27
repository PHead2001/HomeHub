import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { STREAK_LOOKBACK_DAYS } from '../../src/lib/chores/stats';
import { MAX_MISSED_ENTRIES, MISSED_KEEP_DAYS, effectiveDueDay, missedDayExpired, readMissedEntries, recentMissed, withMissedEntries } from '../../functions/src/shared/missed';

const entry = (day: string, key = `t|general|${day}`) => ({ key, day, task: 'Trash', assignedToUid: 'sam', assignedToDisplayName: 'Sam' });

describe('missed days (CH-7)', () => {
  test('a missed day expires after a week, not before', () => {
    assert.equal(missedDayExpired('2026-11-20', '2026-11-27'), false, 'exactly 7 days ago stays');
    assert.equal(missedDayExpired('2026-11-19', '2026-11-27'), true);
  });

  test('entries are read defensively, kept once per key, for 90 days (as far as streaks look), latest first, capped', () => {
    assert.deepEqual(readMissedEntries({ entries: [entry('2026-11-10'), { key: 3 }, null, { key: 'x', day: 'nope' }] }), [entry('2026-11-10')]);
    assert.deepEqual(readMissedEntries(null), []);
    const next = withMissedEntries([entry('2026-08-20'), entry('2026-10-20'), entry('2026-11-10')], [entry('2026-11-12'), entry('2026-11-10')], '2026-11-27');
    assert.deepEqual(next.map(e => e.day), ['2026-11-12', '2026-11-10', '2026-10-20'], 'older than 90 days dropped, duplicate key kept once');
    assert.equal(MISSED_KEEP_DAYS, STREAK_LOOKBACK_DAYS, 'kept as far back as fair streaks look (CH-19)');
    const many = Array.from({ length: MAX_MISSED_ENTRIES + 5 }, (_, i) => entry('2026-11-20', `t|r${i}|2026-11-20`));
    assert.equal(withMissedEntries([], many, '2026-11-27').length, MAX_MISSED_ENTRIES);
  });

  test('the due day is the moved day, else the due instant in the household zone', () => {
    assert.equal(effectiveDueDay({ originalDueDate: '2026-11-03', dueDate: '2026-10-15T05:00:00.000Z' }, 'America/Chicago'), '2026-11-03');
    assert.equal(effectiveDueDay({ dueDate: '2026-10-15T05:00:00.000Z' }, 'America/Chicago'), '2026-10-15');
    assert.equal(effectiveDueDay({}, 'America/Chicago'), null);
  });

  test('the summary counts the last two weeks', () => {
    assert.deepEqual(recentMissed([entry('2026-11-19'), entry('2026-11-13'), entry('2026-11-12')], '2026-11-27').map(e => e.day), ['2026-11-19', '2026-11-13']);
  });
});
