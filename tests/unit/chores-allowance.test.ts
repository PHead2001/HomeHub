import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { centsPerPointFrom, readWeekSummary, weekSnapshotDocId, weekSummary } from '../../functions/src/shared/chore-points';
import { localDay } from '../../functions/src/shared/calendar';
import { parseCentsPerPoint } from '../../src/lib/chores/allowance';
import { closedWeekSummary, formatPayout } from '../../src/lib/chores/stats';
import type { ChoreRecord } from '../../src/lib/chores/dates';

// CH-29: allowance from points, snapshotted per closed week.
const ZONE = 'America/Chicago';
const members = [
  { uid: 'kid', name: 'Kid', role: 'child' },
  { uid: 'mom', name: 'mom@example.test', role: 'owner' },
];
const done = (day: string, uid: string) => ({
  id: `${uid}-${day}`, task: 'Chore', templateId: 't', assignedToUid: uid, originalDueDate: day, dueDate: day,
  isCompleted: true, completedAt: new Date(`${day}T17:00:00Z`).toISOString(), completedByUid: uid,
}) as unknown as ChoreRecord;

describe('CH-29: allowance from points', () => {
  it('reads the rate defensively: whole cents 0-100', () => {
    assert.equal(centsPerPointFrom({ centsPerPoint: 5 }), 5);
    for (const bad of [{ centsPerPoint: 101 }, { centsPerPoint: -1 }, { centsPerPoint: 2.5 }, { centsPerPoint: '5' }, null, undefined]) {
      assert.equal(centsPerPointFrom(bad), 0);
    }
    assert.equal(parseCentsPerPoint(' 25 '), 25);
    assert.equal(parseCentsPerPoint('0'), 0);
    assert.equal(parseCentsPerPoint('101'), null);
    assert.equal(parseCentsPerPoint('2.5'), null);
    assert.equal(parseCentsPerPoint(''), null);
  });

  it('pays each member points x rate for the closed week, children included, never naming anyone by email', () => {
    const chores = [done('2026-08-03', 'kid'), done('2026-08-09', 'kid'), done('2026-08-04', 'mom'), done('2026-08-10', 'kid')];
    const summary = weekSummary(chores, members, '2026-08-03', instant => localDay(instant, ZONE), 5);
    assert.deepEqual(summary.members.map(m => [m.uid, m.name, m.points, m.payoutCents, m.stickerMode]), [
      ['kid', 'Kid', 30, 150, true],
      ['mom', 'Member', 15, 75, false],
    ]);
    assert.equal(summary.weekEnd, '2026-08-09');
    assert.deepEqual(closedWeekSummary(chores, members, '2026-08-03', 5, ZONE), summary, 'the page computes the same as upkeep');
    assert.equal(formatPayout(150), '$1.50');
  });

  it('round-trips a stored snapshot and rejects other documents', () => {
    const summary = weekSummary([done('2026-08-04', 'kid')], members, '2026-08-03', instant => localDay(instant, ZONE), 10);
    assert.deepEqual(readWeekSummary({ kind: 'week', ...summary, createdAt: 'x' }), summary);
    assert.equal(readWeekSummary({ year: 2026, completed: 3 }), null);
    assert.equal(weekSnapshotDocId('2026-08-03'), 'week-2026-08-03');
  });

  it('settings merge, so the leaderboard switch keeps the rate', () => {
    const hook = readFileSync('src/components/chores/use-chore-settings.ts', 'utf8');
    assert.match(hook, /\{ merge: true \}/);
    const rules = readFileSync('firestore.rules', 'utf8');
    assert.match(rules, /hasOnly\(\['leaderboardEnabled', 'centsPerPoint', 'updatedAt'\]\)/);
  });
});
