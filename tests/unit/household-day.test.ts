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

  it('finds the next midnight across DST in the household zone (MA-1)', () => {
    // Chicago springs forward on 2026-03-08: midnight CST (06:00Z) to the next midnight CDT (05:00Z) is 23 hours.
    assert.equal(msUntilHouseholdMidnight(CHICAGO, new Date('2026-03-08T06:00:00Z')), 23 * 60 * 60_000);
    // Half an hour before that day starts, the next midnight is the 8th's, not the 9th's.
    assert.equal(msUntilHouseholdMidnight(CHICAGO, new Date('2026-03-08T05:30:00Z')), 30 * 60_000);
    // Just after 2 a.m. CST jumps to 3 a.m. CDT (08:00Z), 21 hours are left of the 8th.
    assert.equal(msUntilHouseholdMidnight(CHICAGO, new Date('2026-03-08T08:00:00Z')), 21 * 60 * 60_000);
    // Chicago falls back on 2026-11-01: midnight CDT (05:00Z); the repeated 1 a.m. hour makes it 25 hours.
    assert.equal(msUntilHouseholdMidnight(CHICAGO, new Date('2026-11-01T07:30:00Z')), (22 * 60 + 30) * 60_000);
    // East of UTC: Sydney springs forward on 2026-10-04 (midnight AEST is 14:00Z the day before), a 23-hour day.
    assert.equal(msUntilHouseholdMidnight('Australia/Sydney', new Date('2026-10-03T14:00:00Z')), 23 * 60 * 60_000);
    // ... and falls back on 2026-04-05, a 25-hour day.
    assert.equal(msUntilHouseholdMidnight('Australia/Sydney', new Date('2026-04-04T13:00:00Z')), 25 * 60 * 60_000);
    // A half-hour zone east of UTC without DST: Kolkata's midnight is 18:30Z the day before.
    assert.equal(msUntilHouseholdMidnight('Asia/Kolkata', new Date('2026-11-24T18:00:00Z')), 30 * 60_000);
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

  for (const [zone, from, expected] of [
    ['America/Chicago', '2026-03-07T12:00:00Z', ['2026-03-08', '2026-03-09', '2026-03-10']],
    ['America/Chicago', '2026-10-31T12:00:00Z', ['2026-11-01', '2026-11-02', '2026-11-03']],
    ['Australia/Sydney', '2026-10-03T00:00:00Z', ['2026-10-04', '2026-10-05', '2026-10-06']],
    ['Australia/Sydney', '2026-04-04T00:00:00Z', ['2026-04-05', '2026-04-06', '2026-04-07']],
  ] as const) {
    it(`rolls over once per day across the DST change in ${zone} from ${from.slice(0, 10)}, never skipping or doubling`, () => {
      mock.timers.enable({ apis: ['setTimeout', 'Date'], now: new Date(from) });
      const days: string[] = [];
      const stop = watchHouseholdDay(zone, (day) => days.push(day), environment());
      // Three days in quarter-hour steps: the timer (capped at an hour) fires many times.
      for (let minute = 0; minute < 3 * 24 * 60; minute += 15) mock.timers.tick(15 * 60_000);
      assert.deepEqual(days, expected);
      stop();
    });
  }

  it('re-checks when the window regains focus', () => {
    mock.timers.enable({ apis: ['setTimeout', 'Date'], now: new Date('2026-11-09T10:00:00Z') });
    const env = environment();
    let clock = new Date('2026-11-09T10:00:00Z');
    env.now = () => clock;
    const days: string[] = [];
    const stop = watchHouseholdDay(AUCKLAND, (day) => days.push(day), env);
    clock = new Date('2026-11-09T12:00:00Z');
    env.window.dispatchEvent(new Event('focus'));
    assert.deepEqual(days, ['2026-11-10']);
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
