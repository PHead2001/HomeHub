import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  FEED_PRESS_IDLE,
  FEED_PRESS_MS,
  FEED_PRESS_TAP_MS,
  feedPressIndicator,
  feedPressIsDeliberate,
  feedPressJustCompleted,
  feedPressMoved,
  feedPressReducer,
  feedPressRelease,
  opensEarlierFromKey,
  type FeedPressEvent,
  type FeedPressState,
} from '../../src/lib/pets/feed-press';
import {
  checkEarlierTime,
  earlierChipLabel,
  earlierChoice,
  earlierDayOf,
  earlierFeedPlan,
  earlierInstant,
  earlierPlanLine,
  earlierWhenLabel,
  householdWallTime,
} from '../../src/lib/pets/feed-earlier';

// "Feed earlier" (owner request): press and hold Feed opens "When did <pet> eat?"; the
// dialog's times are household wall times, and it names the meal the time counts for.

const run = (events: FeedPressEvent[], start: FeedPressState = FEED_PRESS_IDLE) => {
  let state = start;
  let opened = 0;
  for (const event of events) {
    const next = feedPressReducer(state, event);
    if (feedPressJustCompleted(state, next)) opened += 1;
    state = next;
  }
  return { state, opened };
};

describe('feed press: tap, hold, cancel', () => {
  it('holds for 500 ms and treats a press under 200 ms as a tap', () => {
    assert.equal(FEED_PRESS_MS, 500);
    assert.equal(FEED_PRESS_TAP_MS, 200);
  });

  it('a quick tap feeds now and never shows progress', () => {
    const { state, opened } = run([{ type: 'press', at: 0 }, { type: 'tick', at: 120 }]);
    assert.equal(opened, 0);
    assert.equal(feedPressIsDeliberate(state), false);
    assert.equal(feedPressIndicator(state, false).shown, false);
    assert.equal(feedPressRelease(state), 'tap');
  });

  it('holding opens the dialog exactly once per press, and the release does not feed', () => {
    const { state, opened } = run([
      { type: 'press', at: 0 },
      { type: 'tick', at: 300 },
      { type: 'tick', at: 500 },
      { type: 'tick', at: 900 },
      { type: 'press', at: 950 },
      { type: 'tick', at: 1400 },
    ]);
    assert.equal(state.phase, 'complete');
    assert.equal(opened, 1);
    assert.equal(feedPressRelease(state), 'none');
  });

  it('a hold released before the end does nothing (no feed, no dialog)', () => {
    const held = run([{ type: 'press', at: 0 }, { type: 'tick', at: 350 }]);
    assert.equal(feedPressIsDeliberate(held.state), true);
    assert.equal(feedPressRelease(held.state), 'none');
    const after = run([{ type: 'release' }, { type: 'tick', at: 2000 }], held.state);
    assert.equal(after.state.phase, 'idle');
    assert.equal(held.opened + after.opened, 0);
  });

  it('cancel (moved, scrolled, pointer cancel, Escape) never opens', () => {
    const { state, opened } = run([{ type: 'press', at: 0 }, { type: 'tick', at: 450 }, { type: 'cancel' }, { type: 'tick', at: 800 }]);
    assert.equal(state.phase, 'idle');
    assert.equal(opened, 0);
  });

  it('a new press after a release can open again', () => {
    const { opened } = run([
      { type: 'press', at: 0 }, { type: 'tick', at: 500 }, { type: 'release' },
      { type: 'press', at: 1000 }, { type: 'tick', at: 1500 },
    ]);
    assert.equal(opened, 2);
  });

  it('the fill sweeps from the tap threshold; reduced motion shows a still indicator and the end state', () => {
    const { state } = run([{ type: 'press', at: 0 }, { type: 'tick', at: 350 }]);
    const moving = feedPressIndicator(state, false);
    assert.equal(moving.shown, true);
    assert.equal(moving.still, false);
    assert.ok(Math.abs(moving.fill - 0.5) < 1e-9);
    assert.deepEqual(feedPressIndicator(state, true), { shown: true, fill: 0, still: true });
    assert.deepEqual(feedPressIndicator({ phase: 'complete' }, true), { shown: true, fill: 1, still: true });
    assert.equal(feedPressIndicator(run([{ type: 'press', at: 0 }, { type: 'tick', at: 150 }]).state, true).shown, false);
  });

  it('cancels a press that moves more than 10 px', () => {
    assert.equal(feedPressMoved({ x: 0, y: 0 }, { x: 6, y: 6 }), false);
    assert.equal(feedPressMoved({ x: 0, y: 0 }, { x: 0, y: 11 }), true);
  });

  it('Shift+Enter (only) opens the dialog from the keyboard', () => {
    assert.equal(opensEarlierFromKey({ key: 'Enter', shiftKey: true }), true);
    assert.equal(opensEarlierFromKey({ key: 'Enter', shiftKey: false }), false);
    assert.equal(opensEarlierFromKey({ key: 'Enter', shiftKey: true, ctrlKey: true }), false);
    assert.equal(opensEarlierFromKey({ key: ' ', shiftKey: true }), false);
  });
});

