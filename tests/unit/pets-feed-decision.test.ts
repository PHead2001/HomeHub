import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import {
  AUTHOR_DELETE_WINDOW_MS,
  authorMayDelete,
  becomesLatest,
  countAfterFeed,
  FEED_REPEAT_WINDOW_MS,
  FEED_UNDO_MS,
  feedAgainPrompt,
  feedConfirmDecision,
  householdDay,
  knownFromLogs,
  planUndo,
  readFeedingState,
  countOnHouseholdDay,
  householdDayStart,
  newerKnown,
  withSurvivingLatest,
  type FeedingStateView,
} from '../../src/lib/pets/feed-decision';

const CHI = 'America/Chicago';
const at = (iso: string) => new Date(iso);
const minutes = (n: number) => n * 60_000;

function state(overrides: Partial<FeedingStateView> = {}): FeedingStateView {
  return {
    lastLogId: 'log-1',
    lastFedAt: at('2026-11-10T14:00:00Z'),
    lastFedByUid: 'sam',
    lastFedByName: 'Sam',
    day: '2026-11-10',
    countOnDay: 1,
    hasPrev: true,
    prevLogId: 'log-0',
    ...overrides,
  };
}

describe('feed operation: the "Feed again?" check (PE-23)', () => {
  it('asks inside the 90-minute window and not after it', () => {
    const fedAt = at('2026-11-10T14:00:00Z');
    const base = { state: state({ lastFedAt: fedAt }), timeZone: CHI, perDay: 3 };
    const inside = feedConfirmDecision({ ...base, now: new Date(fedAt.getTime() + minutes(12)) });
    assert.equal(inside.needsConfirm, true);
    assert.equal(inside.reason, 'recent');
    assert.equal(inside.lastFedByName, 'Sam');
    assert.equal(feedConfirmDecision({ ...base, now: new Date(fedAt.getTime() + FEED_REPEAT_WINDOW_MS - 1) }).needsConfirm, true);
    const after = feedConfirmDecision({ ...base, now: new Date(fedAt.getTime() + FEED_REPEAT_WINDOW_MS) });
    assert.equal(after.needsConfirm, false);
    assert.equal(after.reason, null);
    // A time from a device clock that runs ahead still counts as recent.
    assert.equal(feedConfirmDecision({ ...base, now: new Date(fedAt.getTime() - minutes(5)) }).reason, 'recent');
    assert.equal(FEED_REPEAT_WINDOW_MS, 90 * 60_000);
  });

  it('asks when today is complete, from the pet schedule when known', () => {
    const now = at('2026-11-10T22:00:00Z'); // 16:00 in Chicago, 8 h after the last feed
    const done = state({ lastFedAt: at('2026-11-10T14:00:00Z'), countOnDay: 2 });
    const check = feedConfirmDecision({ state: done, now, timeZone: CHI, perDay: 2 });
    assert.equal(check.needsConfirm, true);
    assert.equal(check.reason, 'complete');
    assert.equal(feedConfirmDecision({ state: done, now, timeZone: CHI, perDay: 3 }).needsConfirm, false);
    // No schedule (no daily target): only the 90-minute window applies.
    assert.equal(feedConfirmDecision({ state: done, now, timeZone: CHI, perDay: null }).needsConfirm, false);
  });

  it('a new household day starts a new count (midnight in the household zone, not UTC or the device)', () => {
    const done = state({ lastFedAt: at('2026-11-10T14:00:00Z'), day: '2026-11-10', countOnDay: 2 });
    // 05:30 UTC on Nov 11 is still 23:30 on Nov 10 in Chicago: today is complete.
    assert.equal(householdDay(at('2026-11-11T05:30:00Z'), CHI), '2026-11-10');
    assert.equal(feedConfirmDecision({ state: done, now: at('2026-11-11T05:30:00Z'), timeZone: CHI, perDay: 2 }).reason, 'complete');
    // 06:30 UTC is 00:30 on Nov 11 in Chicago: a new day, nothing complete yet.
    const next = feedConfirmDecision({ state: done, now: at('2026-11-11T06:30:00Z'), timeZone: CHI, perDay: 2 });
    assert.equal(next.needsConfirm, false);
    assert.equal(next.countToday, 0);
    // A missing or bad zone falls back to the default household zone.
    assert.equal(householdDay(at('2026-11-11T05:30:00Z'), 'Mars/Base'), '2026-11-10');
    assert.equal(householdDay(at('2026-11-11T05:30:00Z'), null), '2026-11-10');
  });

  it('works without a state document, from the logs the client already has', () => {
    const now = at('2026-11-10T15:00:00Z');
    const known = knownFromLogs([
      { date: at('2026-11-10T14:40:00Z'), loggedByName: 'Alex', loggedByUid: 'alex' },
      { date: '2026-11-10T13:00:00.000Z', loggedByName: 'Sam' },
      { date: at('2026-11-09T13:00:00Z') },
      { date: at('2026-11-11T16:00:00Z') }, // a day ahead: a bad date, ignored
    ], now, CHI);
    assert.equal(known.countToday, 2);
    assert.equal(known.lastFedByName, 'Alex');
    // A few minutes ahead (another device's server-timed feed on a slow clock) counts as now.
    const skewed = knownFromLogs([{ date: at('2026-11-10T15:05:00Z'), loggedByName: 'Sam' }], now, CHI);
    assert.equal(skewed.lastFedAt?.toISOString(), now.toISOString());
    assert.equal(skewed.countToday, 1);
    const check = feedConfirmDecision({ state: null, known, now, timeZone: CHI, perDay: 3 });
    assert.equal(check.reason, 'recent');
    assert.equal(check.lastFedByUid, 'alex');
    // Nothing known: no recent feed, never a confirmation.
    assert.equal(feedConfirmDecision({ state: null, known: null, now, timeZone: CHI, perDay: 2 }).needsConfirm, false);
    // The newer of state and logs wins (an offline feed the state has not seen yet).
    const newer = feedConfirmDecision({ state: state({ lastFedAt: at('2026-11-10T10:00:00Z') }), known, now, timeZone: CHI, perDay: 3 });
    assert.equal(newer.lastFedByName, 'Alex');
  });

  it('says who fed and when', () => {
    const now = at('2026-11-10T14:12:00Z');
    const check = feedConfirmDecision({ state: state(), now, timeZone: CHI, perDay: 2 });
    assert.equal(feedAgainPrompt(check, 'Rex', now), 'Sam fed Rex 12 min ago. Feed again?');
    assert.equal(feedAgainPrompt(check, 'Rex', now, 'sam'), 'You fed Rex 12 min ago. Feed again?');
    assert.equal(feedAgainPrompt({ ...check, lastFedByName: null, lastFedByUid: null }, 'Rex', now), 'Rex was fed 12 min ago. Feed again?');
    const complete = { ...check, reason: 'complete' as const, perDay: 2 };
    assert.match(feedAgainPrompt(complete, 'Rex', now), /^Rex has had all 2 feedings today\. Sam fed Rex 12 min ago\. Feed again\?$/);
  });
});

