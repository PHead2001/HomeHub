import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import {
  CORRECTION_FUTURE_MARGIN_MS,
  checkFeedCorrection,
  confirmStillHolds,
  feedConfirmOf,
  feedingTimes,
  feedLogId,
  mayCorrectFeedTime,
  newFeedOpId,
  planCorrectionState,
  planFeed,
  planOfflineFeed,
  type FeedSnapshot,
} from '../../src/lib/pets/feed-plan';
import { petFeedToastGroup, type FeedingStateView } from '../../src/lib/pets/feed-decision';

const CHI = 'America/Chicago';
const at = (iso: string) => new Date(iso);
const minutes = (n: number) => n * 60_000;
// 2026-11-10 09:00 in Chicago.
const NOW = at('2026-11-10T15:00:00Z');

function state(overrides: Partial<FeedingStateView> = {}): FeedingStateView {
  return {
    lastLogId: 'sam-1',
    lastFedAt: new Date(NOW.getTime() - minutes(12)),
    lastFedByUid: 'sam',
    lastFedByName: 'Sam',
    day: '2026-11-10',
    countOnDay: 1,
    hasPrev: false,
    prevLogId: null,
    ...overrides,
  };
}

function snapshot(overrides: Partial<FeedSnapshot> = {}): FeedSnapshot {
  return {
    now: NOW,
    timeZone: CHI,
    perDay: 2,
    stored: state(),
    latestSurvives: true,
    recent: [{ id: 'sam-1', date: new Date(NOW.getTime() - minutes(12)), loggedByUid: 'sam', loggedByName: 'Sam' }],
    known: null,
    existing: null,
    ...overrides,
  };
}

describe('feed plan: one press is one feeding (PE-23h)', () => {
  it('derives the log id from the operation id, create-only', () => {
    const opId = newFeedOpId();
    assert.equal(feedLogId(opId), opId);
    assert.notEqual(newFeedOpId(), opId);
    assert.throws(() => feedLogId(''), /invalid-feed-operation/);
    assert.throws(() => feedLogId('a/b/c/d/e/f'), /invalid-feed-operation/);
    assert.throws(() => feedLogId('short'), /invalid-feed-operation/);
  });

  it('a press whose log already exists is reported as recorded and writes nothing', () => {
    const plan = planFeed(snapshot({ existing: { loggedByUid: 'alex' } }), { userUid: 'alex' });
    assert.deepEqual(plan, { kind: 'already', countToday: 1, perDay: 2 });
    // Even when the state says "fed 12 min ago" (the replay must not ask "Feed again?" about itself).
  });

  it('never claims someone else’s log under the same id', () => {
    assert.throws(() => planFeed(snapshot({ existing: { loggedByUid: 'sam' } }), { userUid: 'alex' }), /feed-operation-conflict/);
  });
});

