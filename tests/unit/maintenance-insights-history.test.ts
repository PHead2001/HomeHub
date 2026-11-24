import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { latestServiceLog, relativeDayText, serviceHistoryLine, type HistoryLog } from '../../src/lib/maintenance/history-line';

const TODAY = '2026-11-24';
const TZ = 'America/Chicago';
const hvac = { type: 'home_asset' as const, id: 'hvac' };
const log = (overrides: Partial<HistoryLog> & { id: string }): HistoryLog => ({ targetType: 'home_asset', assetId: 'hvac', date: '2026-08-20', ...overrides });

describe('service history line (MA-32)', () => {
  it('reads relative days in the household zone', () => {
    assert.equal(relativeDayText(TODAY, TODAY), 'today');
    assert.equal(relativeDayText('2026-11-23', TODAY), 'yesterday');
    assert.equal(relativeDayText('2026-11-19', TODAY), '5 days ago');
    assert.equal(relativeDayText('2026-11-03', TODAY), '3 weeks ago');
    assert.equal(relativeDayText('2026-08-20', TODAY), '3 months ago');
    assert.equal(relativeDayText('2023-11-01', TODAY), '3 years ago');
  });

  it('names who did it, only from doneByName and never an email', () => {
    const options = { today: TODAY, timeZone: TZ };
    assert.equal(serviceHistoryLine([log({ id: 'a', title: 'Replace air filter', doneByName: '  Sam ' })], hvac, options), 'Replace air filter last done 3 months ago by Sam');
    assert.equal(serviceHistoryLine([log({ id: 'a', title: 'Replace air filter' })], hvac, options), 'Replace air filter last done 3 months ago');
    assert.equal(serviceHistoryLine([log({ id: 'a', title: 'Replace air filter', doneByName: 'sam@example.com' })], hvac, options), 'Replace air filter last done 3 months ago');
    assert.equal(serviceHistoryLine([log({ id: 'a', title: 'Replace air filter', doneByName: '   ' })], hvac, options), 'Replace air filter last done 3 months ago');
    assert.equal(serviceHistoryLine([log({ id: 'a', item: 'Legacy flush' })], hvac, options), 'Legacy flush last done 3 months ago');
    assert.equal(serviceHistoryLine([log({ id: 'a' })], hvac, options), 'Maintenance last done 3 months ago');
    assert.equal(serviceHistoryLine([], hvac, options), null);
  });

  it('uses the newest live-linked log on or before today', () => {
    const logs: HistoryLog[] = [
      log({ id: 'old', title: 'Old', date: '2026-01-01' }),
      log({ id: 'b', title: 'Same day, earlier entry', date: '2026-11-23', createdAt: '2026-11-23T10:00:00Z' }),
      log({ id: 'c', title: 'Same day, later entry', date: '2026-11-23', createdAt: '2026-11-23T18:00:00Z', doneByName: 'Ana' }),
      log({ id: 'future', title: 'Planned', date: '2026-12-01' }),
      log({ id: 'other', title: 'Other asset', assetId: 'fridge', date: TODAY }),
      { id: 'former', targetType: 'general', formerTargetType: 'home_asset', date: TODAY, title: 'Deleted asset log' } as HistoryLog,
      log({ id: 'bad', title: 'Bad date', date: 'soon' }),
    ];
    assert.equal(serviceHistoryLine(logs, hvac, { today: TODAY, timeZone: TZ }), 'Same day, later entry last done yesterday by Ana');
    // ISO timestamps are read as household days: 03:00Z on the 24th is the 23rd in Chicago.
    assert.equal(latestServiceLog([log({ id: 'z', date: '2026-11-24T03:00:00.000Z' })], hvac, { today: TODAY, timeZone: TZ })?.day, '2026-11-23');
  });

  it('filters by schedule name, ignoring case and spacing', () => {
    const logs: HistoryLog[] = [
      log({ id: 'a', title: 'replace  AIR filter', date: '2026-10-01', doneByName: 'Sam' }),
      log({ id: 'b', title: 'Clean coils', date: '2026-11-20' }),
    ];
    const options = { today: TODAY, timeZone: TZ };
    assert.equal(serviceHistoryLine(logs, hvac, { ...options, scheduleName: 'Replace air filter' }), 'Replace air filter last done 7 weeks ago by Sam');
    assert.equal(serviceHistoryLine(logs, hvac, { ...options, scheduleName: 'Flush drain' }), null);
    assert.equal(serviceHistoryLine(logs, hvac, options), 'Clean coils last done 4 days ago');
    const car = { type: 'vehicle' as const, id: 'car' };
    assert.equal(serviceHistoryLine([{ id: 'v', vehicleId: 'car', date: TODAY, title: 'Oil change', doneByName: 'Lee' }], car, options), 'Oil change last done today by Lee');
  });
});
