import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { addDaysToKey, choreDueKey, completionInstant, dayKey, diffDayKeys, weekStartKey, type ChoreRecord } from '../../src/lib/chores/dates';
import { POINTS, chorePoints, closedWeekSummary, computeChoreStats, podiumWeekStart, weekPodium } from '../../src/lib/chores/stats';

// Local times keep the tests independent of the machine's timezone.
const at = (y: number, m: number, d: number, h = 12) => new Date(y, m - 1, d, h);
const iso = (y: number, m: number, d: number, h = 12) => at(y, m, d, h).toISOString();
const key = (y: number, m: number, d: number) => dayKey(at(y, m, d));

let n = 0;
const chore = (overrides: Partial<ChoreRecord>): ChoreRecord => ({
  id: `c${n++}`,
  task: 'Chore',
  assignedToEmail: 'sam@example.test',
  dueDate: iso(2026, 8, 5),
  originalDueDate: key(2026, 8, 5),
  isCompleted: false,
  ...overrides,
});

const members = [
  { email: 'sam@example.test', uid: 'sam', name: 'Sam' },
  { email: 'alex@example.test', uid: 'alex', name: 'Alex' },
  { email: 'kid@example.test', uid: 'kid', name: 'Kid', role: 'child' },
];

describe('chore dates', () => {
  it('reads the due day from originalDueDate, then dueDate', () => {
    assert.equal(choreDueKey({ originalDueDate: '2026-08-07', dueDate: iso(2026, 8, 1) }), '2026-08-07');
    assert.equal(choreDueKey({ originalDueDate: '', dueDate: '2026-08-03' }), '2026-08-03');
    assert.equal(choreDueKey({ originalDueDate: '', dueDate: iso(2026, 8, 4) }), key(2026, 8, 4));
    assert.equal(choreDueKey({ originalDueDate: '', dueDate: 'garbage' }), '');
  });

  it('prefers the server completion stamp over the client time', () => {
    const server = at(2026, 8, 6, 9);
    assert.deepEqual(completionInstant({ isCompleted: true, completedAt: iso(2026, 7, 1), completedAtServer: { toDate: () => server } }), server);
    assert.equal(completionInstant({ isCompleted: true, completedAt: iso(2026, 7, 1), completedAtServer: { seconds: server.getTime() / 1000 } })?.getTime(), server.getTime());
    assert.equal(completionInstant({ isCompleted: true, completedAt: iso(2026, 7, 1) })?.getTime(), at(2026, 7, 1).getTime());
    assert.equal(completionInstant({ isCompleted: false, completedAt: iso(2026, 7, 1) }), null);
    assert.equal(completionInstant({ isCompleted: true, completedAt: null }), null);
  });

  it('does day arithmetic across months and finds Monday', () => {
    assert.equal(addDaysToKey('2026-07-31', 1), '2026-08-01');
    assert.equal(diffDayKeys('2026-07-30', '2026-08-02'), 3);
    assert.equal(weekStartKey('2026-08-06'), '2026-08-03'); // Thursday -> Monday
    assert.equal(weekStartKey('2026-08-09'), '2026-08-03'); // Sunday belongs to the same week
    assert.equal(weekStartKey('2026-08-03'), '2026-08-03');
  });
});

describe('chore points', () => {
  it('scores base, sub-tasks and on-time completion', () => {
    assert.equal(chorePoints(chore({})), 0);
    assert.equal(chorePoints(chore({ isCompleted: true, completedAt: iso(2026, 8, 5) })), POINTS.base + POINTS.onTime);
    assert.equal(chorePoints(chore({ isCompleted: true, completedAt: iso(2026, 8, 6), subTasks: ['a', 'b'] })), POINTS.base + 2 * POINTS.perSubTask);
  });
});