const CHICAGO = 'America/Chicago';

describe('earlier times in the household zone', () => {
  it('labels the quick choices', () => {
    assert.deepEqual([15, 30, 60, 120].map(earlierChipLabel), ['15 min ago', '30 min ago', '1 h ago', '2 h ago']);
  });

  it('a quick choice is to the minute, in the household zone, never the device zone', () => {
    const now = new Date('2026-11-19T15:42:30Z'); // 9:42:30 am in Chicago
    const choice = earlierChoice(15, now, CHICAGO);
    assert.equal(choice.at.toISOString(), '2026-11-19T15:27:00.000Z');
    assert.equal(choice.time, '09:27');
    assert.equal(choice.day, 'today');
    // The same instant for a household in Tokyo reads 0:27 am the next day there.
    assert.equal(earlierChoice(15, now, 'Asia/Tokyo').time, '00:27');
  });

  it('across household midnight a choice lands on yesterday', () => {
    const now = new Date('2026-11-19T06:20:00Z'); // 12:20 am in Chicago
    const choice = earlierChoice(30, now, CHICAGO);
    assert.equal(choice.day, 'yesterday');
    assert.equal(choice.time, '23:50');
    assert.equal(earlierInstant('yesterday', '23:50', now, CHICAGO)?.toISOString(), '2026-11-19T05:50:00.000Z');
    assert.equal(earlierInstant('today', '00:05', now, CHICAGO)?.toISOString(), '2026-11-19T06:05:00.000Z');
    assert.equal(earlierWhenLabel(choice.at, now, CHICAGO), 'Yesterday 11:50 pm');
    // A Tokyo household at that instant is mid-afternoon: still today.
    assert.equal(earlierChoice(30, now, 'Asia/Tokyo').day, 'today');
  });

  it('spring forward: a time in the gap moves forward, choices across it read the wall clock', () => {
    const now = new Date('2026-03-08T09:00:00Z'); // 4:00 am CDT, the gap was 2:00 to 3:00 am
    assert.equal(earlierChoice(60, now, CHICAGO).time, '03:00');
    assert.equal(earlierChoice(120, now, CHICAGO).time, '01:00');
    assert.equal(earlierInstant('today', '02:30', now, CHICAGO)?.toISOString(), '2026-03-08T08:30:00.000Z');
    assert.equal(earlierInstant('today', '01:30', now, CHICAGO)?.toISOString(), '2026-03-08T07:30:00.000Z');
  });

  it('fall back: a typed time that happens twice is the first; a quick choice keeps its own instant', () => {
    const now = new Date('2026-11-01T09:00:00Z'); // 3:00 am CST, 1:00 to 2:00 am happened twice
    assert.equal(earlierInstant('today', '01:30', now, CHICAGO)?.toISOString(), '2026-11-01T06:30:00.000Z');
    const choice = earlierChoice(120, now, CHICAGO);
    assert.equal(choice.at.toISOString(), '2026-11-01T07:00:00.000Z');
    assert.equal(choice.time, '01:00');
    assert.equal(householdWallTime(new Date('2026-11-01T06:00:00Z'), CHICAGO), '01:00');
  });

  it('applies the backdated form limits: future refused, within a minute live, earlier backdated, before yesterday refused', () => {
    const now = new Date('2026-11-19T15:42:30Z');
    assert.deepEqual(checkEarlierTime(null, now, CHICAGO), { ok: false, reason: 'invalid' });
    assert.deepEqual(checkEarlierTime(new Date(now.getTime() + 2 * 60_000), now, CHICAGO), { ok: false, reason: 'future' });
    const soon = new Date(now.getTime() + 30_000);
    assert.deepEqual(checkEarlierTime(soon, now, CHICAGO), { ok: true, at: soon });
    const justNow = new Date(now.getTime() - 30_000);
    assert.deepEqual(checkEarlierTime(justNow, now, CHICAGO), { ok: true, at: justNow });
    const earlier = new Date(now.getTime() - 5 * 60_000);
    assert.deepEqual(checkEarlierTime(earlier, now, CHICAGO), { ok: true, at: earlier, backdatedAt: earlier });
    // Yesterday 12:00 am Chicago is allowed; a minute before it is not.
    const yesterdayStart = new Date('2026-11-18T06:00:00Z');
    assert.equal(checkEarlierTime(yesterdayStart, now, CHICAGO).ok, true);
    assert.deepEqual(checkEarlierTime(new Date(yesterdayStart.getTime() - 60_000), now, CHICAGO), { ok: false, reason: 'too-old' });
    // A future time on "today" as typed in the field.
    assert.deepEqual(checkEarlierTime(earlierInstant('today', '11:00', now, CHICAGO), now, CHICAGO), { ok: false, reason: 'future' });
    assert.equal(earlierDayOf(new Date('2026-11-17T12:00:00Z'), now, CHICAGO), null);
  });
});

