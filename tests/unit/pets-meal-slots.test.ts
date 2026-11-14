import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseFeedingsPerDay, parseSchedule } from '../../src/lib/pets/schedule-parser';
import { feedingPlan } from '../../src/lib/pets/care';
import {
  attributeFeeds,
  confirmMealPlan,
  draftFromSuggestion,
  feedingWeek,
  feedsOnDay,
  feedTarget,
  legacyNextMeal,
  mealAttention,
  mealHeadline,
  mealStatus,
  needsMeal,
  planForDay,
  readMealPlan,
  readsAs,
  slotLine,
  slotsFedOn,
  slotWindows,
  targetSlot,
  slotsFromDraft,
  validateMealDraft,
  type MealSlotDraft,
} from '../../src/lib/pets/meal-plan';
import { feedConfirmOf, planFeed, type FeedSnapshot } from '../../src/lib/pets/feed-plan';
import { feedAgainPrompt, type FeedingStateView } from '../../src/lib/pets/feed-decision';
import type { MealSlot, PetProfile } from '../../src/lib/pets/types';
import { auditPetMealPlan, MEAL_PLAN_AUDIT_NEEDS } from '../../src/lib/pets/meal-plan-audit';

const CHI = 'America/Chicago';
/** A Chicago wall-clock time in November 2026 (CST, UTC-6). */
const nov = (day: number, time: string) => {
  const [h, m] = time.split(':').map(Number);
  return new Date(Date.UTC(2026, 10, day, h + 6, m));
};

const BREAKFAST: MealSlot = { id: 'breakfast', name: 'Breakfast', time: '07:00', amount: 1, unit: 'Cups' };
const DINNER: MealSlot = { id: 'dinner', name: 'Dinner', time: '18:00', amount: 0.5, unit: 'Cans' };
type Pet = Pick<PetProfile, 'foodSchedule' | 'feedingsPerDay' | 'portionAmount' | 'portionUnit' | 'mealPlan' | 'mealPlanHistory'>;
const petWith = (slots: MealSlot[], extra: Partial<Pet> = {}): Pet => ({ foodSchedule: 'twice daily', mealPlan: { slots, effectiveFrom: '2026-11-01' }, ...extra });
const feeding = (id: string, date: Date, extra: Record<string, unknown> = {}) => ({ id, date, loggedByName: 'Sam', loggedByUid: 'sam', ...extra });

