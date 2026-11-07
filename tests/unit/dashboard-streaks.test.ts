import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { computeChoreStats } from '../../src/lib/chores/stats';
import type { ChoreRecord } from '../../src/lib/chores/dates';
import { streakDaysLabel, streakMembersFrom, streakSummary, streakTileModel } from '../../src/lib/dashboard/streaks';
import { assembleDashboardFacts, HEALTH_FAILURE, STREAKS_FAILURE, type DashboardAccess, type DashboardRaw } from '../../src/lib/dashboard/assemble';

const now = new Date(2026, 7, 5, 12); // Wednesday
const iso = (day: number, hour = 9) => new Date(2026, 7, day, hour).toISOString();
const done = (id: string, email: string, day: number): ChoreRecord => ({
  id, task: id, assignedToEmail: email, dueDate: `2026-08-0${day}`, originalDueDate: `2026-08-0${day}`,
  isCompleted: true, completedAt: iso(day),
} as unknown as ChoreRecord);

const memberRecords = [
  { uid: 'a', email: 'alex@example.test', displayName: 'Alex', role: 'owner', status: 'active' },
  { uid: 'm', email: 'morgan@example.test', displayName: '  ', role: 'admin', status: 'active' },
  { uid: 's', email: 'sam@example.test', displayName: 'Sam', role: 'member' },
  { uid: 'p', email: 'pending@example.test', displayName: 'Pending', role: 'newuser', status: 'pending' },
  { uid: 'g', email: 'gone@example.test', displayName: 'Gone', role: 'member', status: 'removed' },
  { uid: 'x', displayName: 'No email' },
];

describe('household streaks tile', () => {
  it('uses approved members only, named like the Chores page', () => {
    assert.deepEqual(streakMembersFrom(memberRecords), [
      { email: 'alex@example.test', uid: 'a', name: 'Alex', role: 'owner' },
      { email: 'morgan@example.test', uid: 'm', name: 'morgan@example.test', role: 'admin' },
      { email: 'sam@example.test', uid: 's', name: 'Sam', role: 'member' },
    ]);
  });

  it('matches computeChoreStats exactly: longest first, active today breaks ties', () => {
    const chores = [
      done('a1', 'alex@example.test', 3), done('a2', 'alex@example.test', 4), done('a3', 'alex@example.test', 5),
      done('m1', 'morgan@example.test', 4),
      done('s1', 'sam@example.test', 5),
      done('p1', 'pending@example.test', 5),
    ];
    const stats = computeChoreStats(chores, streakMembersFrom(memberRecords), now);
    const model = streakTileModel(stats);
    assert.deepEqual(model.top.map((entry) => [entry.name, entry.streak, entry.activeToday]), [
      ['Alex', 3, true],
      ['Sam', 1, true],
      ['morgan@example.test', 1, false],
    ]);
    assert.equal(model.longest, 3);
    assert.equal(model.running, 3);
    // Pending members are not counted (as on the Chores page).
    assert.equal(model.weekCompleted, 5);
    assert.equal(streakSummary(model), 'Best streak: 3 days, Alex and 2 more on a streak. 5 chores done this week.');
    for (const entry of model.top) {
      assert.equal(entry.streak, stats.members.find((member) => member.email === entry.email)!.streak);
    }
  });

  it('has an empty state with nobody on a streak', () => {
    const model = streakTileModel(computeChoreStats([], streakMembersFrom(memberRecords), now));
    assert.deepEqual(model, { top: [], running: 0, longest: 0, weekCompleted: 0 });
    assert.equal(streakSummary(model), 'No streaks yet. 0 chores done this week.');
    assert.equal(streakSummary({ top: [{ email: 'm', name: 'Morgan', streak: 1, activeToday: false }], running: 1, longest: 1, weekCompleted: 1 }), 'Best streak: 1 day, Morgan. 1 chore done this week.');
    assert.equal(streakDaysLabel(1), '1 day');
    assert.equal(streakDaysLabel(4), '4 days');
  });
});

describe('assemble: streaks and home health', () => {
  const access: DashboardAccess = { chores: true, shopping: false, pantry: false, maintenance: true, pets: false, notifications: false };
  const context = { viewer: { uid: 'a', email: 'alex@example.test' }, now, timeZone: 'America/Chicago', recentFeedings: 12 };

  it('builds streaks once completions and members have answered, and hides them on failure', () => {
    const raw: DashboardRaw = { completedChores: [done('a1', 'alex@example.test', 5)] as never, members: memberRecords as never };
    assert.equal(assembleDashboardFacts(raw, new Set(), access, context).facts.streaks?.longest, 1);
    assert.equal(assembleDashboardFacts({ completedChores: raw.completedChores }, new Set(), access, context).facts.streaks, undefined);
    assert.equal(assembleDashboardFacts(raw, new Set([STREAKS_FAILURE]), access, context).facts.streaks, undefined);
    assert.equal(assembleDashboardFacts(raw, new Set(), { ...access, chores: false }, context).facts.streaks, undefined);
  });

  it('scores home health with Maintenance own formula, null with nothing to score', () => {
    const assets = [{
      id: 'hvac', name: 'Main HVAC', category: 'HVAC', status: 'active',
      schedules: [{ id: 'filter', mode: 'scheduled', scheduleName: 'Replace air filter', nextDueDate: '2026-05-01' }],
    }];
    const raw: DashboardRaw = { assets: assets as never, vehicles: [], logs: [] };
    const health = assembleDashboardFacts(raw, new Set(), access, context).facts.health;
    assert.ok(health && health.score < 100 && health.deductions.length > 0);
    assert.equal(assembleDashboardFacts({ assets: [], vehicles: [], logs: [] }, new Set(), access, context).facts.health, null);
    assert.equal(assembleDashboardFacts(raw, new Set([HEALTH_FAILURE]), access, context).facts.health, undefined);
    assert.equal(assembleDashboardFacts({ assets: raw.assets, vehicles: [] }, new Set(), access, context).facts.health, undefined, 'waits for logs');
  });
});