describe('the meal an earlier time counts for', () => {
  const slots = [
    { id: 'breakfast', name: 'Breakfast', time: '07:00', amount: 1, unit: 'Cups' },
    { id: 'dinner', name: 'Dinner', time: '18:00', amount: 0.5, unit: 'Cans', offDays: [0] },
  ];
  const pet = {
    name: 'Rex', foodSchedule: '', feedingsPerDay: 2, portionAmount: 1.5, portionUnit: 'Cups' as const,
    mealPlan: { slots, effectiveFrom: '2026-11-19', confirmedAt: null },
    // The plan before today: one supper at 5:00 pm.
    mealPlanHistory: [{ until: '2026-11-19', slots: [{ id: 'supper', name: 'Supper', time: '17:00', amount: 2, unit: 'Cups' }] }],
  };
  const now = new Date('2026-11-19T20:00:00Z'); // Thursday 2:00 pm in Chicago
  const at = (iso: string) => new Date(iso);

  it('names the meal from the plan in force on that household day', () => {
    const plan = earlierFeedPlan(pet, [], at('2026-11-19T13:30:00Z'), now, CHICAGO); // 7:30 am today
    assert.deepEqual(plan, { kind: 'slot', slotName: 'Breakfast', amount: 1, unit: 'Cups', alreadyFed: null });
    assert.equal(earlierPlanLine(plan, CHICAGO), 'Counts for breakfast: 1 cup.');
    // Yesterday the old plan applied: supper, 2 cups.
    const yesterday = earlierFeedPlan(pet, [], at('2026-11-18T23:30:00Z'), now, CHICAGO); // 5:30 pm yesterday
    assert.deepEqual(yesterday, { kind: 'slot', slotName: 'Supper', amount: 2, unit: 'Cups', alreadyFed: null });
  });

  it('after a fed breakfast an 8:00 am feeding counts for the next unfed meal (D-P5), as the status will', () => {
    const logs = [{ id: 'a', date: at('2026-11-19T13:10:00Z'), slotId: 'breakfast', loggedByName: 'Sam' }];
    const plan = earlierFeedPlan(pet, logs, at('2026-11-19T14:00:00Z'), now, CHICAGO); // 8:00 am
    assert.deepEqual(plan, { kind: 'slot', slotName: 'Dinner', amount: 0.5, unit: 'Cans', alreadyFed: null });
  });

  it('says when the meal already had a feeding and no unfed meal is left', () => {
    const logs = [
      { id: 'a', date: at('2026-11-19T13:10:00Z'), slotId: 'breakfast', loggedByName: 'Sam' },
      { id: 'b', date: at('2026-11-19T13:20:00Z'), slotId: 'dinner', loggedByName: 'Ana' },
    ];
    const plan = earlierFeedPlan(pet, logs, at('2026-11-19T14:00:00Z'), now, CHICAGO); // 8:00 am
    assert.equal(plan.kind, 'slot');
    assert.deepEqual(plan.kind === 'slot' && plan.alreadyFed, { at: at('2026-11-19T13:10:00Z'), by: 'Sam' });
    assert.equal(earlierPlanLine(plan, CHICAGO), 'Breakfast was already logged at 7:10 am by Sam, so this is an extra feeding: 1 cup.');
  });

  it('a time before an unattributed later feeding takes the meal first, as the status will', () => {
    // A feeding at 7:40 am with no slot (an older entry); the earlier time 7:05 am is breakfast, 7:40 becomes extra.
    const logs = [{ id: 'b', date: at('2026-11-19T13:40:00Z'), loggedByName: 'Sam' }];
    const plan = earlierFeedPlan(pet, logs, at('2026-11-19T13:05:00Z'), now, CHICAGO);
    assert.deepEqual(plan, { kind: 'slot', slotName: 'Breakfast', amount: 1, unit: 'Cups', alreadyFed: null });
  });

  it('an off-day meal is an extra; a pet without meal times logs its usual portion', () => {
    // Sunday Nov 22: dinner is off, breakfast is served; with only an off slot left, a Sunday-only pet:
    const sundayOnly = { ...pet, mealPlan: { slots: [slots[1]], effectiveFrom: '2026-11-01', confirmedAt: null }, mealPlanHistory: [] };
    const sunday = new Date('2026-11-23T02:00:00Z'); // Sunday 8:00 pm in Chicago
    const plan = earlierFeedPlan(sundayOnly, [], new Date('2026-11-23T00:30:00Z'), sunday, CHICAGO);
    assert.deepEqual(plan, { kind: 'off-day', amount: 0.5, unit: 'Cans' });
    assert.match(earlierPlanLine(plan, CHICAGO), /No meals were planned that day/);
    const legacy = { name: 'Pixel', foodSchedule: 'One can morning and evening', portionAmount: 1, portionUnit: 'Cans' as const };
    const plain = earlierFeedPlan(legacy, null, at('2026-11-19T13:30:00Z'), now, CHICAGO);
    assert.equal(plain.kind, 'legacy');
    assert.equal(earlierPlanLine(plain, CHICAGO), 'Logs 1 can.');
  });
});
