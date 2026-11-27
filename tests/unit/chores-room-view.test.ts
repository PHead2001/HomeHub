import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { doneTodayEntries, isRoomView, roomSummary } from '../../src/lib/chores/room-view';
import type { ChoreRecord } from '../../src/lib/chores/dates';

const chore = (id: string, fields: Partial<ChoreRecord>): ChoreRecord => ({
  id, task: id, dueDate: '2026-11-27T12:00:00.000Z', originalDueDate: '2026-11-27', isCompleted: false, ...fields,
} as ChoreRecord);

const dayOf = (instant: Date) => instant.toISOString().slice(0, 10);

describe('room view (CH-13)', () => {
  it('lists the chores completed today, newest first, with who did them', () => {
    const chores = [
      chore('early', { isCompleted: true, completedAt: '2026-11-27T08:00:00.000Z', completedByUid: 'u1', completedByName: 'Old name' }),
      chore('late', { isCompleted: true, completedAt: '2026-11-27T15:00:00.000Z', completedByName: 'Kid' }),
      chore('yesterday', { isCompleted: true, completedAt: '2026-11-26T15:00:00.000Z', completedByUid: 'u1' }),
      chore('open', {}),
    ];
    const entries = doneTodayEntries(chores, '2026-11-27', dayOf, uid => (uid === 'u1' ? 'Sam' : undefined));
    assert.deepEqual(entries, [
      { id: 'late', task: 'late', byUid: null, byName: 'Kid' },
      { id: 'early', task: 'early', byUid: 'u1', byName: 'Sam' },
    ]);
  });

  it('never shows an email as who did it', () => {
    const entries = doneTodayEntries([
      chore('a', { isCompleted: true, completedAt: '2026-11-27T08:00:00.000Z', completedByName: 'sam@example.com' }),
    ], '2026-11-27', dayOf, () => undefined);
    assert.equal(entries[0].byName, null);
  });

  it('counts today\'s work before the Overdue filter, and says when nothing is overdue (review of PR #262)', () => {
    assert.equal(roomSummary(0, null), 'Nothing left to do here today.');
    assert.equal(roomSummary(3, null), '3 to do');
    // Overdue on, today's chores still open: never "nothing left".
    assert.equal(roomSummary(2, 0), '2 to do · nothing overdue');
    assert.equal(roomSummary(2, 1), '2 to do · 1 overdue');
    const page = readFileSync(resolve(process.cwd(), 'src/components/chore-chart-client.tsx'), 'utf8');
    assert.match(page, /openCount=\{todoAll\.length\}/);
    assert.match(page, /overdueCount=\{filters\.due === 'overdue' \? todoEntries\.length : null\}/);
  });

  it('is on for one room or Around the house, off for All Rooms', () => {
    assert.equal(isRoomView('all'), false);
    assert.equal(isRoomView('general'), true);
    assert.equal(isRoomView('kitchen'), true);
  });

  it('puts the leaderboard ribbon at the top and keeps the header to one row (CH-18)', () => {
    const page = readFileSync(resolve(process.cwd(), 'src/components/chore-chart-client.tsx'), 'utf8');
    // The ribbon renders before the filters; the full card beside the list only on wide screens.
    assert.ok(page.indexOf('<LeaderboardRibbon') < page.indexOf('chores-filter-overdue'));
    assert.match(page, /hidden min-w-0 lg:sticky lg:top-20 lg:block/);
    assert.match(page, /aria-label="Chore Manager"/);
    assert.match(page, /aria-label="Calendar"/);
  });
});
