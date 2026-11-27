import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DAILY_POINT_CAP, POINTS, choreBasePoints, earnsPoints, pointsLedger, weekStartDay } from '../../functions/src/shared/chore-points';
import { localDay } from '../../functions/src/shared/calendar';
import { computeChoreStats, fairStreak, missedHorizon } from '../../src/lib/chores/stats';
import { MAX_MISSED_ENTRIES } from '../../functions/src/shared/missed';
import type { ChoreRecord } from '../../src/lib/chores/dates';

// CH-19 fair streaks, CH-20 farm caps, CH-21 the This week card. Household days in
// America/Chicago (D-6), so the tests do not depend on the machine's zone.
const ZONE = 'America/Chicago';
const dayOf = (instant: Date) => localDay(instant, ZONE);
// Noon in Chicago on a given day (UTC-5 in summer).
const noon = (day: string) => new Date(`${day}T17:00:00Z`).toISOString();
const members = [
  { uid: 'kid', name: 'Kid', role: 'child' },
  { uid: 'mom', name: 'Mom', role: 'owner' },
];
let n = 0;
const chore = (overrides: Partial<ChoreRecord>): ChoreRecord => ({
  id: `c${n++}`, task: 'Chore', assignedToUid: 'kid', dueDate: '2026-08-05', originalDueDate: '2026-08-05', isCompleted: false, ...overrides,
} as ChoreRecord);
const done = (day: string, overrides: Partial<ChoreRecord> = {}) =>
  chore({ originalDueDate: day, dueDate: day, isCompleted: true, completedAt: noon(day), completedByUid: 'kid', ...overrides });
const stats = (chores: ChoreRecord[], today: string) =>
  computeChoreStats(chores, members, new Date(noon(today)), { today, timeZone: ZONE });
const kidOf = (result: ReturnType<typeof stats>) => result.members.find(m => m.uid === 'kid')!;

describe('CH-20: what earns points', () => {
  it('a one-time chore you add for yourself earns nothing; others, templates and older chores do', () => {
    assert.equal(earnsPoints({ sourceType: 'temporary', createdByUid: 'kid' }, 'kid'), false);
    assert.equal(earnsPoints({ sourceType: 'temporary', createdByUid: 'mom' }, 'kid'), true, 'added by someone else');
    assert.equal(earnsPoints({ sourceType: 'temporary' }, 'kid'), true, 'written before createdByUid existed');
    assert.equal(earnsPoints({ templateId: 't1', createdByUid: 'kid' }, 'kid'), true, 'a generated day of a repeating chore');
    assert.equal(earnsPoints({ templateId: 't1', sourceType: 'template', createdByUid: 'kid' }, 'kid'), true, 'from the library');
  });

  it('scores base, steps and on time on household days', () => {
    // 23:30 in Chicago on Aug 5 is Aug 6 in UTC: still on time for an Aug 5 chore.
    const late = chore({ isCompleted: true, completedAt: '2026-08-06T04:30:00Z', subTasks: ['a', 'b'] });
    assert.equal(choreBasePoints(late, dayOf), POINTS.base + 2 * POINTS.perSubTask + POINTS.onTime);
  });

  it('self-made chores count as done but earn no points or stickers', () => {
    const result = kidOf(stats([
      done('2026-08-05', { sourceType: 'temporary', createdByUid: 'kid' }),
      done('2026-08-05', { sourceType: 'temporary', createdByUid: 'mom' }),
    ], '2026-08-06'));
    assert.equal(result.weekCompleted, 2);
    assert.equal(result.weekPoints, POINTS.base + POINTS.onTime);
    assert.equal(result.stickers, 1);
  });

  it('caps each day at DAILY_POINT_CAP', () => {
    const many = Array.from({ length: 12 }, () => done('2026-08-04', { templateId: 't', subTasks: Array(20).fill('s') }));
    const ledger = pointsLedger(many, members, dayOf, '2026-08-06');
    assert.ok(ledger.get('kid')!.get('2026-08-04')!.raw > DAILY_POINT_CAP);
    const result = kidOf(stats([...many, done('2026-08-05', { templateId: 't' })], '2026-08-06'));
    assert.equal(result.weekPoints, DAILY_POINT_CAP + POINTS.base + POINTS.onTime);
    assert.equal(result.totalPoints, result.weekPoints);
  });

  it('finds Monday like the client', () => {
    assert.equal(weekStartDay('2026-08-09'), '2026-08-03');
    assert.equal(weekStartDay('2026-08-03'), '2026-08-03');
  });
});