describe('feed plan: "Feed again?" is bound to the state it was shown for (PE-23g)', () => {
  it('asks inside 90 minutes and names the last feed', () => {
    const plan = planFeed(snapshot(), { userUid: 'alex' });
    assert.equal(plan.kind, 'needsConfirm');
    if (plan.kind !== 'needsConfirm') return;
    assert.equal(plan.check.reason, 'recent');
    assert.equal(plan.check.lastLogId, 'sam-1');
    assert.equal(plan.staleConfirm, false);
    assert.deepEqual(feedConfirmOf(plan.check), { lastLogId: 'sam-1', countToday: 1 });
  });

  it('a current answer writes a confirmed feed bound to that last feed', () => {
    const plan = planFeed(snapshot(), { userUid: 'alex', confirm: { lastLogId: 'sam-1', countToday: 1 } });
    assert.equal(plan.kind, 'write');
    if (plan.kind !== 'write') return;
    assert.equal(plan.repeat, 'confirmed');
    assert.equal(plan.confirmOf, 'sam-1');
    assert.equal(plan.live, true);
    assert.deepEqual(plan.state, { kind: 'latest', day: '2026-11-10', countOnDay: 2 });
    assert.equal(plan.countToday, 2);
  });

  it('a stale answer (someone fed since) asks again with the newer feeder', () => {
    const newer = snapshot({
      stored: state({ lastLogId: 'kim-1', lastFedAt: new Date(NOW.getTime() - minutes(1)), lastFedByUid: 'kim', lastFedByName: 'Kim', countOnDay: 2 }),
      recent: [
        { id: 'sam-1', date: new Date(NOW.getTime() - minutes(12)), loggedByUid: 'sam', loggedByName: 'Sam' },
        { id: 'kim-1', date: new Date(NOW.getTime() - minutes(1)), loggedByUid: 'kim', loggedByName: 'Kim' },
      ],
    });
    const plan = planFeed(newer, { userUid: 'alex', confirm: { lastLogId: 'sam-1', countToday: 1 } });
    assert.equal(plan.kind, 'needsConfirm');
    if (plan.kind !== 'needsConfirm') return;
    assert.equal(plan.staleConfirm, true);
    assert.equal(plan.check.lastFedByName, 'Kim');
    assert.equal(plan.check.lastLogId, 'kim-1');
  });

  it('a changed count (a feeding added or removed meanwhile) also makes the answer stale', () => {
    assert.equal(confirmStillHolds({ lastLogId: 'sam-1', countToday: 0 }, { lastLogId: 'sam-1', countToday: 1 }), false);
    assert.equal(confirmStillHolds(null, { lastLogId: 'sam-1', countToday: 1 }), false);
    assert.equal(confirmStillHolds({ lastLogId: null, countToday: 2 }, { lastLogId: null, countToday: 2 }), true);
  });

  it('when the question no longer applies (Undo of the feed asked about), the feed is plain', () => {
    const undone = snapshot({ stored: state({ lastLogId: null, lastFedAt: null, lastFedByUid: null, lastFedByName: null, countOnDay: 0 }), recent: [] });
    const plan = planFeed(undone, { userUid: 'alex', confirm: { lastLogId: 'sam-1', countToday: 1 } });
    assert.equal(plan.kind, 'write');
    assert.equal(plan.kind === 'write' && plan.repeat, 'none');
  });

  it('a complete day asks; the 90-minute window wins as the reason', () => {
    const old = new Date(NOW.getTime() - minutes(120));
    const complete = snapshot({
      stored: state({ lastFedAt: old, countOnDay: 2 }),
      recent: [
        { id: 'a', date: new Date(NOW.getTime() - minutes(180)), loggedByName: 'Sam' },
        { id: 'sam-1', date: old, loggedByName: 'Sam', loggedByUid: 'sam' },
      ],
    });
    const plan = planFeed(complete, { userUid: 'alex' });
    assert.equal(plan.kind === 'needsConfirm' && plan.check.reason, 'complete');
    // Slots (P2) will replace the reason here; the binding and the write stay the same.
    const confirmed = planFeed(complete, { userUid: 'alex', confirm: { lastLogId: 'sam-1', countToday: 2 } });
    assert.equal(confirmed.kind === 'write' && confirmed.repeat, 'confirmed');
    assert.equal(confirmed.kind === 'write' && confirmed.countToday, 3);
  });

  it('a latest feed deleted offline is not a feed to repeat', () => {
    const plan = planFeed(snapshot({ latestSurvives: false, recent: [] }), { userUid: 'alex' });
    assert.equal(plan.kind, 'write');
    assert.equal(plan.kind === 'write' && plan.repeat, 'none');
  });

  it('backdated entries skip the check; an older one only changes the count of its own day', () => {
    const older = planFeed(snapshot(), { userUid: 'alex', backdatedAt: new Date(NOW.getTime() - minutes(60)) });
    assert.equal(older.kind, 'write');
    if (older.kind !== 'write') return;
    assert.equal(older.live, false);
    assert.deepEqual(older.state, { kind: 'count', day: '2026-11-10', countOnDay: 2 });
    const yesterday = planFeed(snapshot(), { userUid: 'alex', backdatedAt: at('2026-11-09T15:00:00Z') });
    assert.equal(yesterday.kind === 'write' && yesterday.state, null);
    // Today's count stays as it was.
    assert.equal(yesterday.kind === 'write' && yesterday.countToday, 1);
  });

  it('offline: the same binding from what the device has cached', () => {
    const cached = { now: NOW, timeZone: CHI, perDay: 2, stored: state(), known: null };
    const asked = planOfflineFeed(cached, { userUid: 'alex' });
    assert.equal(asked.kind, 'needsConfirm');
    const answered = planOfflineFeed(cached, { userUid: 'alex', confirm: { lastLogId: 'sam-1', countToday: 1 } });
    assert.deepEqual(answered, { kind: 'write', fedAt: NOW, countToday: 2, perDay: 2 });
    const stale = planOfflineFeed(cached, { userUid: 'alex', confirm: { lastLogId: 'other', countToday: 1 } });
    assert.equal(stale.kind === 'needsConfirm' && stale.staleConfirm, true);
  });
});

