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

const TZ = 'America/Chicago';
const MIN = 60_000;
const PER_DAY = 2;

type Log = { id: string; date: Date; loggedByUid: string; loggedByName: string };
type Ref = { logId: string; at: Date; byUid: string | null; byName: string | null };
type StateDoc = { lastLogId: string | null; lastFedAt: Date | null; lastFedByUid: string | null; lastFedByName: string | null; day: string; countOnDay: number; prev: Ref | null };

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
  };
}

/* ---- the rules, mirrored ------------------------------------------------ */

function honest(state: StateDoc, logs: Map<string, Log>): boolean {
  const named = (id: string | null, at: Date | null, uid: string | null, name: string | null) => {
    if (id === null) return at === null && uid === null && name === null;
    const log = logs.get(id);
    return Boolean(log) && log!.date.getTime() === at?.getTime() && log!.loggedByUid === uid && log!.loggedByName === name;
  };
  if (!named(state.lastLogId, state.lastFedAt, state.lastFedByUid, state.lastFedByName)) return false;
  if (!state.prev) return true;
  return state.prev.logId !== state.lastLogId && named(state.prev.logId, state.prev.at, state.prev.byUid, state.prev.byName) &&
    state.lastFedAt !== null && state.prev.at.getTime() <= state.lastFedAt.getTime();
}

function moveAllowed(before: StateDoc | null, after: StateDoc, logsAfter: Map<string, Log>): boolean {
  if (!before || before.lastLogId === null || after.lastLogId === before.lastLogId) return true;
  const old = logsAfter.get(before.lastLogId);
  if (!old || old.date.getTime() !== before.lastFedAt?.getTime()) return true;
  return after.lastFedAt !== null && before.lastFedAt !== null && after.lastFedAt.getTime() >= before.lastFedAt.getTime();
}

const rulesRecent = (before: StateDoc | null, logsBefore: Map<string, Log>, serverNow: Date) =>
  Boolean(before?.lastLogId && before.lastFedAt && logsBefore.has(before.lastLogId) && serverNow.getTime() < before.lastFedAt.getTime() + FEED_REPEAT_WINDOW_MS);

function rulesBound(before: StateDoc | null, logsBefore: Map<string, Log>, confirmOf: string | null): boolean {
  const latest = before?.lastLogId ?? null;
  if (!latest || !logsBefore.has(latest) || confirmOf === latest) return true;
  const named = confirmOf ? logsBefore.get(confirmOf) : undefined;
  return Boolean(named && before!.lastFedAt && named.date.getTime() >= before!.lastFedAt.getTime());
}

/* ---- the reference: what the surviving logs imply ----------------------- */

