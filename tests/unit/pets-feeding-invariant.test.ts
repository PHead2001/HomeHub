/**
 * The feeding-state invariant, as a model test (hydra rule): over random
 * sequences of every feeding write (live feeds, confirmed repeats, offline
 * feeds, backdated entries, Undo/deletes and time corrections of the latest,
 * of the previous and of older feedings), with device clocks up to 5 minutes
 * off, the state each online write stores equals what the surviving logs imply
 * by effective time (latest, previous, today's count), every state write is one
 * the rules accept, and a feed the client plans as plain (or confirmed) is one
 * the rules accept. The rules are mirrored here as small predicates of
 * firestore.rules (feedingStateHonest, feedingLatestMoveAllowed, feedingRecent,
 * feedingDayComplete, feedingConfirmBound); the emulator suites check the real
 * rules on the same cases.
 *
 * With meal slots (P2, D-P5, windows D-P21) the same runs also hold: a pet with
 * a confirmed plan (one meal skipped on Sundays) gets slot-assigned live feeds,
 * the derived state's `slotsFed` is always the first surviving slotted log per
 * slot of the state's day, and a plain slot feed is one the rules' slot check
 * (feedingSlotFree) accepts, in place of the 90-minute and complete-day checks.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { FEED_REPEAT_WINDOW_MS, readFeedingState } from '../../src/lib/pets/feed-decision';
import {
  confirmStillHolds,
  deriveFeedingState,
  feedConfirmOf,
  planFeed,
  planFeedCorrection,
  planFeedDelete,
  type DerivedFeedingState,
} from '../../src/lib/pets/feed-plan';
import { petDay } from '../../src/lib/pets/care';
import { planForDay } from '../../src/lib/pets/meal-plan';
import type { MealSlot } from '../../src/lib/pets/types';

const TZ = 'America/Chicago';
const MIN = 60_000;
const PER_DAY = 2;

/** A log's stored date: a Timestamp (here a Date) or a legacy ISO string. */
type Log = { id: string; date: Date | string; loggedByUid: string; loggedByName: string; slotId?: string };

/** The slot pet's confirmed plan: three meals, dinner skipped on Sundays. */
const SLOTS: MealSlot[] = [
  { id: 'breakfast', name: 'Breakfast', time: '07:00', amount: 1, unit: 'Cups' },
  { id: 'lunch', name: 'Lunch', time: '12:30', amount: 0.5, unit: 'Cups' },
  { id: 'dinner', name: 'Dinner', time: '18:00', amount: 1, unit: 'Cans', offDays: [0] },
];
const SLOT_PET = { foodSchedule: '', mealPlan: { slots: SLOTS, effectiveFrom: '2026-01-01' } };
const timeOf = (log: Log) => (typeof log.date === 'string' ? new Date(log.date) : log.date).getTime();
/** The rules can only compare Timestamps: a legacy string-dated feeding is never named or confirmed. */
const nameable = (log: Log | undefined): log is Log => Boolean(log) && typeof log!.date !== 'string';
/** Effective time as the rules compare it: anything ahead of the server clock counts as now. */
const clamp = (time: number, serverNow: Date) => Math.min(time, serverNow.getTime());
const SKEW = 12 * 60 * MIN;
type Ref = { logId: string; at: Date; byUid: string | null; byName: string | null };
type StateDoc = { lastLogId: string | null; lastFedAt: Date | null; lastFedByUid: string | null; lastFedByName: string | null; day: string; countOnDay: number; prev: Ref | null; slotsFed?: Record<string, string> };

