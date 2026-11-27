import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { weekStartKey, type ChoreRecord } from '../../src/lib/chores/dates';
import { isWeekStartsOn, lastWeekday, readWeekStartsOn, weekdayLabels } from '../../src/lib/chores/week-start';
import { computeChoreStats, podiumWeekStart } from '../../src/lib/chores/stats';
import { startOfWeek } from '../../src/components/household/household-model';
import { weekStartDay } from '../../functions/src/shared/chore-points';

// The household's "Week starts on" setting (audit CA-16; HO-19 reuses it).
const chore = (overrides: Partial<ChoreRecord>): ChoreRecord => ({
  id: 'c1', task: 'Empty dishwasher', assignedToUid: 'sam', dueDate: '2026-08-01', originalDueDate: '2026-08-01', isCompleted: false, ...overrides,
});
const members = [{ uid: 'sam', name: 'Sam' }, { uid: 'ada', name: 'Ada' }];

describe('week start (CA-16)', () => {
  it('reads the stored value, Monday when missing or invalid', () => {
    assert.equal(readWeekStartsOn(0), 0);
    assert.equal(readWeekStartsOn(1), 1);
    assert.equal(readWeekStartsOn(undefined), 1);
    assert.equal(readWeekStartsOn('0'), 1);
    assert.equal(readWeekStartsOn(6), 1);
    assert.equal(isWeekStartsOn(0), true);
    assert.equal(isWeekStartsOn(2), false);
    assert.deepEqual(weekdayLabels(0), ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']);
    assert.deepEqual(weekdayLabels(1), ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']);
    assert.equal(lastWeekday(0), 6);
    assert.equal(lastWeekday(1), 0);
  });

  it('the leaderboard week and podium follow the setting', () => {
    const done = chore({ id: 'sun', originalDueDate: '2026-08-02', isCompleted: true, completedAt: '2026-08-02T15:00:00.000Z', completedByUid: 'sam' });
    // Mon Aug 3 2026: a Sunday week already holds Sunday's chore; a Monday week does not.
    const now = new Date(2026, 7, 3, 12);
    assert.equal(computeChoreStats([done], members, now, { weekStartsOn: 0 }).members.find(m => m.uid === 'sam')!.weekCompleted, 1);
    assert.equal(computeChoreStats([done], members, now, { weekStartsOn: 1 }).members.find(m => m.uid === 'sam')!.weekCompleted, 0);
    assert.equal(computeChoreStats([], members, now, { weekStartsOn: 0 }).weekStart, '2026-08-02');
    // One options object with the household day and zone (CH-10) and the week start.
    const household = { today: '2026-08-03', timeZone: 'America/Chicago' };
    assert.equal(computeChoreStats([done], members, now, { ...household, weekStartsOn: 0 }).members.find(m => m.uid === 'sam')!.weekCompleted, 1);
    assert.equal(computeChoreStats([done], members, now, { ...household, weekStartsOn: 1 }).weekStart, '2026-08-03');
    // The closed week's podium shows on the first two days of the household's next week.
    assert.equal(podiumWeekStart('2026-08-03', 1), '2026-07-27', 'Monday after a Monday week');
    assert.equal(podiumWeekStart('2026-08-04', 1), '2026-07-27');
    assert.equal(podiumWeekStart('2026-08-05', 1), null);
    assert.equal(podiumWeekStart('2026-08-02', 0), '2026-07-26', 'Sunday after a Sunday week');
    assert.equal(podiumWeekStart('2026-08-03', 0), '2026-07-26');
    assert.equal(podiumWeekStart('2026-08-04', 0), null);
    assert.equal(podiumWeekStart('2026-08-03'), '2026-07-27', 'Monday by default');
    assert.equal(startOfWeek(new Date(2026, 7, 1, 15), 0).getDate(), 26);
    assert.equal(startOfWeek(new Date(2026, 7, 1, 15)).getDate(), 27);
  });
});

describe('week keys', () => {
  it('upkeep\'s closed-week snapshot (CH-29) uses the same week as the page', () => {
    for (const day of ['2026-08-01', '2026-08-02', '2026-08-03', '2026-08-08']) {
      assert.equal(weekStartDay(day), weekStartKey(day));
      assert.equal(weekStartDay(day, 0), weekStartKey(day, 0));
    }
  });

  it('weekStartKey follows the setting', () => {
    // Sat Aug 1 2026.
    assert.equal(weekStartKey('2026-08-01'), '2026-07-27');
    assert.equal(weekStartKey('2026-08-01', 0), '2026-07-26');
    assert.equal(weekStartKey('2026-08-02', 0), '2026-08-02', 'a Sunday starts its own week');
    assert.equal(weekStartKey('2026-08-02', 1), '2026-07-27', 'and ends a Monday week');
  });
});