function expected(logs: Map<string, Log>, deviceNow: Date) {
  const sorted = [...logs.values()].sort((a, b) => b.date.getTime() - a.date.getTime());
  const today = petDay(deviceNow, TZ);
  return {
    latest: sorted[0]?.id ?? null,
    latestAt: sorted[0]?.date.getTime() ?? null,
    prev: sorted[1]?.id ?? null,
    prevAt: sorted[1]?.date.getTime() ?? null,
    countOnDay: sorted.filter((log) => petDay(log.date, TZ) === today).length,
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

function run(seed: number, steps: number) {
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
      perDay: PER_DAY,
      stored,
      latestSurvives: Boolean(state?.lastLogId && logs.has(state.lastLogId)),
      recent: [...logs.values()],
      known: null,
      existing: null,
    };
  };
  const check = (label: string, before: StateDoc | null, after: StateDoc, deviceNow: Date) => {
    const want = expected(logs, deviceNow);
    const where = `seed ${seed}, ${trace.join(' > ')} > ${label}`;
    assert.equal(after.lastLogId, want.latest, `latest: ${where}`);
    assert.equal(after.lastFedAt?.getTime() ?? null, want.latestAt, `lastFedAt: ${where}`);
    assert.equal(after.prev?.logId ?? null, want.prev, `prev: ${where}`);
    assert.equal(after.prev?.at.getTime() ?? null, want.prevAt, `prev time: ${where}`);
    assert.equal(after.countOnDay, want.countOnDay, `count: ${where}`);
    assert.ok(honest(after, logs), `rules refuse the state (not honest): ${where}`);
    assert.ok(moveAllowed(before, after, logs), `rules refuse the state (latest moved back): ${where}`);
  };

  for (let step = 0; step < steps; step += 1) {
    serverNow += Math.floor(1 + random() * 240) * MIN;
    const server = new Date(serverNow);
    let skew = Math.round((random() * 10 - 5) * MIN); // device clock within ±5 min
    // Within minutes of household midnight the day is the writer's clock estimate (documented); keep both on one day.
    if (petDay(new Date(serverNow + skew), TZ) !== petDay(server, TZ)) skew = 0;
    const device = new Date(serverNow + skew);
    const user = pick(users);
    const op = pick(['live', 'live', 'offline', 'backdated', 'delete', 'correct']);
    const before = state;
    const logsBefore = new Map(logs);

    if (op === 'live' || op === 'backdated') {
      const id = `log-${next++}`;
      const backdatedAt = op === 'backdated' ? new Date(serverNow - Math.floor(60 + random() * 3000) * MIN) : undefined;
      const intent = { userUid: user.uid, userName: user.name, logId: id, backdatedAt };
      let plan = planFeed(snapshotFor(device), intent);
      if (plan.kind === 'needsConfirm') {
        const confirm = feedConfirmOf(plan.check);
        assert.ok(confirmStillHolds(confirm, plan.check));
        plan = planFeed(snapshotFor(device), { ...intent, confirm });
      }
      assert.equal(plan.kind, 'write', `a confirmed feed writes: seed ${seed}`);
      if (plan.kind !== 'write') continue;
      if (plan.live && plan.repeat === 'none') {
        assert.ok(!rulesRecent(before, logsBefore, server), `planned plain but the rules see a recent feed: seed ${seed}, ${trace.join(' > ')} > ${op}`);
        assert.ok(plan.state.countOnDay <= PER_DAY, `planned plain past a complete day: seed ${seed}`);
      }
      if (plan.live && plan.repeat === 'confirmed') assert.ok(rulesBound(before, logsBefore, plan.confirmOf), `confirmation not bound: seed ${seed}`);
      const date = plan.live ? server : backdatedAt!;
      logs.set(id, { id, date, loggedByUid: user.uid, loggedByName: user.name });
      state = stateDoc(plan.state, plan.live ? { id, serverNow: server } : null);
      trace.push(`${op}:${id}`);
      check(op, before, state, device);
    } else if (op === 'offline') {
      const id = `log-${next++}`;
      logs.set(id, { id, date: new Date(serverNow - Math.floor(random() * 30) * MIN), loggedByUid: user.uid, loggedByName: user.name });
      trace.push(`offline:${id}`);
    } else if (logs.size > 0) {
      const target = pick([...logs.keys()].sort());
      if (op === 'delete') {
        const derived = planFeedDelete({ now: device, timeZone: TZ, logs: [...logs.values()], logId: target, hasState: state !== null });
        logs.delete(target);
        trace.push(`delete:${target}`);
        if (derived) {
          state = stateDoc(derived, null);
          check(op, before, state, device);
        }
      } else {
        const newDate = new Date(serverNow - Math.floor(1 + random() * 3000) * MIN);
        const derived = planFeedCorrection({ now: device, timeZone: TZ, logs: [...logs.values()], logId: target, newDate, hasState: state !== null });
        logs.set(target, { ...logs.get(target)!, date: newDate });
        trace.push(`correct:${target}`);
        if (derived) {
          state = stateDoc(derived, null);
          check(op, before, state, device);
        }
      }
    }
  }
}

describe('the feeding state always reflects the surviving logs by effective time (model test)', () => {
  it('holds over 300 random sequences of every feeding write, with device clocks ±5 min', () => {
    for (let seed = 1; seed <= 300; seed += 1) run(seed, 40);
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