/** What the transaction stores for a derived state (`date` of a live log is the server time). */
function stateDoc(derived: DerivedFeedingState, live: { id: string; serverNow: Date } | null): StateDoc {
  const at = (ref: DerivedFeedingState['latest']) => (ref && live && ref.logId === live.id ? live.serverNow : ref?.at ?? null);
  return {
    lastLogId: derived.latest?.logId ?? null,
    lastFedAt: at(derived.latest),
    lastFedByUid: derived.latest?.byUid ?? null,
    lastFedByName: derived.latest?.byName ?? null,
    day: derived.day,
    countOnDay: derived.countOnDay,
    prev: derived.prev ? { logId: derived.prev.logId, at: at(derived.prev)!, byUid: derived.prev.byUid, byName: derived.prev.byName } : null,
    ...(derived.slotsFed ? { slotsFed: derived.slotsFed } : {}),
  };
}

/** feedingSlotFree, mirrored: the state written records this log for its slot, and the slot was not fed that day by a surviving log. */
function rulesSlotFree(before: StateDoc | null, after: StateDoc, logsBefore: Map<string, Log>, logId: string, slotId: string): boolean {
  if (after.slotsFed?.[slotId] !== logId) return false;
  const fedBy = before?.slotsFed?.[slotId];
  return !(before && before.day === after.day && fedBy && logsBefore.has(fedBy));
}

/** What `slotsFed` must be: per slot, the first surviving slotted log of the day (by effective time, as readers see it). */
function expectedSlotsFed(logs: Map<string, Log>, deviceNow: Date): Record<string, string> {
  const today = petDay(deviceNow, TZ);
  const fed: Record<string, string> = {};
  const limit = deviceNow.getTime() + SKEW;
  const slotted = [...logs.values()]
    .filter((log) => log.slotId && timeOf(log) <= limit && petDay(new Date(Math.min(timeOf(log), deviceNow.getTime())), TZ) === today)
    .sort((a, b) => Math.min(timeOf(a), deviceNow.getTime()) - Math.min(timeOf(b), deviceNow.getTime()));
  for (const log of slotted) if (!(log.slotId! in fed)) fed[log.slotId!] = log.id;
  return fed;
}

/* ---- the rules, mirrored ------------------------------------------------ */

function honest(state: StateDoc, logs: Map<string, Log>, serverNow: Date): boolean {
  const named = (id: string | null, at: Date | null, uid: string | null, name: string | null) => {
    if (id === null) return at === null && uid === null && name === null;
    const log = logs.get(id);
    return nameable(log) && timeOf(log) === at?.getTime() && log.loggedByUid === uid && log.loggedByName === name;
  };
  if (!named(state.lastLogId, state.lastFedAt, state.lastFedByUid, state.lastFedByName)) return false;
  if (!state.prev) return true;
  return state.prev.logId !== state.lastLogId && named(state.prev.logId, state.prev.at, state.prev.byUid, state.prev.byName) &&
    state.lastFedAt !== null && clamp(state.prev.at.getTime(), serverNow) <= clamp(state.lastFedAt.getTime(), serverNow);
}

function moveAllowed(before: StateDoc | null, after: StateDoc, logsAfter: Map<string, Log>, serverNow: Date): boolean {
  if (!before || before.lastLogId === null || after.lastLogId === before.lastLogId) return true;
  const old = logsAfter.get(before.lastLogId);
  if (!old || typeof old.date === 'string' || timeOf(old) !== before.lastFedAt?.getTime()) return true;
  return after.lastFedAt !== null && before.lastFedAt !== null &&
    clamp(after.lastFedAt.getTime(), serverNow) >= clamp(before.lastFedAt.getTime(), serverNow);
}

const rulesRecent = (before: StateDoc | null, logsBefore: Map<string, Log>, serverNow: Date) =>
  Boolean(before?.lastLogId && before.lastFedAt && logsBefore.has(before.lastLogId) && serverNow.getTime() < before.lastFedAt.getTime() + FEED_REPEAT_WINDOW_MS);

function rulesBound(before: StateDoc | null, logsBefore: Map<string, Log>, confirmOf: string | null, serverNow: Date): boolean {
  const latest = before?.lastLogId ?? null;
  if (!latest || !logsBefore.has(latest) || confirmOf === latest) return true;
  const named = confirmOf ? logsBefore.get(confirmOf) : undefined;
  return nameable(named) && before!.lastFedAt !== null &&
    clamp(timeOf(named), serverNow) >= clamp(before!.lastFedAt.getTime(), serverNow);
}