describe('PE-6: reading a free-text schedule', () => {
  it('counts each "once" with its part of the day (PE-6a)', () => {
    const parsed = parseSchedule('once in the morning, once at night');
    assert.equal(parsed.kind, 'plan');
    assert.equal(parsed.kind === 'plan' && parsed.perDay, 2);
    assert.equal(parseFeedingsPerDay('once in the morning, once at night'), 2);
  });

  it('accepts "meals" as a count (PE-6b)', () => {
    assert.equal(parseFeedingsPerDay('2 meals a day'), 2);
    assert.equal(parseFeedingsPerDay('3 feedings daily'), 3);
  });

  it('merges synonyms of one part of the day, never double-counting (PE-6c)', () => {
    assert.equal(parseFeedingsPerDay('breakfast (morning) and dinner (evening)'), 2);
    assert.equal(parseFeedingsPerDay('morning breakfast, evening supper'), 2);
    assert.equal(parseFeedingsPerDay('dinner at night'), 1);
    // "late night" is bedtime only, not also "night" (dinner).
    assert.equal(parseFeedingsPerDay('dinner and a late night snack'), 2);
  });

  it('reads 24-hour and 12-hour times as meals at those times (PE-6d)', () => {
    const parsed = parseSchedule('8:00 and 18:00');
    assert.equal(parsed.kind, 'plan');
    assert.deepEqual(parsed.kind === 'plan' && parsed.meals.map((meal) => [meal.name, meal.time]), [['Breakfast', '08:00'], ['Dinner', '18:00']]);
    const twelve = parseSchedule('1 cup at 7am, 12pm and 6:30 pm');
    assert.deepEqual(twelve.kind === 'plan' && twelve.meals.map((meal) => meal.time), ['07:00', '12:00', '18:30']);
    assert.equal(twelve.kind === 'plan' && twelve.timesGuessed, false);
  });

  it('keeps per-meal portions (PE-6e) and one stated portion for every meal', () => {
    const split = parseSchedule('1 cup in the morning and 1/2 cup at night');
    assert.deepEqual(split.kind === 'plan' && split.meals.map((meal) => [meal.amount, meal.unit]), [[1, 'Cups'], [0.5, 'Cups']]);
    const shared = parseSchedule('One can morning and evening');
    assert.deepEqual(shared.kind === 'plan' && shared.meals.map((meal) => [meal.amount, meal.unit]), [[1, 'Cans'], [1, 'Cans']]);
    assert.equal(shared.kind === 'plan' && shared.portionGuessed, false);
  });

  it('never invents a plan from ambiguous, non-daily or unreadable text (PE-6g)', () => {
    assert.equal(parseSchedule('twice daily, morning').kind, 'ambiguous');
    assert.equal(parseSchedule('three times a day at 8am and 6pm').kind, 'ambiguous');
    assert.equal(parseSchedule('twice in the morning').kind, 'ambiguous');
    assert.equal(parseSchedule('7 times a day').kind, 'ambiguous');
    assert.equal(parseSchedule('every 5 hours').kind, 'ambiguous');
    assert.equal(parseSchedule('every other day').kind, 'nonDaily');
    assert.equal(parseSchedule('free feed').kind, 'nonDaily');
    assert.equal(parseSchedule('whatever she wants').kind, 'empty');
    assert.equal(parseSchedule('').kind, 'empty');
    // The legacy daily target keeps the stated count of an ambiguous text.
    assert.equal(parseFeedingsPerDay('twice daily, morning'), 2);
  });

  it('keeps a stated daily count as the legacy target when the times it names disagree ("twice daily at 8am")', () => {
    const conflicting: [string, number][] = [
      ['twice daily at 8am', 2],
      ['twice a day at 7:30', 2],
      ['2 times daily at 8am', 2],
      ['three times daily at 8am', 3],
      ['3x a day at 6pm', 3],
      ['twice daily at 8am, 1 cup', 2],
      ['twice in the morning', 2],
      ['every 8 hours starting 7am', 3],
    ];
    for (const [text, perDay] of conflicting) {
      const parsed = parseSchedule(text);
      assert.equal(parsed.kind, 'ambiguous', text);
      assert.deepEqual(draftFromSuggestion(parsed), [], `${text}: no suggestion`);
      assert.equal(parseFeedingsPerDay(text), perDay, `${text}: legacy target`);
      assert.equal(feedingPlan({ foodSchedule: text }).perDay, perDay, `${text}: the card's daily target`);
    }
    // A count that matches the times it names is still a plan.
    const agreeing: [string, string[]][] = [
      ['twice daily at 8am and 6pm', ['08:00', '18:00']],
      ['three times a day at 8am, noon and 6pm', ['08:00', '12:00', '18:00']],
      ['once daily at 8am', ['08:00']],
    ];
    for (const [text, times] of agreeing) {
      const parsed = parseSchedule(text);
      assert.equal(parsed.kind, 'plan', text);
      assert.deepEqual(parsed.kind === 'plan' && parsed.meals.map((meal) => meal.time), times, text);
    }
  });

  it('rejects oversized or non-finite counts before expanding them (no allocation, no freeze while typing)', () => {
    for (const text of ['9999999999 meals daily', '7 meals a day', '1e400 meals', '99999999999999999999 times a day', 'every 99999999 hours']) {
      const started = Date.now();
      const parsed = parseSchedule(text);
      // Never a suggestion ("1e400" is not even read as a count).
      assert.notEqual(parsed.kind, 'plan', text);
      assert.ok(Date.now() - started < 200, `${text} took ${Date.now() - started} ms`);
    }
    assert.equal(parseSchedule('9999999999 meals daily').kind, 'ambiguous');
    assert.equal(parseSchedule('6 meals a day').kind, 'plan');
    assert.equal(parseFeedingsPerDay('9999999999 meals daily'), null, 'no absurd legacy daily target either');
  });

  it('marks counts without times as guessed times, and names them as such', () => {
    const parsed = parseSchedule('1.5 cups twice daily');
    assert.equal(parsed.kind === 'plan' && parsed.timesGuessed, true);
    assert.deepEqual(parsed.kind === 'plan' && parsed.meals.map((meal) => meal.source), ['count', 'count']);
    const every = parseSchedule('every 8 hours');
    assert.deepEqual(every.kind === 'plan' && every.meals.map((meal) => meal.time), ['07:00', '15:00', '23:00']);
  });

  it('turns a suggestion into editable rows with new ids, read back for confirmation (PE-6f)', () => {
    let n = 0;
    const rows = draftFromSuggestion(parseSchedule('1 cup at 8am and 6pm'), () => `slot-${++n}`);
    assert.deepEqual(rows.map((row) => [row.id, row.name, row.time, row.amount]), [['slot-1', 'Breakfast', '08:00', '1'], ['slot-2', 'Dinner', '18:00', '1']]);
    assert.equal(readsAs([{ amount: 1, unit: 'Cups' }, { amount: 1, unit: 'Cups' }]), 'Reads as: 2 feedings of 1 cup');
    assert.equal(readsAs([BREAKFAST, DINNER]), 'Reads as: 2 feedings (1 cup, 0.5 cans)');
    assert.deepEqual(draftFromSuggestion(parseSchedule('twice daily, morning')), []);
  });
});