describe('computeChoreStats', () => {
  const now = at(2026, 8, 6, 18); // Thursday; week is Aug 3-9
  const chores = [
    chore({ assignedToEmail: 'sam@example.test', isCompleted: true, completedAt: iso(2026, 8, 4), originalDueDate: key(2026, 8, 4) }),
    chore({ assignedToEmail: 'sam@example.test', isCompleted: true, completedAt: iso(2026, 8, 5), originalDueDate: key(2026, 8, 5) }),
    chore({ assignedToEmail: 'sam@example.test', isCompleted: true, completedAt: iso(2026, 8, 6), originalDueDate: key(2026, 8, 6) }),
    chore({ assignedToEmail: 'alex@example.test', isCompleted: true, completedAt: iso(2026, 8, 5), originalDueDate: key(2026, 8, 5) }),
    chore({ assignedToEmail: 'alex@example.test', originalDueDate: key(2026, 8, 7) }),
    // Last week: counts toward totals and streak days, not this week.
    chore({ assignedToEmail: 'alex@example.test', isCompleted: true, completedAt: iso(2026, 7, 30), originalDueDate: key(2026, 7, 30) }),
    chore({ assignedToEmail: 'kid@example.test', isCompleted: true, completedAt: iso(2026, 8, 6), originalDueDate: key(2026, 8, 6) }),
    // Someone who left: ignored for members, still part of this week's total.
    chore({ assignedToEmail: 'gone@example.test', isCompleted: true, completedAt: iso(2026, 8, 6), originalDueDate: key(2026, 8, 6) }),
    // A completion "in the future" (clock skew) never counts.
    chore({ assignedToEmail: 'alex@example.test', isCompleted: true, completedAt: iso(2026, 8, 8), originalDueDate: key(2026, 8, 8) }),
  ];
  const stats = computeChoreStats(chores, members, now);
  const sam = stats.members.find(m => m.uid === 'sam')!;
  const alex = stats.members.find(m => m.uid === 'alex')!;
  const kid = stats.members.find(m => m.uid === 'kid')!;

  it('uses a Monday-Sunday week', () => {
    assert.equal(stats.weekStart, '2026-08-03');
    assert.equal(stats.weekEnd, '2026-08-09');
  });

  it('adds up weekly points and completions per assignee', () => {
    assert.equal(sam.weekCompleted, 3);
    assert.equal(sam.weekPoints, 3 * (POINTS.base + POINTS.onTime));
    assert.equal(alex.weekCompleted, 1);
    assert.equal(alex.totalPoints, 2 * (POINTS.base + POINTS.onTime));
  });

  it('counts fair streaks over due days (CH-19)', () => {
    assert.equal(sam.streak, 3);
    assert.equal(sam.streakActiveToday, true);
    // Alex had chores due Jul 30 and Aug 5, both done on time; the days between had
    // nothing due, so they neither break nor extend the streak. Nothing is due today.
    assert.equal(alex.streak, 2);
    assert.equal(alex.streakActiveToday, true);
  });

  it('gives child accounts stickers', () => {
    assert.equal(kid.stickerMode, true);
    assert.equal(kid.stickers, 1);
  });

  it('counts assigned chores of current members only and contribution from completions (CH-21)', () => {
    // The chore assigned to someone who left is not part of the week.
    assert.equal(stats.weekTotal, 7);
    assert.equal(sam.weekAssigned, 3);
    assert.equal(sam.weekAssignedDone, 3);
    assert.equal(stats.weekCompletedTotal, 5);
    assert.equal(sam.contributionShare, 3 / 5);
    const sum = stats.members.reduce((total, member) => total + member.contributionShare, 0);
    assert.ok(Math.abs(sum - 1) < 1e-9, 'rings add up to 100%');
  });

  it('ranks the closed week podium by points', () => {
    const summary = closedWeekSummary(chores, members, '2026-08-03', 0);
    const podium = weekPodium(summary);
    assert.equal(podium[0].uid, 'sam');
    assert.ok(podium.length <= 3);
    assert.ok(podium.every(member => member.points > 0));
  });

  it('rolls the week and streaks over when today changes', () => {
    const nextMonday = computeChoreStats(chores, members, at(2026, 8, 10, 23));
    assert.equal(nextMonday.weekStart, '2026-08-10');
    assert.ok(nextMonday.members.every(member => member.weekPoints === 0));
    // Sam had nothing due after Aug 6, so the streak holds; Alex missed Aug 7.
    assert.equal(nextMonday.members.find(m => m.uid === 'sam')!.streak, 3);
    assert.equal(nextMonday.members.find(m => m.uid === 'alex')!.streak, 1);
  });

  it('shows the podium for the closed week on Monday and Tuesday only (CH-21)', () => {
    assert.equal(podiumWeekStart('2026-08-10'), '2026-08-03');
    assert.equal(podiumWeekStart('2026-08-11'), '2026-08-03');
    assert.equal(podiumWeekStart('2026-08-12'), null);
    assert.equal(podiumWeekStart('2026-08-09'), null, 'never before the week ends');
  });
});