describe('CH-19: fair streaks', () => {
  it('days with nothing due neither break nor extend a streak (Mon/Wed/Fri chores)', () => {
    const result = kidOf(stats([done('2026-08-03'), done('2026-08-05'), done('2026-08-07')], '2026-08-09'));
    assert.equal(result.streak, 3);
    assert.equal(result.streakActiveToday, true);
  });

  it('a day with a chore left open ends the streak, and a late completion does not repair it', () => {
    const lateDone = chore({ originalDueDate: '2026-08-04', dueDate: '2026-08-04', isCompleted: true, completedAt: noon('2026-08-06'), completedByUid: 'kid' });
    assert.equal(kidOf(stats([done('2026-08-03'), lateDone, done('2026-08-05')], '2026-08-06')).streak, 1);
    assert.equal(kidOf(stats([done('2026-08-03'), chore({ originalDueDate: '2026-08-04' }), done('2026-08-05')], '2026-08-06')).streak, 1);
  });

  it('today counts once everything due today is done, and an open chore today does not break it yet', () => {
    const waiting = kidOf(stats([done('2026-08-05'), chore({ originalDueDate: '2026-08-06' })], '2026-08-06'));
    assert.deepEqual([waiting.streak, waiting.streakActiveToday], [1, false]);
    const finished = kidOf(stats([done('2026-08-05'), done('2026-08-06')], '2026-08-06'));
    assert.deepEqual([finished.streak, finished.streakActiveToday], [2, true]);
  });

  it('a chore someone else did still keeps the assignee\'s day', () => {
    assert.equal(kidOf(stats([done('2026-08-05', { completedByUid: 'mom' })], '2026-08-06')).streak, 1);
  });

  it('a missed day upkeep expired (CH-7, stats/missed-recent) breaks the streak like the open chore did', () => {
    const chores = [done('2026-08-03'), done('2026-08-05')];
    const missed = [{ key: 't|general|2026-08-04', day: '2026-08-04', assignedToUid: 'kid' }];
    const run = (entries: typeof missed) => kidOf(computeChoreStats(chores, members, new Date(noon('2026-08-06')), { today: '2026-08-06', timeZone: ZONE, missed: entries })).streak;
    assert.equal(run([]), 2);
    assert.equal(run(missed), 1);
    // Someone else's missed day, a future day, or one whose chore still exists (counted once) change nothing.
    assert.equal(run([{ ...missed[0], assignedToUid: 'mom' }]), 2);
    assert.equal(run([{ ...missed[0], day: '2026-08-09' }]), 2);
    const stillHeld = [...chores, chore({ originalDueDate: '2026-08-04', occurrenceKey: 't|general|2026-08-04' })];
    assert.equal(kidOf(computeChoreStats(stillHeld, members, new Date(noon('2026-08-06')), { today: '2026-08-06', timeZone: ZONE, missed })).streak, 1);
    assert.equal(kidOf(computeChoreStats(stillHeld.map(c => c.occurrenceKey ? { ...c, isCompleted: true, completedAt: noon('2026-08-04'), completedByUid: 'kid' } : c), members, new Date(noon('2026-08-06')), { today: '2026-08-06', timeZone: ZONE, missed })).streak, 3, 'the chore decides while it exists');
  });

  it('when stats/missed-recent is at its cap, a streak ends at the oldest day it vouches for', () => {
    const days = ['2026-08-01', '2026-08-02', '2026-08-03', '2026-08-04', '2026-08-05'];
    const chores = days.map(day => done(day));
    const full = (oldest: string) => [
      ...Array.from({ length: MAX_MISSED_ENTRIES - 1 }, (_, i) => ({ key: `x|r${i}|2026-08-05`, day: '2026-08-05', assignedToUid: 'mom' })),
      { key: `x|old|${oldest}`, day: oldest, assignedToUid: 'mom' },
    ];
    const run = (missed: ReadonlyArray<{ key: string; day: string; assignedToUid: string }>) =>
      kidOf(computeChoreStats(chores, members, new Date(noon('2026-08-06')), { today: '2026-08-06', timeZone: ZONE, missed })).streak;
    assert.equal(run([]), 5, 'below the cap the list vouches for the whole lookback');
    assert.equal(run(full('2026-08-02')), 3, 'Aug 2 and earlier are unknown: the streak ends after Aug 2');
    assert.equal(missedHorizon(full('2026-08-02'), '2026-05-08'), '2026-08-03');
    assert.equal(missedHorizon(full('2026-01-01'), '2026-05-08'), '2026-05-08', 'never earlier than the lookback');
    assert.equal(missedHorizon(full('2026-08-02').slice(1), '2026-05-08'), '2026-05-08');
  });

  it('fairStreak works on the due-day map directly', () => {
    const days = new Map([['2026-08-01', { total: 2, done: 2 }], ['2026-08-03', { total: 1, done: 0 }], ['2026-08-04', { total: 1, done: 1 }]]);
    assert.deepEqual(fairStreak(days, '2026-08-04'), { streak: 1, activeToday: true });
  });
});

describe('CH-21: the This week card', () => {
  it('leaves out chores of people who are not members, so contribution adds up to 100%', () => {
    const result = stats([
      done('2026-08-04'),
      done('2026-08-04', { assignedToUid: 'mom', completedByUid: 'mom' }),
      done('2026-08-04', { assignedToUid: 'gone', completedByUid: 'gone' }),
      chore({ assignedToUid: 'kid', originalDueDate: '2026-08-07' }),
    ], '2026-08-06');
    assert.equal(result.weekTotal, 3);
    assert.equal(result.weekCompletedTotal, 2);
    const kid = kidOf(result);
    assert.deepEqual([kid.weekAssigned, kid.weekAssignedDone, kid.contributionShare], [2, 1, 0.5]);
  });
});