/* ---- the reference: what the surviving logs imply ----------------------- */

function expected(logs: Map<string, Log>, deviceNow: Date, liveId: string | null) {
  const limit = deviceNow.getTime() + SKEW;
  const sorted = [...logs.values()]
    .filter((log) => nameable(log) && timeOf(log) <= limit)
    // A live feed first, then the latest stored date; equal dates by id (the documented tie-break).
    .sort((a, b) => Number(b.id === liveId) - Number(a.id === liveId) || timeOf(b) - timeOf(a) || a.id.localeCompare(b.id));
  const today = petDay(deviceNow, TZ);
  // Counted as readers count: every date shape; a time ahead (within the allowance) counts as now.
  const seen = (log: Log) => (timeOf(log) > limit ? null : new Date(Math.min(timeOf(log), deviceNow.getTime())));
  return {
    latest: sorted[0]?.id ?? null,
    latestAt: sorted[0] ? timeOf(sorted[0]) : null,
    prev: sorted[1]?.id ?? null,
    prevAt: sorted[1] ? timeOf(sorted[1]) : null,
    countOnDay: [...logs.values()].filter((log) => {
      const day = seen(log);
      return day !== null && petDay(day, TZ) === today;
    }).length,
  };
}

/* ---- the run ------------------------------------------------------------ */

function prng(seed: number) {
  let value = seed >>> 0;
  return () => {
    value = (value * 1664525 + 1013904223) >>> 0;
    return value / 2 ** 32;
  };
}