describe('feed operation: the state document', () => {
  it('reads stored state defensively', () => {
    assert.equal(readFeedingState(null), null);
    const read = readFeedingState({ lastLogId: 'a', lastFedAt: { toDate: () => at('2026-11-10T14:00:00Z') }, day: 'today', countOnDay: -3 });
    assert.equal(read?.lastFedAt?.toISOString(), '2026-11-10T14:00:00.000Z');
    assert.equal(read?.day, null);
    assert.equal(read?.countOnDay, 0);
    assert.equal(read?.hasPrev, false);
    assert.equal(read?.prevLogId, null);
    assert.equal(readFeedingState({ prev: { lastLogId: 'a' } })?.prevLogId, 'a');
  });

  it('counts the day from the logs themselves: synced offline feeds count, deleted ones do not', () => {
    const today = '2026-11-10';
    const now = at('2026-11-10T22:00:00Z'); // 16:00 in Chicago
    const logs = [
      { id: 'a', date: at('2026-11-10T14:00:00Z') },
      { id: 'b', date: '2026-11-10T18:00:00.000Z' }, // an offline feed that synced (device time)
      { id: 'b', date: '2026-11-10T18:00:00.000Z' }, // the same log from both shape queries
      { id: 'y', date: at('2026-11-10T05:30:00Z') }, // 23:30 on Nov 9 in Chicago
      { id: 'f', date: at('2026-11-12T00:00:00Z') }, // far in the future: ignored
    ];
    assert.equal(countOnHouseholdDay(logs, today, CHI, now), 2);
    // Online, offline, online: the third feed persists 3.
    assert.deepEqual(countAfterFeed({ day: today, countOnDay: countOnHouseholdDay(logs, today, CHI, now) }, today), { day: today, countOnDay: 3 });
    // The log being deleted in the same commit is left out.
    assert.equal(countOnHouseholdDay(logs, today, CHI, now, 'a'), 1);
    assert.equal(householdDayStart(today, CHI).toISOString(), '2026-11-10T06:00:00.000Z');
  });

  it('a stale stored or loaded count never outweighs the counted logs', () => {
    const now = at('2026-11-10T22:00:00Z');
    // Today's only feed was deleted offline: the state still says 1 (and points at it), the logs say 0.
    const stale = state({ day: '2026-11-10', countOnDay: 1, lastLogId: 'gone', lastFedAt: at('2026-11-10T21:30:00Z') });
    const check = feedConfirmDecision({ state: withSurvivingLatest(stale, false), now, timeZone: CHI, perDay: 1, countToday: 0 });
    assert.equal(check.needsConfirm, false);
    assert.equal(check.countToday, 0);
    assert.equal(check.lastFedAt, null);
    // "Feed again?" was open while someone deleted a feeding: the old known count (2) is ignored.
    const accepted = feedConfirmDecision({ state: state({ countOnDay: 2, lastFedAt: at('2026-11-10T12:00:00Z') }), known: { lastFedAt: null, lastFedByName: null, countToday: 2 }, now, timeZone: CHI, perDay: 2, countToday: 1 });
    assert.equal(accepted.reason, null);
    assert.equal(accepted.countToday, 1);
    // A surviving latest feed is kept as is.
    assert.equal(withSurvivingLatest(stale, true), stale);
    // Without a state, the caller's loaded logs still supply the last feed (newer wins).
    const older = { lastFedAt: at('2026-11-10T10:00:00Z'), lastFedByName: 'Sam', countToday: 1 };
    const newer = { lastFedAt: at('2026-11-10T11:00:00Z'), lastFedByName: 'Alex', countToday: 1 };
    assert.equal(newerKnown(older, newer)?.lastFedByName, 'Alex');
    assert.equal(newerKnown(null, older), older);
  });

  it('counts per household day; backdated entries count only on their own day', () => {
    assert.deepEqual(countAfterFeed({ day: '2026-11-10', countOnDay: 1 }, '2026-11-10'), { day: '2026-11-10', countOnDay: 2 });
    assert.deepEqual(countAfterFeed({ day: '2026-11-09', countOnDay: 3 }, '2026-11-10'), { day: '2026-11-10', countOnDay: 1 });
    assert.deepEqual(countAfterFeed({ day: '2026-11-10', countOnDay: 2 }, '2026-11-09'), { day: '2026-11-10', countOnDay: 2 });
  });

  it('a backdated entry becomes the latest feed only when it is newer than every known feed', () => {
    const current = state({ lastFedAt: at('2026-11-10T14:00:00Z') });
    assert.equal(becomesLatest(at('2026-11-10T13:00:00Z'), true, current), false);
    assert.equal(becomesLatest(at('2026-11-10T14:30:00Z'), true, current), true);
    assert.equal(becomesLatest(at('2026-11-10T14:30:00Z'), true, current, { lastFedAt: at('2026-11-10T14:45:00Z'), lastFedByName: null, countToday: 1 }), false);
    assert.equal(becomesLatest(at('2026-11-10T13:00:00Z'), false, current), true);
    assert.equal(becomesLatest(at('2026-11-10T13:00:00Z'), true, null), true);
  });
});