describe('slot windows and assignment (D-P5)', () => {
  it('opens a window 2 h early, never before the midpoint with the previous slot, and keeps it until the next opens', () => {
    assert.deepEqual(slotWindows([BREAKFAST, DINNER]), [{ open: 5 * 60, close: 16 * 60 }, { open: 16 * 60, close: 24 * 60 }]);
    const close = slotWindows([{ time: '07:00' }, { time: '08:00' }]);
    assert.deepEqual(close, [{ open: 5 * 60, close: 7 * 60 + 30 }, { open: 7 * 60 + 30, close: 24 * 60 }]);
    assert.equal(slotWindows([{ time: '00:30' }])[0].open, 0);
  });

  it('assigns to the open unfed slot, else the next unfed one, else repeats the open one', () => {
    const slots = [BREAKFAST, DINNER];
    assert.deepEqual(targetSlot(slots, [false, false], 6 * 60), { index: 0, open: true, alreadyFed: false });
    // Breakfast fed: at 9:00 the next meal is dinner, whose window is not open yet.
    assert.deepEqual(targetSlot(slots, [true, false], 9 * 60), { index: 1, open: false, alreadyFed: false });
    // Before any window: the first slot, not open.
    assert.deepEqual(targetSlot(slots, [false, false], 4 * 60), { index: 0, open: false, alreadyFed: false });
    // A missed breakfast is not targeted once dinner's window is open.
    assert.deepEqual(targetSlot(slots, [false, false], 17 * 60), { index: 1, open: true, alreadyFed: false });
    assert.deepEqual(targetSlot(slots, [false, true], 20 * 60), { index: 1, open: true, alreadyFed: true });
    assert.equal(targetSlot([], [], 600), null);
  });

  it('attributes feeds with a slot to that slot, and older feeds by their time; a second feed is an extra', () => {
    const feeds = feedsOnDay([
      feeding('a', nov(14, '07:05')),
      feeding('b', nov(14, '07:30'), { slotId: 'breakfast' }),
      feeding('c', nov(14, '17:50')),
    ], '2026-11-14', nov(14, '20:00'), CHI);
    const { bySlot, extras } = attributeFeeds([BREAKFAST, DINNER], feeds);
    assert.deepEqual(bySlot.map((list) => list.map((feed) => feed.id)), [['a', 'b'], ['c']]);
    assert.equal(extras.length, 0);
    assert.deepEqual(slotsFedOn([feeding('b', nov(14, '07:30'), { slotId: 'breakfast' })], '2026-11-14', nov(14, '20:00'), CHI), { breakfast: 'b' });
  });
});

