import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  computeHomeHealth,
  healthBand,
  healthKey,
  healthSummaryText,
  HEALTH_RULES,
} from '../../src/lib/maintenance/health';
import type { HomeAsset, MaintenanceLog, Vehicle } from '../../src/lib/types';

const TZ = 'America/Chicago';
const TODAY = '2026-08-01';

const asset = (overrides: Partial<HomeAsset> = {}): HomeAsset => ({
  id: 'hvac',
  householdId: 'h',
  name: 'Main HVAC',
  category: 'HVAC',
  status: 'active',
  createdAt: '2026-01-01',
  updatedAt: '2026-01-01',
  ...overrides,
});

const vehicle = (overrides: Partial<Vehicle> = {}): Vehicle => ({
  id: 'suv',
  householdId: 'h',
  nickname: 'Family SUV',
  status: 'active',
  createdAt: '2026-01-01',
  updatedAt: '2026-01-01',
  ...overrides,
});

const health = (assets: HomeAsset[], vehicles: Vehicle[] = [], logs: MaintenanceLog[] = []) =>
  computeHomeHealth({ assets, vehicles, logs, today: TODAY, timeZone: TZ });

describe('home health score', () => {
  it('is null when there is nothing active to score', () => {
    assert.equal(health([]).overall, null);
    assert.equal(health([asset({ status: 'retired' })], [vehicle({ status: 'sold' })]).overall, null);
  });

  it('scores a home with nothing due at 100', () => {
    const result = health([asset({ schedules: [{ id: 'f', mode: 'scheduled', scheduleName: 'Filter', nextDueDate: '2026-12-01' }] })]);
    assert.equal(result.overall?.score, 100);
    assert.equal(result.overall?.band, 'good');
    assert.deepEqual(result.overall?.deductions, []);
    assert.equal(result.targets[healthKey('home_asset', 'hvac')].score, 100);
  });

  it('deducts more the longer a schedule is overdue, up to the cap', () => {
    const overdueBy = (nextDueDate: string) => health([asset({
      schedules: [{ id: 'f', mode: 'scheduled', scheduleName: 'Replace air filter', nextDueDate }],
    })]).overall!;
    assert.equal(overdueBy('2026-07-31').deductions[0].points, HEALTH_RULES.overdueBase);
    // 92 days late = three full 30-day steps.
    const threeMonths = overdueBy('2026-05-01');
    assert.equal(threeMonths.deductions[0].points, HEALTH_RULES.overdueBase + 3 * HEALTH_RULES.overduePerStep);
    assert.equal(threeMonths.deductions[0].reason, 'Replace air filter is 3 months overdue');
    assert.equal(threeMonths.deductions[0].deepLink, '/maintenance?asset=hvac&schedule=hvac%3Af');
    assert.equal(overdueBy('2020-01-01').deductions[0].points, HEALTH_RULES.overdueMax);
  });

  it('counts due today and due soon lightly', () => {
    const result = health([asset({
      schedules: [
        { id: 'a', mode: 'scheduled', scheduleName: 'Today', nextDueDate: TODAY },
        { id: 'b', mode: 'scheduled', scheduleName: 'Soon', nextDueDate: '2026-08-08' },
      ],
    })]).overall!;
    assert.equal(result.score, 100 - HEALTH_RULES.dueToday - HEALTH_RULES.dueSoon);
    assert.equal(result.deductions.find((d) => d.reason.startsWith('Soon'))?.reason, 'Soon is due in 7 days');
  });

  it('uses mileage when a service is further over by miles than by date', () => {
    const result = health([], [vehicle({
      currentMileage: 50_200,
      serviceSchedules: [{ id: 'oil', mode: 'scheduled', serviceName: 'Oil change', nextDueMileage: 49_000, nextDueDate: '2026-12-01' }],
    })]).overall!;
    assert.equal(result.deductions[0].points, HEALTH_RULES.overdueBase + 2 * HEALTH_RULES.overduePerStep);
    assert.equal(result.deductions[0].reason, 'Oil change is 1,200 miles overdue');
  });

  it('charges expired documents and ending warranties, but not ended warranties', () => {
    const result = health(
      [asset({ warrantyExpiration: '2026-08-10' }), asset({ id: 'old', name: 'Old fridge', warrantyExpiration: '2020-01-01' })],
      [vehicle({ registrationExpiration: '2026-07-01' })],
    ).overall!;
    const reasons = result.deductions.map((d) => `${d.targetName}: ${d.reason} (${d.points})`);
    assert.deepEqual(reasons.sort(), [
      `Family SUV: Registration expired 4 weeks ago (${HEALTH_RULES.documentExpired})`,
      `Main HVAC: warranty ends in 9 days (${HEALTH_RULES.warrantyEnding})`,
    ].sort());
  });

  it('deducts for a flagged item and rewards recent logs, per item and overall', () => {
    const logs: MaintenanceLog[] = [
      { id: '1', targetType: 'home_asset', assetId: 'hvac', date: '2026-07-20' },
      { id: '2', targetType: 'home_asset', assetId: 'hvac', date: '2026-06-01' },
      { id: '3', assetId: 'hvac', date: '2026-05-10' }, // legacy: target inferred from assetId
      { id: '4', targetType: 'home_asset', assetId: 'hvac', date: '2026-04-01' }, // older than 90 days
      { id: '5', targetType: 'general', date: '2026-07-30' },
    ];
    const result = health([asset({ status: 'needs_attention' })], [], logs);
    const item = result.targets[healthKey('home_asset', 'hvac')];
    assert.equal(item.recentLogs, 3);
    assert.equal(item.bonus, HEALTH_RULES.recentLogMaxPerItem);
    assert.equal(item.score, 100 - HEALTH_RULES.needsAttention + HEALTH_RULES.recentLogMaxPerItem);
    assert.equal(result.overall?.score, item.score);
  });

  it('caps the overall bonus and never leaves 0-100', () => {
    const assets = Array.from({ length: 4 }, (_, index) => asset({ id: `a${index}`, name: `A${index}`, status: 'needs_attention' }));
    const logs = assets.flatMap((item) => [1, 2, 3].map((n) => ({ id: `${item.id}-${n}`, targetType: 'home_asset' as const, assetId: item.id, date: '2026-07-2' + n })));
    const result = health(assets, [], logs).overall!;
    assert.equal(result.bonus, HEALTH_RULES.recentLogMaxOverall);
    assert.equal(result.score, 100 - 4 * HEALTH_RULES.needsAttention + HEALTH_RULES.recentLogMaxOverall);

    const many = Array.from({ length: 12 }, (_, index) => asset({
      id: `x${index}`, name: `X${index}`,
      schedules: [{ id: 's', mode: 'scheduled', scheduleName: 'S', nextDueDate: '2020-01-01' }],
    }));
    assert.equal(health(many).overall?.score, 0);
  });

  it('ignores retired assets and sold vehicles', () => {
    const result = health(
      [asset(), asset({ id: 'gone', name: 'Gone', status: 'retired', schedules: [{ id: 's', mode: 'scheduled', nextDueDate: '2020-01-01' }] })],
      [vehicle({ status: 'sold', registrationExpiration: '2020-01-01' })],
    );
    assert.equal(result.overall?.score, 100);
    assert.equal(result.targets[healthKey('home_asset', 'gone')], undefined);
    assert.equal(result.targets[healthKey('vehicle', 'suv')], undefined);
  });

  it('bands and describes scores', () => {
    assert.equal(healthBand(85), 'good');
    assert.equal(healthBand(84), 'fair');
    assert.equal(healthBand(60), 'fair');
    assert.equal(healthBand(59), 'poor');
    assert.equal(healthSummaryText('Home health', { score: 82, band: 'fair' }), 'Home health 82 out of 100, needs some care.');
  });
});
