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
  feedPressSwallowsClick,
  opensEarlierFromKey,
  type FeedPressEvent,
  type FeedPressState,
} from '../../src/lib/pets/feed-press';
import {
  checkEarlierTime,
  chosenFeedPlan,
  liveFeedPlan,
  earlierChipLabel,
  earlierChoice,
  earlierDayOf,
  earlierFeedPlan,
  earlierInstant,
  earlierPlanLine,
  earlierWhenLabel,
  householdWallTime,
} from '../../src/lib/pets/feed-earlier';
import { attributeFeeds, earlierFeedSlot, feedsOnDay, planForDay } from '../../src/lib/pets/meal-plan';
import { planFeed } from '../../src/lib/pets/feed-plan';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

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

  it('a cancelled press never feeds, even before the tap threshold; only an early release is a tap (Codex P2)', () => {
    const early = run([{ type: 'press', at: 0 }, { type: 'tick', at: 80 }]).state;
    assert.equal(feedPressIsDeliberate(early), false);
    // Moved more than 10 px (or scrolled, left the button, Escape) at 80 ms: its click is swallowed.
    assert.equal(feedPressSwallowsClick(early, 'cancel'), true);
    // Let go at 80 ms without moving: a tap, its click feeds now.
    assert.equal(feedPressSwallowsClick(early, 'release'), false);
    const held = run([{ type: 'press', at: 0 }, { type: 'tick', at: 300 }]).state;
    assert.equal(feedPressSwallowsClick(held, 'release'), true);
    assert.equal(feedPressSwallowsClick(held, 'cancel'), true);
    assert.equal(feedPressSwallowsClick({ phase: 'complete' }, 'release'), true);
    // No press began here (a mouse click): the click goes through.
    assert.equal(feedPressSwallowsClick(FEED_PRESS_IDLE, 'cancel'), false);
    // The hook asks this at every end of a press.
    const hook = readFileSync(resolve(process.cwd(), 'src/components/pets/feed-press.tsx'), 'utf8');
    assert.match(hook, /if \(feedPressSwallowsClick\(machine\.current, type\)\) swallowClick\.current = true;/);
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

describe('the meal an earlier time counts for (lead decision: the window holding the chosen time)', () => {
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
  const now = new Date('2026-11-20T02:00:00Z'); // Thursday Nov 19, 8:00 pm in Chicago
  const at = (iso: string) => new Date(iso);
  const breakfastLog = { id: 'a', date: at('2026-11-19T13:10:00Z'), slotId: 'breakfast', loggedByName: 'Sam' }; // 7:10 am

  it('an offline earlier feeding (backdated, no meal named) is attributed by the earlier-time rule, never to dinner (Codex P2)', () => {
    // Saved offline at 8:00 am after breakfast: the queued log carries neither slotId nor extra.
    const offline = { id: 'off', date: at('2026-11-19T14:00:00Z'), backdated: true, loggedByName: 'Ana' };
    const plan = planForDay(pet, '2026-11-19');
    assert.equal(plan.kind, 'slots');
    if (plan.kind !== 'slots') return;
    const { bySlot, extras } = attributeFeeds(plan.slots, feedsOnDay([breakfastLog, offline], '2026-11-19', now, CHICAGO));
    const dinner = plan.slots.findIndex((slot) => slot.id === 'dinner');
    assert.equal(bySlot[dinner].length, 0);
    assert.deepEqual(extras.map((feed) => feed.id), ['off']);
    // Before breakfast was logged, the same offline entry counts for breakfast (its window).
    const alone = attributeFeeds(plan.slots, feedsOnDay([{ ...offline, date: at('2026-11-19T13:30:00Z') }], '2026-11-19', now, CHICAGO));
    const breakfast = plan.slots.findIndex((slot) => slot.id === 'breakfast');
    assert.deepEqual(alone.bySlot[breakfast].map((feed) => feed.id), ['off']);
    // A live (not backdated) feeding at 8:00 after breakfast still targets dinner (D-P5).
    const live = attributeFeeds(plan.slots, feedsOnDay([breakfastLog, { id: 'live', date: at('2026-11-19T14:00:00Z'), loggedByName: 'Ana' }], '2026-11-19', now, CHICAGO));
    assert.deepEqual(live.bySlot[dinner].map((feed) => feed.id), ['live']);
  });

  it('8:00 am after breakfast was logged is an extra feeding, not dinner', () => {
    const decision = earlierFeedSlot(pet, [breakfastLog], at('2026-11-19T14:00:00Z'), now, CHICAGO);
    assert.equal(decision.kind, 'extra');
    assert.equal(decision.kind === 'extra' && decision.reason, 'fed');
    assert.equal(decision.kind === 'extra' && decision.slot?.id, 'breakfast');
    const plan = earlierFeedPlan(pet, [breakfastLog], at('2026-11-19T14:00:00Z'), now, CHICAGO);
    assert.deepEqual(plan, { kind: 'extra', reason: 'fed', slotName: 'Breakfast', alreadyFed: { at: at('2026-11-19T13:10:00Z'), by: 'Sam' }, amount: 1, unit: 'Cups' });
    assert.equal(earlierPlanLine(plan, CHICAGO), 'Breakfast was already logged at 7:10 am by Sam, so this is an extra feeding, not another meal: 1 cup.');
  });

  it('7:30 pm with dinner unfed counts for dinner', () => {
    const plan = earlierFeedPlan(pet, [breakfastLog], at('2026-11-20T01:30:00Z'), now, CHICAGO);
    assert.deepEqual(plan, { kind: 'slot', slotName: 'Dinner', amount: 0.5, unit: 'Cans' });
    assert.equal(earlierPlanLine(plan, CHICAGO), 'Counts for dinner: 0.5 cans.');
  });

  it('7:30 am with breakfast unfed counts for breakfast', () => {
    assert.deepEqual(earlierFeedPlan(pet, [], at('2026-11-19T13:30:00Z'), now, CHICAGO), { kind: 'slot', slotName: 'Breakfast', amount: 1, unit: 'Cups' });
  });

  it('a time yesterday is judged with yesterday\'s plan', () => {
    const yesterday = earlierFeedPlan(pet, [], at('2026-11-18T23:30:00Z'), now, CHICAGO); // 5:30 pm Nov 18
    assert.deepEqual(yesterday, { kind: 'slot', slotName: 'Supper', amount: 2, unit: 'Cups' });
    // Yesterday's supper already logged: extra.
    const supperLog = { id: 's', date: at('2026-11-18T23:05:00Z'), loggedByName: 'Ana' };
    assert.equal(earlierFeedPlan(pet, [supperLog], at('2026-11-18T23:30:00Z'), now, CHICAGO).kind, 'extra');
  });

  it('before the first window opens, and on an off-day, it is an extra', () => {
    const early = earlierFeedPlan(pet, [], at('2026-11-19T10:00:00Z'), now, CHICAGO); // 4:00 am, breakfast window opens 5:00
    assert.equal(early.kind === 'extra' && early.reason, 'no-window');
    assert.match(earlierPlanLine(early, CHICAGO), /No meal is planned around then/);
    const sundayOnly = { ...pet, mealPlan: { slots: [slots[1]], effectiveFrom: '2026-11-01', confirmedAt: null }, mealPlanHistory: [] };
    const sunday = new Date('2026-11-23T02:00:00Z'); // Sunday 8:00 pm in Chicago
    const plan = earlierFeedPlan(sundayOnly, [], new Date('2026-11-23T00:30:00Z'), sunday, CHICAGO);
    assert.deepEqual(plan, { kind: 'extra', reason: 'off-day', slotName: 'Dinner', alreadyFed: null, amount: 0.5, unit: 'Cans' });
    assert.match(earlierPlanLine(plan, CHICAGO), /No meals were planned that day/);
  });

  it('a pet without meal times logs its usual portion', () => {
    const legacy = { name: 'Pixel', foodSchedule: 'One can morning and evening', portionAmount: 1, portionUnit: 'Cans' as const };
    const plain = earlierFeedPlan(legacy, null, at('2026-11-19T13:30:00Z'), now, CHICAGO);
    assert.deepEqual(plain, { kind: 'legacy', amount: 1, unit: 'Cans' });
    assert.equal(earlierPlanLine(plain, CHICAGO), 'Logs 1 can.');
  });

  it('an extra stays an extra in the status: it never fills another meal', () => {
    const extra = { id: 'x', date: at('2026-11-19T14:00:00Z'), extra: true, loggedByName: 'Max' };
    const day = feedsOnDay([breakfastLog, extra], '2026-11-19', now, CHICAGO);
    const { bySlot, extras } = attributeFeeds(slots as never, day);
    assert.deepEqual(bySlot.map((feeds) => feeds.map((feed) => feed.id)), [['a'], []]);
    assert.deepEqual(extras.map((feed) => feed.id), ['x']);
  });

  describe('planFeed writes what the dialog showed (the personal and tablet operations share it)', () => {
    const snapshot = (recent: Array<Record<string, unknown>>) => ({
      now, timeZone: CHICAGO, perDay: null, dayPlan: planForDay(pet, '2026-11-19'), stored: null, latestSurvives: false,
      recent: recent as never, known: null, existing: null, pet,
    });
    const write = (recent: Array<Record<string, unknown>>, backdatedAt: Date) => {
      const plan = planFeed(snapshot(recent), { userUid: 'u', userName: 'Max', logId: 'log-earlier', backdatedAt });
      assert.equal(plan.kind, 'write');
      return plan as Extract<ReturnType<typeof planFeed>, { kind: 'write' }>;
    };

    it('8:00 am after breakfast: extra, no slot', () => {
      const plan = write([breakfastLog], at('2026-11-19T14:00:00Z'));
      assert.equal(plan.extra, true);
      assert.equal(plan.slot, null);
      assert.equal(plan.slotId, null);
      assert.equal(plan.live, false);
    });

    it('7:30 pm with dinner unfed: dinner, recorded on the log and in slotsFed', () => {
      const plan = write([breakfastLog], at('2026-11-20T01:30:00Z'));
      assert.deepEqual(plan.slot, { id: 'dinner', name: 'Dinner', amount: 0.5, unit: 'Cans' });
      assert.equal(plan.slotId, 'dinner');
      assert.equal(plan.extra, false);
      assert.deepEqual(plan.state.slotsFed, { breakfast: 'a', dinner: 'log-earlier' });
    });

    it('a meal of an older plan is the slot but not written (the rules know only the current plan)', () => {
      const plan = write([], at('2026-11-18T23:30:00Z'));
      assert.equal(plan.slot?.id, 'supper');
      assert.equal(plan.slotId, null);
      assert.equal(plan.extra, false);
    });

    it('a backdated feed\'s planned portion comes from the plan in force that day, never the screen\'s target (Codex P2)', () => {
      // Yesterday's supper (2 cups) while today's target is dinner (0.5 cans).
      assert.deepEqual(write([], at('2026-11-18T23:30:00Z')).planned, { amount: 2, unit: 'Cups' });
      // An extra after breakfast logs breakfast's portion.
      assert.deepEqual(write([breakfastLog], at('2026-11-19T14:00:00Z')).planned, { amount: 1, unit: 'Cups' });
      // 7:30 pm with dinner unfed: dinner's.
      assert.deepEqual(write([breakfastLog], at('2026-11-20T01:30:00Z')).planned, { amount: 0.5, unit: 'Cans' });
      // A day before meal times were confirmed: the usual portion.
      const confirmedToday = { ...pet, mealPlanHistory: [{ until: '2026-11-19', perDay: 2 }] };
      const legacy = planFeed({ ...snapshot([]), pet: confirmedToday }, { userUid: 'u', logId: 'log-legacy', backdatedAt: at('2026-11-18T23:30:00Z') });
      assert.equal(legacy.kind, 'write');
      assert.deepEqual(legacy.kind === 'write' && legacy.planned, { amount: 1.5, unit: 'Cups' });
    });

    it('both Feed earlier paths ask for the planned portion (personal feedAt and the tablet)', () => {
      const personal = readFileSync(resolve(process.cwd(), 'src/components/pets/quick-feed-button.tsx'), 'utf8');
      assert.match(personal, /portion: choice\.portion, portionFromSlot: true, food: foodType/);
      const tablet = readFileSync(resolve(process.cwd(), 'src/components/devices/tablet-views.tsx'), 'utf8');
      assert.doesNotMatch(tablet, /portionFromSlot: !choice\.backdatedAt/);
      assert.match(tablet, /portionFromSlot: true,/);
      for (const writer of ['src/lib/pets/feed-transaction.ts', 'src/lib/server/pet-feeding.ts']) {
        assert.match(readFileSync(resolve(process.cwd(), writer), 'utf8'), /portionFromSlot && plan\.planned \? plan\.planned :/, writer);
      }
    });
  });

  describe('a choice within a minute of now is previewed with the live rule (Codex P2)', () => {
    const eight = new Date('2026-11-19T14:00:00Z'); // 8:00 am, breakfast's window, breakfast logged, dinner unfed
    it('the live rule targets dinner (D-P5), the earlier-time rule would say an extra breakfast', () => {
      assert.deepEqual(liveFeedPlan(pet, [breakfastLog], eight, CHICAGO), { kind: 'slot', slotName: 'Dinner', amount: 0.5, unit: 'Cans' });
      // Within a minute of now (no backdatedAt): the live rule.
      assert.deepEqual(chosenFeedPlan(pet, [breakfastLog], { at: eight }, eight, CHICAGO), { kind: 'slot', slotName: 'Dinner', amount: 0.5, unit: 'Cans' });
      // A real earlier time at 8:00 (backdated): the window rule, an extra breakfast.
      const backdated = chosenFeedPlan(pet, [breakfastLog], { at: eight, backdatedAt: eight }, new Date('2026-11-19T15:00:00Z'), CHICAGO);
      assert.equal(backdated.kind === 'extra' && backdated.slotName, 'Breakfast');
    });
    it('every meal fed: an extra (the save asks "Feed again?"); a pet without meal times: its usual portion', () => {
      const dinnerLog = { id: 'd', date: at('2026-11-19T13:20:00Z'), slotId: 'dinner', loggedByName: 'Ana' };
      const done = liveFeedPlan(pet, [breakfastLog, dinnerLog], eight, CHICAGO);
      assert.equal(done.kind, 'extra');
      const legacy = { name: 'Pixel', foodSchedule: 'One can morning and evening', portionAmount: 1, portionUnit: 'Cans' as const };
      assert.deepEqual(liveFeedPlan(legacy, [], eight, CHICAGO), { kind: 'legacy', amount: 1, unit: 'Cans' });
    });
    it('the dialog previews and submits the chosen plan', () => {
      const dialog = readFileSync(resolve(process.cwd(), 'src/components/pets/feed-earlier-dialog.tsx'), 'utf8');
      assert.match(dialog, /chosenFeedPlan\(pet, logs, check, now, timeZone\)/);
      assert.match(dialog, /chosenFeedPlan\(pet, logs, result, current, timeZone\)/);
      assert.doesNotMatch(dialog, /earlierFeedPlan\(/);
    });
  });
});