describe('feed operation: undo planning (PE-2, WT-20)', () => {
  it('undoing the latest feed restores prev and drops the count', () => {
    assert.deepEqual(planUndo(state({ countOnDay: 2 }), { id: 'log-1', day: '2026-11-10' }), { kind: 'restore', day: '2026-11-10', countOnDay: 1, restorePrev: true });
    // The latest feed logged on another day (just past midnight): restore, count unchanged.
    assert.deepEqual(planUndo(state({ countOnDay: 2 }), { id: 'log-1', day: '2026-11-09' }), { kind: 'restore', day: '2026-11-10', countOnDay: 2, restorePrev: true });
    assert.deepEqual(planUndo(state({ countOnDay: 0 }), { id: 'log-1', day: '2026-11-10' }), { kind: 'restore', day: '2026-11-10', countOnDay: 0, restorePrev: true });
    // No prev: the latest feed is cleared.
    assert.deepEqual(planUndo(state({ prevLogId: null }), { id: 'log-1', day: '2026-11-10' }), { kind: 'restore', day: '2026-11-10', countOnDay: 0, restorePrev: false });
  });

  it('a deleted predecessor is never restored (feed A, feed B, delete A, delete B)', () => {
    // After A then B: latest B, prev A. Deleting A clears prev (and lowers the count).
    const afterB = state({ lastLogId: 'B', prevLogId: 'A', countOnDay: 2 });
    assert.deepEqual(planUndo(afterB, { id: 'A', day: '2026-11-10' }), { kind: 'count', day: '2026-11-10', countOnDay: 1, dropPrev: true });
    // Even when A was on another day, prev is still cleared.
    assert.deepEqual(planUndo(afterB, { id: 'A', day: '2026-11-09' }), { kind: 'count', day: '2026-11-10', countOnDay: 2, dropPrev: true });
    // Then deleting B clears the latest feed instead of restoring A.
    const afterDeleteA = state({ lastLogId: 'B', prevLogId: null, hasPrev: false, countOnDay: 1 });
    assert.deepEqual(planUndo(afterDeleteA, { id: 'B', day: '2026-11-10' }), { kind: 'restore', day: '2026-11-10', countOnDay: 0, restorePrev: false });
    // A prev whose log was deleted some other way (an old client) is not restored either.
    assert.deepEqual(planUndo(afterB, { id: 'B', day: '2026-11-10' }, false), { kind: 'restore', day: '2026-11-10', countOnDay: 1, restorePrev: false });
  });

  it('after a newer feed by someone else, only the count changes (never an old snapshot over newer data)', () => {
    const newer = state({ lastLogId: 'log-2', lastFedByName: 'Alex', countOnDay: 2 });
    assert.deepEqual(planUndo(newer, { id: 'log-1', day: '2026-11-10' }), { kind: 'count', day: '2026-11-10', countOnDay: 1, dropPrev: false });
    assert.deepEqual(planUndo(newer, { id: 'log-1', day: '2026-11-09' }), { kind: 'none' });
    assert.deepEqual(planUndo(newer, { id: 'log-1', day: null }), { kind: 'none' });
    assert.deepEqual(planUndo(null, { id: 'log-1', day: '2026-11-10' }), { kind: 'none' });
  });

  it('the author may delete for 10 minutes; Undo shows for 10 seconds', () => {
    const now = at('2026-11-10T14:09:00Z');
    const log = { loggedByUid: 'sam', loggedAt: at('2026-11-10T14:00:00Z') };
    assert.equal(authorMayDelete(log, 'sam', now), true);
    assert.equal(authorMayDelete(log, 'alex', now), false);
    assert.equal(authorMayDelete(log, 'sam', at('2026-11-10T14:10:00Z')), false);
    assert.equal(authorMayDelete({ loggedByUid: 'sam' }, 'sam', now), false);
    assert.equal(AUTHOR_DELETE_WINDOW_MS, 10 * 60_000);
    assert.equal(FEED_UNDO_MS, 10_000);
  });
});