function run(seed: number, steps: number, slots = false) {
  const random = prng(seed);
  const pick = <T,>(items: T[]) => items[Math.floor(random() * items.length)];
  const users = [{ uid: 'sam', name: 'Sam' }, { uid: 'alex', name: 'Alex' }, { uid: 'kim', name: 'Kim' }];
  const logs = new Map<string, Log>();
  let state: StateDoc | null = null;
  let serverNow = new Date('2026-11-01T12:00:00Z').getTime(); // spans the fall-back DST change
  let next = 0;
  const trace: string[] = [];

  const snapshotFor = (deviceNow: Date) => {
    const stored = state ? readFeedingState({ ...state, prev: state.prev ? { lastLogId: state.prev.logId } : null }) : null;
    return {
      now: deviceNow,
      timeZone: TZ,
      perDay: slots ? null : PER_DAY,
      dayPlan: slots ? planForDay(SLOT_PET, petDay(deviceNow, TZ)) : null,
      stored,
      latestSurvives: Boolean(state?.lastLogId && logs.has(state.lastLogId)),
      recent: [...logs.values()],
      known: null,
      existing: null,
    };
  };
  const check = (label: string, before: StateDoc | null, after: StateDoc, deviceNow: Date, serverNow: Date, liveId: string | null) => {
    const want = expected(logs, deviceNow, liveId);
    const where = `seed ${seed}, ${trace.join(' > ')} > ${label}; logs (min from server now): ${[...logs.values()].map((log) => `${log.id}${typeof log.date === 'string' ? 's' : ''}@${Math.round((timeOf(log) - serverNow.getTime()) / MIN)}`).join(' ')}; device ${Math.round((deviceNow.getTime() - serverNow.getTime()) / MIN)}`;
    assert.equal(after.lastLogId, want.latest, `latest: ${where}`);
    assert.equal(after.lastFedAt?.getTime() ?? null, want.latestAt, `lastFedAt: ${where}`);
    assert.equal(after.prev?.logId ?? null, want.prev, `prev: ${where}`);
    assert.equal(after.prev?.at.getTime() ?? null, want.prevAt, `prev time: ${where}`);
    assert.equal(after.countOnDay, want.countOnDay, `count: ${where}`);
    if (slots) assert.deepEqual(after.slotsFed ?? {}, expectedSlotsFed(logs, deviceNow), `slotsFed: ${where}`);
    assert.ok(honest(after, logs, serverNow), `rules refuse the state (not honest): ${where}`);
    assert.ok(moveAllowed(before, after, logs, serverNow), `rules refuse the state (latest moved back): ${where}`);
  };

  for (let step = 0; step < steps; step += 1) {
    serverNow += Math.floor(1 + random() * 240) * MIN;
    const server = new Date(serverNow);
    let skew = Math.round((random() * 10 - 5) * MIN); // device clock within ±5 min
    // Within minutes of household midnight the day is the writer's clock estimate (documented); keep both on one day.
    if (petDay(new Date(serverNow + skew), TZ) !== petDay(server, TZ)) skew = 0;
    const device = new Date(serverNow + skew);
    const user = pick(users);
    const op = pick(['live', 'live', 'offline', 'offline', 'legacy', 'backdated', 'delete', 'correct']);
    const before = state;
    const logsBefore = new Map(logs);

    if (op === 'live' || op === 'backdated') {
      const id = `log-${next++}`;
      const backdatedAt = op === 'backdated' ? new Date(serverNow - Math.floor(60 + random() * 3000) * MIN) : undefined;
      const intent = { userUid: user.uid, userName: user.name, logId: id, backdatedAt };
      let plan = planFeed(snapshotFor(device), intent);
      if (plan.kind === 'needsConfirm') {
        // What the member is shown is a feeding the rules can bind a confirmation to, never older than the state's.
        if (plan.check.lastLogId) {
          assert.ok(nameable(logsBefore.get(plan.check.lastLogId)), `asked about a feeding the rules cannot name: seed ${seed}, ${trace.join(' > ')}`);
          assert.ok(rulesBound(before, logsBefore, plan.check.lastLogId, server), `asked about a feeding older than the state names: seed ${seed}, ${trace.join(' > ')}`);
        }
        const confirm = feedConfirmOf(plan.check);
        assert.ok(confirmStillHolds(confirm, plan.check));
        plan = planFeed(snapshotFor(device), { ...intent, confirm });
      }
      assert.equal(plan.kind, 'write', `a confirmed feed writes: seed ${seed}`);
      if (plan.kind !== 'write') continue;
      const after = stateDoc(plan.state, plan.live ? { id, serverNow: server } : null);
      if (plan.live && plan.repeat === 'none' && slots) {
        // D-P5: a plain feed with slots is always for a slot, and the rules' slot check accepts it (not the 90-minute one).
        assert.ok(plan.slot, `planned plain without a slot on a slot pet: seed ${seed}, ${trace.join(' > ')}`);
        assert.ok(rulesSlotFree(before, after, logsBefore, id, plan.slot!.id), `planned plain for a slot the rules see fed: seed ${seed}, ${trace.join(' > ')} > ${op}`);
      } else if (plan.live && plan.repeat === 'none') {
        assert.ok(!rulesRecent(before, logsBefore, server), `planned plain but the rules see a recent feed: seed ${seed}, ${trace.join(' > ')} > ${op}`);
        assert.ok(plan.state.countOnDay <= PER_DAY, `planned plain past a complete day: seed ${seed}`);
      }
      if (plan.live && plan.repeat === 'confirmed') assert.ok(rulesBound(before, logsBefore, plan.confirmOf, server), `confirmation not bound: seed ${seed}, ${trace.join(' > ')}`);
      if (!plan.live || !slots) assert.equal(plan.slot ?? null, null, 'only live feeds of a slot pet carry a slot');
      const date = plan.live ? server : backdatedAt!;
      logs.set(id, { id, date, loggedByUid: user.uid, loggedByName: user.name, ...(plan.slot ? { slotId: plan.slot.id } : {}) });
      state = after;
      trace.push(`${op}:${id}`);
      check(op, before, state, device, server, plan.live ? id : null);
    } else if (op === 'offline') {
      // Synced from a device whose clock may run ahead, up to the supported skew (less both clocks' margins).
      const id = `log-${next++}`;
      const ahead = random() < 0.4 ? Math.floor(random() * (SKEW - 10 * MIN)) : -Math.floor(random() * 30) * MIN;
      logs.set(id, { id, date: new Date(serverNow + ahead), loggedByUid: user.uid, loggedByName: user.name });
      trace.push(`offline:${id}${ahead > 0 ? '+' : ''}`);
    } else if (op === 'legacy') {
      // A legacy entry (before the feed operation) with an ISO-string date.
      const id = `log-${next++}`;
      logs.set(id, { id, date: new Date(serverNow - Math.floor(1 + random() * 3000) * MIN).toISOString(), loggedByUid: user.uid, loggedByName: user.name });
      trace.push(`legacy:${id}`);
    } else if (logs.size > 0) {
      const target = pick([...logs.keys()].sort());
      if (op === 'delete') {
        const derived = planFeedDelete({ now: device, timeZone: TZ, logs: [...logs.values()], logId: target, hasState: state !== null, slots: Boolean(state?.slotsFed) });
        logs.delete(target);
        trace.push(`delete:${target}`);
        if (derived) {
          state = stateDoc(derived, null);
          check(op, before, state, device, server, null);
        }
      } else {
        const newDate = new Date(serverNow - Math.floor(1 + random() * 3000) * MIN);
        const derived = planFeedCorrection({ now: device, timeZone: TZ, logs: [...logs.values()], logId: target, newDate, hasState: state !== null, slots: Boolean(state?.slotsFed) });
        logs.set(target, { ...logs.get(target)!, date: newDate });
        trace.push(`correct:${target}`);
        if (derived) {
          state = stateDoc(derived, null);
          check(op, before, state, device, server, null);
        }
      }
    }
  }
}