describe('the shared status (PE-22h, PE-10a, PE-22b/e, D-P3, PE-31)', () => {
  const pet = petWith([BREAKFAST, DINNER]);

  it('is not hungry all afternoon because dinner is pending later (D-P3, PE-31d)', () => {
    const logs = [feeding('a', nov(14, '07:10'), { slotId: 'breakfast' })];
    const afternoon = mealStatus(pet, logs, nov(14, '15:00'), CHI);
    assert.equal(afternoon.kind, 'slots');
    assert.equal(needsMeal(afternoon), false);
    assert.equal(afternoon.kind === 'slots' && mealHeadline(afternoon), 'Next: dinner at 6:00 pm');
    assert.equal(mealAttention(afternoon), null);
    // Dinner's time has passed unfed: now it needs food (bowl, amber, Fed, attention).
    const evening = mealStatus(pet, logs, nov(14, '18:20'), CHI);
    assert.equal(needsMeal(evening), true);
    assert.equal(evening.kind === 'slots' && mealHeadline(evening), 'Dinner due 6:00 pm');
    assert.equal(mealAttention(evening), 'Dinner due 6:00 pm');
    assert.equal(evening.kind === 'slots' && slotLine(evening.day.slots[0], CHI), 'Breakfast ✓ 7:10 am · Sam');
    assert.deepEqual(feedTarget(evening), { label: 'dinner · 0.5 cans', slotName: 'Dinner', amount: 0.5, unit: 'Cans' });
  });

  it('a missed breakfast needs attention but does not send the pet to the bowl', () => {
    const status = mealStatus(pet, [], nov(14, '16:30'), CHI);
    assert.equal(needsMeal(status), false);
    assert.equal(mealAttention(status), 'Breakfast missed');
  });

  it('a pet without confirmed slots never needs food (no guess as a need) and shows a neutral parsed hint (PE-10b)', () => {
    const legacy = mealStatus({ foodSchedule: 'breakfast and dinner' }, [feeding('a', nov(14, '07:00'))], nov(14, '19:00'), CHI);
    assert.equal(legacy.kind, 'legacy');
    assert.equal(needsMeal(legacy), false);
    assert.equal(mealAttention(legacy), null);
    assert.equal(legacy.kind === 'legacy' && legacy.nextMealHint, 'Next meal: evening');
    assert.equal(legacyNextMeal('8am and 6pm', 1), 'Next meal: 6:00 pm');
    assert.equal(legacyNextMeal('twice daily', 0), null, 'a bare count names no meal');
    // A malformed stored plan is no plan: never guessed into slots.
    assert.equal(readMealPlan({ mealPlan: { slots: [{ id: 'x', name: '', time: '7', amount: 0, unit: 'Cups' }], effectiveFrom: '2026-11-01' } }), null);
  });

  it('off-days: a slot skipped on a weekday is not due; a day without slots is an off-day (PE-18b)', () => {
    // 2026-11-14 is a Saturday (6); 2026-11-15 a Sunday (0).
    const weekend = petWith([{ ...BREAKFAST, offDays: [0] }, { ...DINNER, offDays: [0, 6] }]);
    const saturday = mealStatus(weekend, [feeding('b', nov(14, '07:00'), { slotId: 'breakfast' })], nov(14, '19:00'), CHI);
    assert.equal(saturday.kind === 'slots' && saturday.day.planned, 1);
    assert.equal(saturday.kind === 'slots' && saturday.complete, true);
    assert.equal(needsMeal(saturday), false, 'dinner is off on Saturdays');
    const sunday = mealStatus(weekend, [], nov(15, '19:00'), CHI);
    assert.equal(sunday.kind === 'slots' && sunday.offDay, true);
    assert.equal(sunday.kind === 'slots' && mealHeadline(sunday), 'No meals planned today');
    assert.equal(mealAttention(sunday), null);
  });

  it('midnight: yesterday\'s late dinner never fills today\'s breakfast; the day rolls over at household midnight', () => {
    const logs = [feeding('late', nov(14, '23:50'), { slotId: 'dinner' })];
    const after = mealStatus(pet, logs, nov(15, '00:10'), CHI);
    assert.equal(after.kind === 'slots' && after.day.fedCount, 0);
    assert.equal(after.kind === 'slots' && after.day.day, '2026-11-15');
    // A London household's day already rolled over at 18:00 Chicago time.
    const london = mealStatus(pet, [feeding('x', nov(14, '07:10'), { slotId: 'breakfast' })], nov(14, '18:30'), 'Europe/London');
    assert.equal(london.kind === 'slots' && london.day.day, '2026-11-15');
  });

  it('daylight saving: a slot in the skipped spring-forward hour still counts as passed; fall-back neither drops nor doubles a slot', () => {
    const night: Pet = { foodSchedule: '', mealPlan: { slots: [{ id: 'night', name: 'Night', time: '02:30', amount: 1, unit: 'Cups' }, DINNER], effectiveFrom: '2026-01-01' } };
    // 2026-03-08 03:10 CDT (08:10Z): 02:30 never happened, but it has passed.
    const spring = mealStatus(night, [], new Date('2026-03-08T08:10:00Z'), CHI);
    assert.equal(spring.kind === 'slots' && spring.day.slots[0].phase, 'due');
    // 2026-11-01 01:30 CST (07:30Z), the second 01:30: a feed at the first 01:30 CDT (06:30Z) is the same day's 'night'.
    const fall = mealStatus(night, [feeding('n', new Date('2026-11-01T06:30:00Z'))], new Date('2026-11-01T07:30:00Z'), CHI);
    assert.equal(fall.kind === 'slots' && fall.day.day, '2026-11-01');
    assert.equal(fall.kind === 'slots' && fall.day.fedCount, 1);
  });

  it('late, backdated and bad legacy dates', () => {
    const logs = [
      feeding('late', nov(14, '11:00')), // a late breakfast, no slot (older client)
      feeding('bad', 'not a date' as unknown as Date),
      feeding('epoch', new Date(0)),
    ];
    const status = mealStatus(pet, logs, nov(14, '12:00'), CHI);
    assert.equal(status.kind === 'slots' && status.day.slots[0].fed?.id, 'late');
    assert.equal(status.kind === 'slots' && status.day.feedings, 1, 'unreadable dates are no feeding');
  });
});

