import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import {
  AUTHOR_DELETE_WINDOW_MS,
  authorMayDelete,
  FEED_CLOCK_MARGIN_MS,
  FEED_REPEAT_WINDOW_MS,
  FEED_UNDO_MS,
  feedAgainPrompt,
  feedConfirmDecision,
  feedReadStart,
  householdDay,
  knownFromLogs,
  lastFedPreview,
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
    // The device asks 5 minutes longer than the rules refuse on server time (the clock margin).
    assert.equal(feedConfirmDecision({ ...base, now: new Date(fedAt.getTime() + FEED_REPEAT_WINDOW_MS + FEED_CLOCK_MARGIN_MS - 1) }).needsConfirm, true);
    const after = feedConfirmDecision({ ...base, now: new Date(fedAt.getTime() + FEED_REPEAT_WINDOW_MS + FEED_CLOCK_MARGIN_MS) });
    assert.equal(after.needsConfirm, false);
    assert.equal(after.reason, null);
    // A time from a device clock that runs ahead still counts as recent.
    assert.equal(feedConfirmDecision({ ...base, now: new Date(fedAt.getTime() - minutes(5)) }).reason, 'recent');
    assert.equal(FEED_REPEAT_WINDOW_MS, 90 * 60_000);
    assert.equal(FEED_CLOCK_MARGIN_MS, 5 * 60_000);
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

  it("a feeding just before household midnight still asks; today's count stays today's", () => {
    // Chicago: 23:55 on Nov 10 is 05:55Z on Nov 11; 00:05 on Nov 11 is 06:05Z.
    const now = at('2026-11-11T06:05:00Z');
    const today = householdDay(now, CHI);
    assert.equal(today, '2026-11-11');
    // The online read starts 90 minutes back (04:35Z), before midnight (06:00Z).
    const start = feedReadStart(today, now, CHI);
    assert.equal(start.toISOString(), '2026-11-11T04:35:00.000Z');
    assert.ok(start < householdDayStart(today, CHI));
    // Late in the day the read starts at midnight, as before.
    assert.equal(feedReadStart('2026-11-11', at('2026-11-11T20:00:00Z'), CHI).toISOString(), householdDayStart('2026-11-11', CHI).toISOString());
    // The logs that read returns: an offline feed synced at 23:55 (newer than the state).
    const read = [
      { id: 'offline', date: at('2026-11-11T05:55:00Z'), loggedByUid: 'alex', loggedByName: 'Alex' },
      { id: 'earlier', date: at('2026-11-11T04:40:00Z'), loggedByUid: 'sam', loggedByName: 'Sam' },
    ];
    const older = state({ lastLogId: 'old', lastFedAt: at('2026-11-10T23:00:00Z'), day: '2026-11-10', countOnDay: 2 });
    const countToday = countOnHouseholdDay(read, today, CHI, now);
    assert.equal(countToday, 0, "yesterday's feedings are not today's");
    const fresh = knownFromLogs(read, now, CHI);
    assert.equal(fresh.countToday, 0);
    assert.equal(fresh.lastFedAt?.toISOString(), '2026-11-11T05:55:00.000Z');
    const check = feedConfirmDecision({ state: older, known: fresh, now, timeZone: CHI, perDay: 2, countToday });
    assert.equal(check.needsConfirm, true);
    assert.equal(check.reason, 'recent');
    assert.equal(check.lastFedByName, 'Alex');
    assert.equal(check.countToday, 0);
    // A feeding after midnight is counted once; the pre-midnight ones still are not.
    const withToday = [...read, { id: 'today', date: at('2026-11-11T06:02:00Z'), loggedByName: 'Sam' }];
    assert.equal(countOnHouseholdDay(withToday, today, CHI, now), 1);
    assert.equal(knownFromLogs(withToday, now, CHI).countToday, 1);
  });

  it('the online feed reads from feedReadStart; Undo counts from the day start', () => {
    const op = readFileSync(resolve(process.cwd(), 'src/lib/pets/feed-transaction.ts'), 'utf8');
    assert.match(op, /stateFeedings\(db, householdId, petId, feedReadStart\(today, now, timeZone\)\)/);
    assert.match(op, /stateFeedings\(db, householdId, petId, householdDayStart\(today, timeZone\)\)/);
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
    // Online, offline, online: the third feed counts 3.
    assert.equal(countOnHouseholdDay([...logs, { id: 'c', date: now }], today, CHI, now), 3);
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

});

describe('feed operation: delete windows (PE-2, WT-20)', () => {
  // Undo and deletes re-derive the state from the surviving logs: see tests/unit/pets-feeding-invariant.test.ts.
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

  it('online feeds, undos and time corrections count the day from the logs read in the transaction', () => {
    const op = read('src/lib/pets/feed-transaction.ts');
    assert.equal((op.match(/await stateFeedings\(/g) ?? []).length, 3, 'runFeed, runUndoFeed and runCorrectFeedTime');
    assert.match(op, /const recent = await stateFeedings\(db, householdId, petId, feedReadStart/, 'runFeed');
    assert.doesNotMatch(op, /reconcileDayCount|Math\.max/);
    // The app binds its Firestore; nothing else writes feedings.
    assert.match(read('src/lib/pets/feed-operation.ts'), /runFeed\(db, input\)/);
  });

  it('online feeds use server time; offline ones are marked and say so', () => {
    const op = read('src/lib/pets/feed-transaction.ts');
    assert.match(op, /date: plan\.live \? serverTimestamp\(\) : stamp \?\? Timestamp\.fromDate\(plan\.fedAt\)/);
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

describe('the palette preview never reads a failed history as "no feedings" (finding: latestFeedings swallowed failures)', () => {
  const now = at('2026-11-10T22:00:00Z');
  const recent = { id: 'r', date: at('2026-11-10T21:50:00Z'), loggedByName: 'Sam', foodType: 'Wet' };
  const ok = (logs: unknown[]) => ({ status: 'fulfilled' as const, value: logs as never[] });
  const failed = { status: 'rejected' as const, reason: new Error('unavailable') };

  it('both reads failing, or either one, says the last feeding is unavailable', () => {
    assert.equal(lastFedPreview([failed, failed], now, CHI), 'Last feeding unavailable');
    assert.equal(lastFedPreview([ok([recent]), failed], now, CHI), 'Last feeding unavailable');
    assert.equal(lastFedPreview([failed, ok([])], now, CHI), 'Last feeding unavailable');
  });

  it('with both reads it names the latest feeding and its food', () => {
    assert.equal(lastFedPreview([ok([recent]), ok([])], now, CHI), 'Last fed 10 min ago by Sam (wet)');
    assert.equal(lastFedPreview([ok([]), ok([])], now, CHI), 'No feedings logged yet');
  });
});