describe('the feeding state always reflects the surviving logs by effective time (model test)', () => {
  it('holds over 300 random sequences of every feeding write: device clocks ±5 min, offline clocks ahead, legacy string dates', () => {
    for (let seed = 1; seed <= 300; seed += 1) run(seed, 40);
  });

  it('holds with meal slots too: slot-assigned feeds, slotsFed derived from the logs, plain slot feeds the rules accept (D-P5)', () => {
    // 120 sequences: each step also computes the slot status, about three times the plain run's cost.
    for (let seed = 1; seed <= 120; seed += 1) run(seed, 40, true);
  });

  it('derives latest, previous and today’s count from the logs alone', () => {
    const now = new Date('2026-11-10T18:00:00Z');
    const derived = deriveFeedingState([
      { id: 'a', date: new Date('2026-11-10T14:00:00Z'), loggedByUid: 'sam', loggedByName: 'Sam' },
      { id: 'b', date: new Date('2026-11-10T16:00:00Z'), loggedByUid: 'kim', loggedByName: 'Kim' },
      { id: 'legacy', date: '2026-11-10T17:00:00.000Z' }, // an ISO-string date: counted, never named
      { id: 'far', date: new Date('2026-11-11T18:00:00Z') }, // beyond the clock-skew allowance: ignored
    ], { now, timeZone: TZ });
    assert.equal(derived.latest?.logId, 'b');
    assert.equal(derived.prev?.logId, 'a');
    assert.equal(derived.countOnDay, 3);
    assert.equal(derived.day, '2026-11-10');
    // A live feed is the latest whatever the order of the clocks.
    assert.equal(deriveFeedingState([{ id: 'n', date: new Date('2026-11-10T17:59:00Z') }, { id: 'b', date: new Date('2026-11-10T18:01:00Z') }], { now, timeZone: TZ, latestId: 'n' }).latest?.logId, 'n');
    assert.deepEqual(deriveFeedingState([], { now, timeZone: TZ }), { latest: null, prev: null, day: '2026-11-10', countOnDay: 0 });
  });
});