describe('planFeed with slots (D-P5): target slot and "Feed again?"', () => {
  const state = (overrides: Partial<FeedingStateView> = {}): FeedingStateView => ({
    lastLogId: 'b', lastFedAt: nov(14, '07:10'), lastFedByUid: 'sam', lastFedByName: 'Sam', day: '2026-11-14', countOnDay: 1, hasPrev: false, prevLogId: null, ...overrides,
  });
  const snapshot = (now: Date, recent: ReturnType<typeof feeding>[], overrides: Partial<FeedSnapshot> = {}): FeedSnapshot => ({
    now,
    timeZone: CHI,
    perDay: null,
    dayPlan: planForDay(petWith([BREAKFAST, DINNER]), '2026-11-14'),
    stored: recent.length ? state({ lastLogId: recent[recent.length - 1].id, lastFedAt: recent[recent.length - 1].date }) : null,
    latestSurvives: true,
    recent,
    existing: null,
    ...overrides,
  });

  it('writes the open slot with its id and portion and the fed slots for the state', () => {
    const plan = planFeed(snapshot(nov(14, '07:00'), []), { userUid: 'alex', logId: 'new-log' });
    assert.equal(plan.kind, 'write');
    assert.deepEqual(plan.kind === 'write' && plan.slot, { id: 'breakfast', name: 'Breakfast', amount: 1, unit: 'Cups' });
    assert.equal(plan.kind === 'write' && plan.repeat, 'none');
    // The derived state records this log as breakfast's first feeding (what the rules' slot check reads).
    assert.deepEqual(plan.kind === 'write' && plan.state.slotsFed, { breakfast: 'new-log' });
  });

  it('feeding a due slot inside 90 minutes of the last feed does not ask (an early dinner)', () => {
    const recent = [feeding('b', nov(14, '15:30'), { slotId: 'breakfast' })];
    const plan = planFeed(snapshot(nov(14, '16:30'), recent), { userUid: 'alex', logId: 'dinner-log' });
    assert.equal(plan.kind, 'write');
    assert.equal(plan.kind === 'write' && plan.slot?.id, 'dinner');
    assert.equal(plan.kind === 'write' && plan.mealsComplete, true);
    assert.deepEqual(plan.kind === 'write' && plan.state.slotsFed, { breakfast: 'b', dinner: 'dinner-log' });
  });

  it('asks when the last feed was under 90 minutes ago and the target is not due yet', () => {
    const recent = [feeding('b', nov(14, '07:10'), { slotId: 'breakfast' })];
    const plan = planFeed(snapshot(nov(14, '08:00'), recent), { userUid: 'alex' });
    assert.equal(plan.kind, 'needsConfirm');
    assert.equal(plan.kind === 'needsConfirm' && plan.check.reason, 'recent');
    assert.equal(plan.kind === 'needsConfirm' && plan.check.slotId, 'dinner');
    const prompt = plan.kind === 'needsConfirm' ? feedAgainPrompt(plan.check, 'Rex', nov(14, '08:00'), 'alex', CHI) : '';
    assert.equal(prompt, 'Sam fed Rex 50 min ago. Dinner is at 6:00 pm. Feed again?');
    // Two hours later the early dinner is fed without asking (D-P5: recency only inside 90 minutes).
    const later = planFeed(snapshot(nov(14, '09:00'), recent), { userUid: 'alex' });
    assert.equal(later.kind === 'write' && later.slot?.id, 'dinner');
  });

  it('asks when every slot is fed, when the open slot is fed after a missed one, and on an off-day', () => {
    const both = [feeding('b', nov(14, '07:10'), { slotId: 'breakfast' }), feeding('d', nov(14, '18:05'), { slotId: 'dinner' })];
    const complete = planFeed(snapshot(nov(14, '21:00'), both), { userUid: 'alex' });
    assert.equal(complete.kind === 'needsConfirm' && complete.check.reason, 'complete');
    assert.equal(complete.kind === 'needsConfirm' ? feedAgainPrompt(complete.check, 'Rex', nov(14, '21:00'), 'alex', CHI) : '', 'Rex has had all 2 meals today. Sam fed Rex 2 h ago. Feed again?');
    const dinnerOnly = [feeding('d', nov(14, '18:05'), { slotId: 'dinner' })];
    const slotFed = planFeed(snapshot(nov(14, '21:00'), dinnerOnly), { userUid: 'alex' });
    assert.equal(slotFed.kind === 'needsConfirm' && slotFed.check.reason, 'slot-fed');
    const off = planFeed(snapshot(nov(15, '09:00'), [], { dayPlan: planForDay(petWith([{ ...BREAKFAST, offDays: [0] }]), '2026-11-15') }), { userUid: 'alex' });
    assert.equal(off.kind === 'needsConfirm' && off.check.reason, 'off-day');
    assert.equal(off.kind === 'needsConfirm' && off.check.slotId, null);
  });

  it('a confirmation is bound to the slot it was shown for; a confirmed extra keeps the slot for the strip', () => {
    const both = [feeding('b', nov(14, '07:10'), { slotId: 'breakfast' }), feeding('d', nov(14, '18:05'), { slotId: 'dinner' })];
    const asked = planFeed(snapshot(nov(14, '21:00'), both), { userUid: 'alex' });
    assert.equal(asked.kind, 'needsConfirm');
    const confirm = asked.kind === 'needsConfirm' ? feedConfirmOf(asked.check) : null;
    assert.equal(confirm?.slotId, 'dinner');
    const confirmed = planFeed(snapshot(nov(14, '21:00'), both), { userUid: 'alex', confirm });
    assert.equal(confirmed.kind === 'write' && confirmed.repeat, 'confirmed');
    assert.equal(confirmed.kind === 'write' && confirmed.slot?.id, 'dinner');
    // The same answer for another slot is stale.
    const stale = planFeed(snapshot(nov(14, '21:00'), both), { userUid: 'alex', confirm: { ...confirm!, slotId: 'breakfast' } });
    assert.equal(stale.kind === 'needsConfirm' && stale.staleConfirm, true);
  });

  it('a backdated entry carries no slot and is never asked about', () => {
    const plan = planFeed(snapshot(nov(14, '20:00'), [feeding('d', nov(14, '18:05'), { slotId: 'dinner' })]), { userUid: 'alex', backdatedAt: nov(14, '07:00') });
    assert.equal(plan.kind === 'write' && plan.slot, null);
    assert.equal(plan.kind === 'write' && plan.live, false);
  });
});

