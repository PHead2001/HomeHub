import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { briefLabel, DAY_PHASES, dominantPhase, GOLDEN_ROOF_CHORES, greeting, hourIn, isGoldenRoof, phaseWeights, seasonFor, windowsLit } from '../../src/lib/dashboard/ambience';
import { activeBellNotifications, caughtUpLine, groupNotifications, notificationGroupFor, notificationSourceLabel } from '../../src/lib/dashboard/notification-display';
import { deduplicateNotifications, isNotificationReadBy } from '../../src/lib/notifications';
import type { Notification } from '../../src/lib/types';

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

  it('says "Hello" from midnight to 4:00, never "Good evening" (HP-22c)', () => {
    assert.equal(greeting(at(0)), 'Hello');
    assert.equal(greeting(at(3, 59)), 'Hello');
    assert.equal(greeting(at(4)), 'Good morning');
    assert.equal(greeting(at(23, 59)), 'Good evening');
  });

  it("reads the hour in the household's zone, not the device's (D-6)", () => {
    // 2026-08-01 07:30 UTC is 02:30 in Chicago (CDT) and 17:30 in Sydney (AEST).
    const instant = new Date(Date.UTC(2026, 7, 1, 7, 30));
    assert.equal(hourIn(instant, 'America/Chicago'), 2);
    assert.equal(greeting(instant, 'America/Chicago'), 'Hello');
    assert.equal(greeting(instant, 'Australia/Sydney'), 'Good evening');
    assert.equal(greeting(instant, 'UTC'), 'Good morning');
    assert.equal(hourIn(instant, 'Not/AZone'), instant.getHours(), 'an invalid zone falls back to the device');
  });

  it('names the brief for the time of day (HP-22b)', () => {
    assert.equal(briefLabel(at(2)), "Today's brief");
    assert.equal(briefLabel(at(8)), 'Morning brief');
    assert.equal(briefLabel(at(14)), 'Afternoon brief');
    assert.equal(briefLabel(at(21)), 'Evening brief');
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

  it('counts unread after merging duplicate copies, exactly as the bell does', () => {
    const user = { uid: 'u1', email: 'u1@example.test' };
    const base = (id: string, createdAt: Date, extra: Partial<Notification> = {}): Notification => ({
      id, householdId: 'h', category: 'maintenance', title: 'HVAC filter due', message: 'Due today', createdAt,
      expiresAt: new Date(createdAt.getTime() + 7 * 86_400_000), sourceType: 'maintenance_asset_schedule', sourceId: 'hvac:filter',
      stateKey: 'due_today|2026-08-01', readBy: {}, dismissedBy: {}, ...extra,
    });
    const read = { u1: { at: now, uid: 'u1' } };
    const raw = [
      base('copy-a', new Date(2026, 7, 1, 8)),
      base('copy-b', new Date(2026, 7, 1, 9), { readBy: read }),
      base('other', new Date(2026, 7, 1, 10), { sourceId: 'suv:tires', title: 'Tires' }),
      base('other-copy', new Date(2026, 7, 1, 11), { sourceId: 'suv:tires', title: 'Tires' }),
    ];
    const active = activeBellNotifications(deduplicateNotifications(raw), user, now);
    assert.equal(active.length, 2, 'two semantic notifications');
    assert.equal(active.filter((n) => !isNotificationReadBy(n, user.uid)).length, 1, 'the read copy marks its twin read');
    // Counting raw documents would have said 3.
    assert.equal(raw.filter((n) => !isNotificationReadBy(n, user.uid)).length, 3);
  });
});

describe('golden roof (H29)', () => {
  it('turns the roof gold at exactly 100 completed chores and stays gold after', () => {
    assert.equal(GOLDEN_ROOF_CHORES, 100);
    assert.equal(isGoldenRoof(0), false);
    assert.equal(isGoldenRoof(99), false);
    assert.equal(isGoldenRoof(100), true);
    assert.equal(isGoldenRoof(101), true);
    assert.equal(isGoldenRoof(5000), true);
  });

  it('never turns gold from an unreadable count', () => {
    assert.equal(isGoldenRoof(Number.NaN), false);
    assert.equal(isGoldenRoof(-1), false);
  });

  it('is the condition the dashboard uses for the live completed-chore count (HP-11b)', () => {
    const dashboard = readFileSync(resolve(process.cwd(), 'src/components/dashboard/dashboard.tsx'), 'utf8');
    assert.match(dashboard, /facts\.completedChores !== undefined && isGoldenRoof\(facts\.completedChores\)/);
    assert.doesNotMatch(dashboard, /getCountFromServer/, 'no one-time count per page load');
    const hook = readFileSync(resolve(process.cwd(), 'src/lib/dashboard/use-dashboard-data.ts'), 'utf8');
    assert.match(hook, /'streaks\.completed', STREAKS_FAILURE, query\(base\('chores'\), where\('isCompleted', '==', true\)\)/);
  });
});