describe('feed operation: every entry point uses it', () => {
  const read = (file: string) => readFileSync(resolve(process.cwd(), file), 'utf8');

  it('addFeedingLog is gone and feedings are never written directly', () => {
    const api = read('src/components/pets/pet-log-api.ts');
    assert.doesNotMatch(api, /addFeedingLog/);
    assert.match(api, /OtherLogKind = Exclude<PetLogKind, 'feeding-logs'>/);
    assert.match(read('src/components/pets/quick-feed-button.tsx'), /useFeedAction/);
    assert.match(read('src/components/feeding-log.tsx'), /useFeedAction/);
    assert.match(read('src/components/feeding-log.tsx'), /undoFeed\(/);
    assert.match(read('src/components/command/quick-add-actions.ts'), /feedPet\(/);
    assert.match(read('src/components/command/command-palette.tsx'), /undoFeed\(/);
    assert.match(read('src/components/pets/feed-picker-dialog.tsx'), /useQuickFeed/);
    assert.match(read('src/components/pets/hold-to-feed.tsx'), /feed\('hold'\)/);
  });

  it('online feeds and undos count the day from the logs read in the transaction', () => {
    const op = read('src/lib/pets/feed-operation.ts');
    assert.equal((op.match(/await dayFeedings\(/g) ?? []).length, 2, 'feedPet and undoFeed');
    assert.doesNotMatch(op, /reconcileDayCount|Math\.max/);
  });

  it('online feeds use server time; offline ones are marked and say so', () => {
    const op = read('src/lib/pets/feed-operation.ts');
    assert.match(op, /date: live \? serverTimestamp\(\) : fedAt/);
    assert.match(op, /loggedAt: serverTimestamp\(\)/);
    assert.match(op, /clockSource: 'device'/);
    assert.match(op, /runTransaction/);
    const ui = read('src/components/pets/use-feed-action.tsx');
    assert.match(ui, /Saved on this device/);
    assert.match(ui, /Couldn't check whether someone else fed/);
    assert.match(ui, /duration: FEED_UNDO_MS/);
    assert.match(ui, /Retry/);
  });
});