describe('schedule history: past days use the plan in force that day (PE-22g, PE-25d)', () => {
  it('judges each day by its own plan, and the legacy target before the first plan', () => {
    const pet: Pet = {
      foodSchedule: 'twice daily',
      feedingsPerDay: 1,
      mealPlan: { slots: [BREAKFAST], effectiveFrom: '2026-11-12' },
      mealPlanHistory: [{ until: '2026-11-10', perDay: 3 }, { until: '2026-11-12', slots: [BREAKFAST, DINNER] }],
    };
    assert.deepEqual(planForDay(pet, '2026-11-09'), { kind: 'legacy', day: '2026-11-09', plan: { perDay: 3, amount: 1, unit: 'Cups' } });
    const tenth = planForDay(pet, '2026-11-10');
    assert.equal(tenth.kind === 'slots' && tenth.slots.length, 2);
    const today = planForDay(pet, '2026-11-14');
    assert.equal(today.kind === 'slots' && today.slots.length, 1);
    // The strip: Nov 11 had two meals planned and one fed; it stays "1 of 2" after the edit to one meal.
    const week = feedingWeek(pet, [
      feeding('a', nov(11, '07:10')),
      feeding('b', nov(13, '07:00'), { slotId: 'breakfast' }),
      feeding('c', nov(13, '07:20'), { slotId: 'breakfast' }),
    ], nov(14, '06:00'), CHI, { complete: true });
    const byDay = Object.fromEntries(week.map((mark) => [mark.day, mark]));
    assert.equal(byDay['2026-11-11'].state, 'partial');
    assert.equal(byDay['2026-11-11'].label, 'Wed: 1 of 2 fed');
    assert.equal(byDay['2026-11-09'].state, 'missed');
    assert.equal(byDay['2026-11-09'].planned, 3);
    assert.equal(byDay['2026-11-13'].state, 'met');
    assert.equal(byDay['2026-11-13'].extra, 1, 'a double feed is visible (PE-25b)');
    assert.equal(byDay['2026-11-14'].state, 'today');
    assert.equal(week.length, 7);
  });

  it('off-days are not missed; a non-daily legacy plan is not missed; days older than the loaded history are unknown', () => {
    const week = feedingWeek(petWith([{ ...BREAKFAST, offDays: [0] }]), [feeding('a', nov(13, '07:00'), { slotId: 'breakfast' })], nov(14, '12:00'), CHI, { complete: false });
    const byDay = Object.fromEntries(week.map((mark) => [mark.day, mark]));
    assert.equal(byDay['2026-11-08'].state, 'unknown');
    // The oldest loaded day may be cut too: unknown, never "missed".
    assert.equal(byDay['2026-11-12'].state, 'unknown');
    assert.equal(byDay['2026-11-13'].state, 'unknown');
    assert.equal(byDay['2026-11-14'].state, 'today');
    const sundays = feedingWeek(petWith([{ ...BREAKFAST, offDays: [0] }]), [], nov(14, '12:00'), CHI, { complete: true });
    assert.equal(sundays.find((mark) => mark.day === '2026-11-08')?.state, 'off');
    const nonDaily = feedingWeek({ foodSchedule: 'every other day' }, [], nov(14, '12:00'), CHI, { complete: true });
    assert.ok(nonDaily.every((mark) => mark.state === 'off'));
  });

  it('confirming keeps the plan that applied before, and a same-day edit adds no entry', () => {
    const legacy: Pet = { foodSchedule: 'twice daily' };
    const first = confirmMealPlan(legacy, [BREAKFAST, DINNER], '2026-11-14')!;
    assert.deepEqual(first.mealPlanHistory, [{ until: '2026-11-14', perDay: 2 }]);
    assert.deepEqual(first.mealPlan, { slots: [BREAKFAST, DINNER], effectiveFrom: '2026-11-14' });
    assert.equal(first.feedingsPerDay, 2);
    const confirmed: Pet = { ...legacy, mealPlan: first.mealPlan, mealPlanHistory: first.mealPlanHistory };
    assert.equal(confirmMealPlan(confirmed, [BREAKFAST, DINNER], '2026-11-14'), null, 'nothing changed');
    const sameDay = confirmMealPlan(confirmed, [BREAKFAST], '2026-11-14')!;
    assert.deepEqual(sameDay.mealPlanHistory, first.mealPlanHistory);
    const nextDay = confirmMealPlan(confirmed, [BREAKFAST], '2026-11-15')!;
    assert.deepEqual(nextDay.mealPlanHistory, [{ until: '2026-11-14', perDay: 2 }, { until: '2026-11-15', slots: [BREAKFAST, DINNER] }]);
    // At most ten kept: the oldest drops.
    const full: Pet = { ...confirmed, mealPlan: { slots: [BREAKFAST], effectiveFrom: '2026-11-14' }, mealPlanHistory: Array.from({ length: 10 }, (_u, i) => ({ until: `2026-10-${10 + i}`, perDay: 1 })) };
    const rotated = confirmMealPlan(full, [DINNER], '2026-11-15')!;
    assert.equal(rotated.mealPlanHistory.length, 10);
    assert.equal(rotated.mealPlanHistory[0].until, '2026-10-11');
  });
});