describe('correcting a feeding time (PE-5e)', () => {
  const log = { loggedByUid: 'sam', loggedAt: new Date(NOW.getTime() - minutes(3)), date: new Date(NOW.getTime() - minutes(3)) };

  it('its author within 10 minutes, or pets.deleteLogs at any time', () => {
    assert.equal(mayCorrectFeedTime(log, 'sam', false, NOW), true);
    assert.equal(mayCorrectFeedTime(log, 'alex', false, NOW), false);
    assert.equal(mayCorrectFeedTime(log, 'sam', false, new Date(NOW.getTime() + minutes(8))), false);
    assert.equal(mayCorrectFeedTime({ ...log, loggedAt: undefined }, 'sam', false, NOW), false);
    assert.equal(mayCorrectFeedTime({ ...log, loggedAt: undefined }, 'alex', true, NOW), true);
  });

  it('never into the future: one minute in the form, the 12-hour skew allowance in the rules', () => {
    const base = { log, viewerUid: 'sam', canDeleteLogs: false, now: NOW };
    assert.deepEqual(checkFeedCorrection({ ...base, newDate: new Date(NOW.getTime() - minutes(40)) }), { ok: true });
    assert.deepEqual(checkFeedCorrection({ ...base, newDate: new Date(NOW.getTime() + minutes(2)), futureMarginMs: CORRECTION_FUTURE_MARGIN_MS }), { ok: false, reason: 'future' });
    assert.deepEqual(checkFeedCorrection({ ...base, newDate: new Date(NOW.getTime() + minutes(2)) }), { ok: true });
    assert.deepEqual(checkFeedCorrection({ ...base, newDate: new Date(NOW.getTime() + minutes(13 * 60)) }), { ok: false, reason: 'future' });
    assert.deepEqual(checkFeedCorrection({ ...base, newDate: log.date }), { ok: false, reason: 'unchanged' });
    assert.deepEqual(checkFeedCorrection({ ...base, newDate: new Date(Number.NaN) }), { ok: false, reason: 'invalid' });
    assert.deepEqual(checkFeedCorrection({ ...base, viewerUid: 'alex', newDate: new Date(NOW.getTime() - minutes(40)) }), { ok: false, reason: 'not-allowed' });
  });

  it('the latest feed’s time follows its log, and today’s count is recounted', () => {
    const stored = state();
    const recent = [{ id: 'sam-1', date: new Date(NOW.getTime() - minutes(12)) }];
    // Moved to yesterday evening: no longer today's.
    assert.deepEqual(
      planCorrectionState({ stored, logId: 'sam-1', newDate: at('2026-11-10T03:00:00Z'), recent, now: NOW, timeZone: CHI }),
      { lastFedAt: at('2026-11-10T03:00:00Z'), day: '2026-11-10', countOnDay: 0 },
    );
    // An older log moved from yesterday into today: only the count.
    assert.deepEqual(
      planCorrectionState({ stored, logId: 'old', newDate: at('2026-11-10T13:00:00Z'), recent, now: NOW, timeZone: CHI }),
      { day: '2026-11-10', countOnDay: 2 },
    );
    assert.equal(planCorrectionState({ stored: null, logId: 'x', newDate: NOW, recent, now: NOW, timeZone: CHI }), null);
    assert.equal(planCorrectionState({ stored, logId: 'old', newDate: at('2026-11-08T13:00:00Z'), recent, now: NOW, timeZone: CHI }), null);
  });

  it('history shows the recorded time only when it tells something', () => {
    const live = feedingTimes({ date: NOW, loggedAt: NOW });
    assert.equal(live.showRecorded, false);
    assert.equal(feedingTimes({ date: new Date(NOW.getTime() - minutes(90)), loggedAt: NOW, backdated: true }).showRecorded, true);
    assert.equal(feedingTimes({ date: NOW, loggedAt: new Date(NOW.getTime() + minutes(300)), repeat: 'offline' }).showRecorded, true);
    const corrected = feedingTimes({ date: NOW, loggedAt: NOW, originalDate: at('2026-11-10T20:00:00Z'), dateCorrectedAt: NOW, dateCorrectedByName: 'Sam' });
    assert.equal(corrected.showRecorded, true);
    assert.deepEqual(corrected.corrected, { from: at('2026-11-10T20:00:00Z'), byName: 'Sam' });
    assert.equal(feedingTimes({ date: new Date(0), loggedAt: NOW }).effective, null);
  });
});

describe('feeding Undo toasts: one group per pet (PE-8i, D-P13)', () => {
  const read = (file: string) => readFileSync(resolve(process.cwd(), file), 'utf8');

  it('feeding a second pet keeps the first pet’s Undo', () => {
    assert.notEqual(petFeedToastGroup('rex'), petFeedToastGroup('maple'));
    assert.equal(petFeedToastGroup('rex'), petFeedToastGroup('rex'));
    const ui = read('src/components/pets/use-feed-action.tsx');
    assert.match(ui, /group: petFeedToastGroup\(petId\)/);
    assert.doesNotMatch(ui, /group: 'pet-feed'/);
    assert.match(read('src/components/command/command-palette.tsx'), /group: petFeedToastGroup\(pet\.id\)/);
  });

  it('every press takes one operation id; "Feed again" and Retry reuse it with the bound answer', () => {
    const ui = read('src/components/pets/use-feed-action.tsx');
    assert.match(ui, /execute\(\{ request, opId: newFeedOpId\(\), confirm: null \}\)/);
    assert.match(ui, /attempt: \{ request, opId, confirm: feedConfirmOf\(result\) \}/);
    assert.match(ui, /retryRef\.current\(attempt\)/);
    const palette = read('src/components/command/command-palette.tsx');
    assert.match(palette, /feedOp\.current = \{ intent: current, opId: newFeedOpId\(\) \}/);
    assert.match(palette, /confirm: feedConfirmOf\(result\)/);
  });
});
