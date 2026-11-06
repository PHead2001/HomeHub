import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DAY_PHASES, dominantPhase, greeting, phaseWeights, seasonFor, windowsLit } from '../../src/lib/dashboard/ambience';
import { caughtUpLine, groupNotifications, notificationGroupFor, notificationSourceLabel } from '../../src/lib/dashboard/notification-display';

const at = (hour: number, minute = 0) => new Date(2026, 7, 1, hour, minute);

describe('time-of-day lighting', () => {
  it('weights always sum to 1', () => {
    for (let minute = 0; minute < 24 * 60; minute += 7) {
      const weights = phaseWeights(at(0, minute));
      const total = DAY_PHASES.reduce((sum, phase) => sum + weights[phase], 0);
      assert.ok(Math.abs(total - 1) < 1e-9, `sum at minute ${minute}`);
    }
  });

  it('changes gradually: no jump at the hour', () => {
    for (let minute = 0; minute < 24 * 60; minute += 1) {
      const a = phaseWeights(at(0, minute));
      const b = phaseWeights(at(0, minute + 1));
      for (const phase of DAY_PHASES) assert.ok(Math.abs(a[phase] - b[phase]) < 0.02, `${phase} jumps at minute ${minute}`);
    }
  });

  it('picks the expected phase and lights windows at night', () => {
    assert.equal(dominantPhase(at(6, 30)), 'dawn');
    assert.equal(dominantPhase(at(13)), 'day');
    assert.equal(dominantPhase(at(19)), 'dusk');
    assert.equal(dominantPhase(at(1)), 'night');
    assert.equal(windowsLit(at(23)), true);
    assert.equal(windowsLit(at(12)), false);
  });

  it('greets by time of day', () => {
    assert.equal(greeting(at(7)), 'Good morning');
    assert.equal(greeting(at(14)), 'Good afternoon');
    assert.equal(greeting(at(21)), 'Good evening');
  });

  it('chooses seasonal accents by month', () => {
    assert.equal(seasonFor(new Date(2026, 11, 10)), 'holidays');
    assert.equal(seasonFor(new Date(2026, 9, 31)), 'halloween');
    assert.equal(seasonFor(new Date(2026, 0, 15)), 'winter');
    assert.equal(seasonFor(new Date(2026, 6, 4)), null);
  });
});

describe('notification presentation', () => {
  const now = new Date(2026, 7, 1, 12);

  it('groups into Today, This week and Earlier', () => {
    assert.equal(notificationGroupFor(new Date(2026, 7, 1, 0, 5), now), 'today');
    assert.equal(notificationGroupFor(new Date(2026, 6, 28), now), 'week');
    assert.equal(notificationGroupFor(new Date(2026, 6, 20), now), 'earlier');
    const groups = groupNotifications([
      { id: 'a', createdAt: new Date(2026, 7, 1, 9) },
      { id: 'b', createdAt: new Date(2026, 6, 30) },
      { id: 'c', createdAt: new Date(2026, 6, 29) },
    ], now);
    assert.deepEqual(groups.map((group) => [group.label, group.items.map((item) => item.id)]), [['Today', ['a']], ['This week', ['b', 'c']]]);
  });

  it('never exposes internal source names', () => {
    assert.equal(notificationSourceLabel('maintenance_asset_schedule'), 'Home maintenance');
    assert.equal(notificationSourceLabel('maintenance_asset_warranty'), 'Warranty');
    assert.equal(notificationSourceLabel('chore-assignment'), 'Chore assignment');
    assert.equal(notificationSourceLabel('household-newuser-reminder'), 'New member');
    assert.equal(notificationSourceLabel('some_internal_enum'), null);
    assert.equal(notificationSourceLabel(undefined), null);
  });

  it('has a stable caught-up line per day', () => {
    assert.equal(caughtUpLine(now), caughtUpLine(new Date(2026, 7, 1, 23)));
  });
});