describe('meal plan form validation (PE-22k)', () => {
  const row = (overrides: Partial<MealSlotDraft> = {}): MealSlotDraft => ({ id: 'a', name: 'Breakfast', time: '07:00', amount: '1', unit: 'Cups', offDays: [], ...overrides });
  it('refuses a portion that rounds to 0, so an accepted draft always saves a valid plan (rules: amount > 0)', () => {
    const tiny = validateMealDraft([row({ amount: '0.004' })]);
    assert.equal(tiny.rows[0].amount, 'Use an amount above 0 and up to 50.');
    assert.deepEqual(validateMealDraft([row({ amount: '0.005' })]).rows[0], {}, '0.005 rounds to 0.01');
    assert.equal(slotsFromDraft([row({ amount: '0.005' })])[0].amount, 0.01);
    assert.equal(validateMealDraft([row({ amount: '50.004' })]).rows[0].amount, undefined, '50.004 rounds to 50');
    assert.ok(validateMealDraft([row({ amount: '50.006' })]).rows[0].amount);
  });

  it('names, times, amounts and days per row; distinct times; at most six meals', () => {
    assert.deepEqual(validateMealDraft([row()]), { rows: [{}], plan: null });
    const errors = validateMealDraft([row({ name: ' ', time: '', amount: '0' }), row({ id: 'b', offDays: [0, 1, 2, 3, 4, 5, 6] })]);
    assert.equal(errors.rows[0].name, 'Name this meal.');
    assert.equal(errors.rows[0].time, 'Pick a time.');
    assert.ok(errors.rows[0].amount);
    assert.equal(errors.rows[1].offDays, 'Serve it on at least one day.');
    assert.equal(validateMealDraft([row(), row({ id: 'b' })]).rows[1].time, 'Another meal is at this time.');
    assert.ok(validateMealDraft(Array.from({ length: 7 }, (_u, i) => row({ id: `r${i}`, time: `0${i}:00` }))).plan);
  });
});

