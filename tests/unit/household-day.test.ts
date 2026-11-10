import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';
import {
  deviceTimeZone,
  householdDayStart,
  householdDayZone,
  householdToday,
  msUntilHouseholdMidnight,
  watchHouseholdDay,
} from '../../src/lib/household-day';
import { computeChoreFacts } from '../../src/lib/dashboard/facts';

// Auckland is UTC+13 in November (daylight time): its midnight is 11:00 UTC the day before.
const AUCKLAND = 'Pacific/Auckland';
// A zone whose day differs from Auckland's at that instant, whatever the device zone is.
const CHICAGO = 'America/Chicago';

describe('householdToday', () => {
  it('uses the household zone, not the device zone', () => {
    const instant = new Date('2026-11-09T10:59:59Z');
    assert.equal(householdToday(AUCKLAND, instant), '2026-11-09');
    assert.equal(householdToday(AUCKLAND, new Date('2026-11-09T11:00:00Z')), '2026-11-10');
    assert.equal(householdToday(CHICAGO, new Date('2026-11-09T11:00:00Z')), '2026-11-09');
  });

  it('falls back to the server default zone only when the household has none (or an invalid one)', () => {
    const instant = new Date('2026-11-09T11:00:00Z');
    const fallback = householdToday('America/Chicago', instant);
    assert.equal(householdToday(null, instant), fallback);
    assert.equal(householdToday(undefined, instant), fallback);
    assert.equal(householdToday('Not/AZone', instant), fallback);
    assert.equal(householdDayZone(null), 'America/Chicago');
    assert.ok(deviceTimeZone().length > 0);
    assert.equal(householdDayZone(AUCKLAND), AUCKLAND);
  });

  it('knows when the household day starts and how long until the next one', () => {
    assert.equal(householdDayStart(AUCKLAND, '2026-11-10').toISOString(), '2026-11-09T11:00:00.000Z');
    assert.equal(msUntilHouseholdMidnight(AUCKLAND, new Date('2026-11-09T10:00:00Z')), 60 * 60_000);
    // Across a DST change (Chicago falls back on 2026-11-01): that day has 25 hours.
    assert.equal(msUntilHouseholdMidnight(CHICAGO, new Date('2026-11-01T05:00:00Z')), 25 * 60 * 60_000);
  });
});

describe('watchHouseholdDay', () => {
  afterEach(() => mock.timers.reset());

  const environment = () => ({
    now: () => new Date(),
    window: new EventTarget(),
    document: Object.assign(new EventTarget(), { visibilityState: 'visible' }),
  });

  it('rolls over at the household midnight, in a zone other than the device', () => {
    mock.timers.enable({ apis: ['setTimeout', 'Date'], now: new Date('2026-11-09T10:59:00Z') });
    const days: string[] = [];
    const stop = watchHouseholdDay(AUCKLAND, (day) => days.push(day), environment());
    mock.timers.tick(59_000);
    assert.deepEqual(days, [], 'still the 9th in Auckland');
    mock.timers.tick(2_000);
    assert.deepEqual(days, ['2026-11-10']);
    // And again the next household midnight, 24 h later.
    mock.timers.tick(24 * 60 * 60_000);
    assert.deepEqual(days, ['2026-11-10', '2026-11-11']);
    stop();
  });

  it('re-checks on visibilitychange, pageshow and online (wake from sleep)', () => {
    mock.timers.enable({ apis: ['setTimeout', 'Date'], now: new Date('2026-11-09T10:00:00Z') });
    const env = environment();
    let clock = new Date('2026-11-09T10:00:00Z');
    env.now = () => clock;
    const days: string[] = [];
    const stop = watchHouseholdDay(AUCKLAND, (day) => days.push(day), env);
    // The device slept through midnight: its timers did not fire, but the clock moved on.
    clock = new Date('2026-11-09T12:00:00Z');
    env.document.dispatchEvent(new Event('visibilitychange'));
    assert.deepEqual(days, ['2026-11-10']);
    clock = new Date('2026-11-10T12:00:00Z');
    env.window.dispatchEvent(new Event('pageshow'));
    clock = new Date('2026-11-11T12:00:00Z');
    env.window.dispatchEvent(new Event('online'));
    assert.deepEqual(days, ['2026-11-10', '2026-11-11', '2026-11-12']);
    stop();
    clock = new Date('2026-11-12T12:00:00Z');
    env.window.dispatchEvent(new Event('online'));
    assert.equal(days.length, 3, 'stopped');
  });
});

describe('chore facts in the household day (D-6)', () => {
  const viewer = { uid: 'u1', email: 'sam@example.test' };
  const rooms = [{ id: 'kitchen', name: 'Kitchen' }];
  // 11:30 UTC on the 9th: already the 10th in Auckland, still the 9th in Chicago.
  const now = new Date('2026-11-09T11:30:00Z');

  it('counts due today and done today by the household zone', () => {
    const chores = [
      { id: 'a', task: 'Dishes', originalDueDate: '2026-11-10', dueDate: '2026-11-10', isCompleted: false, roomIds: ['kitchen'], assignedToEmail: viewer.email },
      // Finished 11:10 UTC: after Auckland's midnight, before Chicago's.
      { id: 'b', task: 'Trash', originalDueDate: '2026-11-09', dueDate: '2026-11-09', isCompleted: true, completedAt: '2026-11-09T11:10:00Z', roomIds: ['kitchen'] },
    ];
    const auckland = computeChoreFacts(chores, rooms, viewer, now, new Set(), AUCKLAND);
    assert.deepEqual([auckland.todayTotal, auckland.todayDone, auckland.mineDueToday], [2, 1, 1]);

    const chicago = computeChoreFacts(chores, rooms, viewer, now, new Set(), CHICAGO);
    // In Chicago it is the 9th: Trash is today's and done, Dishes is tomorrow's.
    assert.deepEqual([chicago.todayTotal, chicago.todayDone, chicago.mineDueToday], [1, 1, 0]);
  });
});
