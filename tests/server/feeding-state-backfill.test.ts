import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { Timestamp } from 'firebase/firestore';
import { localDay as sharedLocalDay } from '../../functions/src/shared/calendar';
import { feedingStateFromLogs, localDay, safeTimeZone } from '../../scripts/ops/feeding-state.mjs';

// The pure mapping of scripts/ops/backfill-feeding-state.mjs (no emulator needed).
const NOW = new Date('2026-11-10T20:00:00.000Z');
const CHI = 'America/Chicago';

describe('feeding-state backfill mapping', () => {
  test('the newest log (either date shape) becomes the latest feed', () => {
    const state = feedingStateFromLogs([
      { id: 'a', date: Timestamp.fromDate(new Date('2026-11-10T13:00:00Z')), loggedByUid: 'sam', loggedByName: 'Sam' },
      { id: 'b', date: '2026-11-10T18:30:00.000Z', loggedByName: 'Alex' },
      { id: 'c', date: Timestamp.fromDate(new Date('2026-11-09T13:00:00Z')) },
    ], CHI, NOW);
    assert.deepEqual(state, {
      lastLogId: 'b',
      lastFedAt: new Date('2026-11-10T18:30:00.000Z'),
      lastFedByUid: null,
      lastFedByName: 'Alex',
      day: '2026-11-10',
      countOnDay: 2,
      prev: null,
    });
  });

  test('the count uses the household day of the newest log', () => {
    // 04:00 UTC on Nov 11 is Nov 10 in Chicago, Nov 11 in UTC.
    const logs = [
      { id: 'late', date: new Date('2026-11-11T04:00:00Z') },
      { id: 'noon', date: new Date('2026-11-10T18:00:00Z') },
    ];
    const later = new Date('2026-11-11T05:00:00Z');
    assert.equal(feedingStateFromLogs(logs, CHI, later)?.countOnDay, 2);
    assert.equal(feedingStateFromLogs(logs, 'UTC', later)?.day, '2026-11-11');
    assert.equal(feedingStateFromLogs(logs, 'UTC', later)?.countOnDay, 1);
    // A missing or bad zone falls back to the default household zone.
    assert.equal(feedingStateFromLogs(logs, undefined, later)?.day, '2026-11-10');
    assert.equal(safeTimeZone('Mars/Base'), CHI);
  });

  test('no readable feeding means no state; future and broken dates are ignored', () => {
    assert.equal(feedingStateFromLogs([], CHI, NOW), null);
    assert.equal(feedingStateFromLogs([{ id: 'x', date: 'not a date' }, { id: 'y' }], CHI, NOW), null);
    const state = feedingStateFromLogs([
      { id: 'future', date: new Date('2026-11-10T21:00:00Z') },
      { id: 'real', date: new Date('2026-11-10T19:00:00Z'), loggedByUid: '', loggedByName: '  Sam ' },
    ], CHI, NOW);
    assert.equal(state?.lastLogId, 'real');
    assert.equal(state?.lastFedByUid, null);
    assert.equal(state?.lastFedByName, 'Sam');
  });

  test('the script day agrees with the shared calendar', () => {
    for (const iso of ['2026-11-01T04:59:00Z', '2026-11-01T05:00:00Z', '2026-03-08T07:59:00Z', '2026-12-31T23:59:59Z']) {
      for (const zone of [CHI, 'UTC', 'Pacific/Auckland']) {
        assert.equal(localDay(new Date(iso), zone), sharedLocalDay(new Date(iso), zone), `${iso} in ${zone}`);
      }
    }
  });
});