describe('meal plan audit classification (PE-22i, read only)', () => {
  it('sorts each pet by what its in-app confirmation will need', () => {
    const pets: Record<string, Record<string, unknown>> = {
      'suggest-times': { foodSchedule: '1 cup at 8am and 6pm' },
      'suggest-parts': { foodSchedule: 'breakfast (morning) and dinner (evening)' },
      'suggest-count': { foodSchedule: '1.5 cups twice daily' },
      'count-conflict': { foodSchedule: 'morning and evening', feedingsPerDay: 3 },
      ambiguous: { foodSchedule: 'twice daily, morning' },
      'non-daily': { foodSchedule: 'every other day' },
      'structured-count': { foodSchedule: 'whatever she wants', feedingsPerDay: 2 },
      'no-schedule': { foodSchedule: '' },
      confirmed: { mealPlan: { slots: [BREAKFAST], effectiveFrom: '2026-11-14' } },
      'malformed-plan': { mealPlan: { slots: [{ id: 'b', name: '', time: '7' }], effectiveFrom: 'today' } },
    };
    for (const [kind, pet] of Object.entries(pets)) assert.equal(auditPetMealPlan(pet), kind, kind);
    assert.deepEqual(Object.keys(MEAL_PLAN_AUDIT_NEEDS).sort(), Object.keys(pets).sort());
  });
});
