import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { addDays, zonedMidnightIso } from '../../functions/src/shared/calendar';
import {
  computeHomeHealth,
  healthBand,
  healthKey,
  healthSummaryText,
  HEALTH_RULES,
  isScored,
  type HealthResult,
} from '../../src/lib/maintenance/health';
import type { HomeAsset, HomeAssetSchedule, MaintenanceLog, Vehicle, VehicleServiceSchedule } from '../../src/lib/types';

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

const health = (assets: HomeAsset[], vehicles: Vehicle[] = [], logs: MaintenanceLog[] = [], today = TODAY) =>
  computeHomeHealth({ assets, vehicles, logs, today, timeZone: TZ });

const scored = (assets: HomeAsset[], vehicles: Vehicle[] = []): HealthResult => {
  const overall = health(assets, vehicles).overall;
  assert.ok(isScored(overall), 'expected a score');
  return overall;
};

const filter = (nextDueDate: string, extra: Partial<HomeAssetSchedule> = {}) => ({ id: 'f', mode: 'scheduled' as const, scheduleName: 'Replace air filter', nextDueDate, ...extra });

describe('home health score (MA-10)', () => {
  it('is null when there is nothing active to score', () => {
    assert.equal(health([]).overall, null);
    assert.equal(health([asset({ status: 'retired' })], [vehicle({ status: 'sold' })]).overall, null);
  });

  it('gives no score when nothing active is tracked yet', () => {
    // A warranty, a checklist entry or a bare vehicle does not make anything tracked.
    const result = health(
      [asset({ warrantyExpiration: '2026-08-10', schedules: [{ id: 'c', mode: 'checklist', scheduleName: 'Look at it' }] })],
      [vehicle({ currentMileage: 40_000 })],
    );
    assert.deepEqual(result.overall, { score: null, reason: 'not_enough_tracked' });
    assert.deepEqual(result.targets, {});
  });

  it('scores a home with nothing due at 100 and leaves untracked items out', () => {
    const result = health([asset({ schedules: [filter('2026-12-01')] }), asset({ id: 'tv', name: 'TV' })]);
    const overall = scored([asset({ schedules: [filter('2026-12-01')] })]);
    assert.equal(overall.score, 100);
    assert.equal(overall.band, 'good');
    assert.equal(overall.tracked, 1);
    assert.deepEqual(overall.deductions, []);
    assert.equal(result.targets[healthKey('home_asset', 'hvac')].score, 100);
    assert.equal(result.targets[healthKey('home_asset', 'tv')], undefined);
  });

  it('a scheduled schedule with no due date still makes its item tracked', () => {
    assert.equal(scored([asset({ schedules: [{ id: 'f', mode: 'scheduled', scheduleName: 'F', frequencyType: 'months', intervalValue: 3 }] })]).score, 100);
    assert.equal(scored([], [vehicle({ registrationExpiration: '2027-05-01' })]).score, 100);
  });

  it('deducts more the longer a schedule is overdue, up to the cap', () => {
    const overdueBy = (nextDueDate: string) => scored([asset({ schedules: [filter(nextDueDate)] })]);
    assert.equal(overdueBy('2026-07-31').deductions[0].points, HEALTH_RULES.overdueBase);
    // 92 days late = three full 30-day steps.
    const threeMonths = overdueBy('2026-05-01');
    assert.equal(threeMonths.deductions[0].points, HEALTH_RULES.overdueBase + 3 * HEALTH_RULES.overduePerStep);
    assert.equal(threeMonths.score, 100 - 16);
    assert.equal(threeMonths.deductions[0].reason, 'Replace air filter is 3 months overdue');
    assert.equal(threeMonths.deductions[0].deepLink, '/maintenance?asset=hvac&schedule=hvac%3Af');
    assert.equal(overdueBy('2020-01-01').deductions[0].points, HEALTH_RULES.overdueMax);
  });

  it('due today costs a little; due soon and upcoming cost nothing', () => {
    const result = scored([asset({
      schedules: [
        { id: 'a', mode: 'scheduled', scheduleName: 'Today', nextDueDate: TODAY },
        { id: 'b', mode: 'scheduled', scheduleName: 'Soon', nextDueDate: '2026-08-08' },
      ],
    })]);
    assert.equal(HEALTH_RULES.dueSoon, 0);
    assert.equal(result.score, 100 - HEALTH_RULES.dueToday);
    assert.deepEqual(result.deductions.map((d) => d.reason), ['Today is due today']);
  });

  it('a snoozed reminder costs nothing', () => {
    const result = scored([asset({ schedules: [filter('2026-08-08', { snoozedUntil: '2026-08-08' })] })]);
    assert.equal(result.score, 100);
  });

  it('uses mileage when a service is further over by miles than by date', () => {
    const result = scored([], [vehicle({
      currentMileage: 50_200,
      serviceSchedules: [{ id: 'oil', mode: 'scheduled', serviceName: 'Oil change', nextDueMileage: 49_000, nextDueDate: '2026-12-01' }],
    })]);
    assert.equal(result.deductions[0].points, HEALTH_RULES.overdueBase + 2 * HEALTH_RULES.overduePerStep);
    assert.equal(result.deductions[0].reason, 'Oil change is 1,200 miles overdue');
  });

  it('expired documents cost the same as overdue work; expiring soon costs nothing; warranties never count', () => {
    const result = scored(
      [asset({ warrantyExpiration: '2026-08-10', schedules: [filter('2026-12-01')] }), asset({ id: 'old', name: 'Old fridge', warrantyExpiration: '2020-01-01', status: 'needs_attention' })],
      [vehicle({ registrationExpiration: '2026-07-01', inspectionExpiration: '2026-08-20' }), vehicle({ id: 'car', nickname: 'Car', inspectionExpiration: TODAY })],
    );
    const reasons = result.deductions.map((d) => `${d.targetName}: ${d.reason} (${d.points})`);
    assert.deepEqual(reasons.sort(), [
      // 31 days late: one 30-day step, like an overdue schedule.
      `Family SUV: Registration expired 4 weeks ago (${HEALTH_RULES.overdueBase + HEALTH_RULES.overduePerStep})`,
      `Car: Inspection expires today (${HEALTH_RULES.documentExpiresToday})`,
      `Old fridge: flagged as needing attention (${HEALTH_RULES.needsAttention})`,
    ].sort());
    // Renewing makes it healthy at once.
    assert.equal(scored([], [vehicle({ registrationExpiration: '2027-07-01' })]).score, 100);
  });

  it('home score is the average of the tracked items, not 100 minus every deduction', () => {
    const many = Array.from({ length: 12 }, (_, index) => asset({ id: `x${index}`, name: `X${index}`, schedules: [filter('2020-01-01')] }));
    const fine = Array.from({ length: 12 }, (_, index) => asset({ id: `ok${index}`, name: `OK${index}`, schedules: [filter('2027-01-01')] }));
    // 12 items at 80 and 12 at 100: 90, where the old formula said 0.
    const result = scored([...many, ...fine]);
    assert.equal(result.score, 90);
    assert.equal(result.tracked, 24);
    assert.equal(result.deductions.length, 12);
  });

  it('a flagged item with nothing else counts as tracked', () => {
    const result = health([asset({ status: 'needs_attention' })]);
    assert.equal(result.overall?.score, 100 - HEALTH_RULES.needsAttention);
    assert.equal(result.targets[healthKey('home_asset', 'hvac')].score, 90);
  });

  it('recent logs earn no bonus', () => {
    const logs: MaintenanceLog[] = [
      { id: '1', targetType: 'home_asset', assetId: 'hvac', date: '2026-07-20' },
      { id: '2', targetType: 'home_asset', assetId: 'hvac', date: '2026-06-01' },
    ];
    const assets = [asset({ status: 'needs_attention' })];
    assert.deepEqual(health(assets, [], logs), health(assets, [], []));
  });

  it('ignores retired assets and sold vehicles', () => {
    const result = health(
      [asset({ schedules: [filter('2027-01-01')] }), asset({ id: 'gone', name: 'Gone', status: 'retired', schedules: [{ id: 's', mode: 'scheduled', nextDueDate: '2020-01-01' }] })],
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

// Deterministic PRNG (mulberry32), so a failure is reproducible.
const rng = (seed: number) => () => {
  seed = (seed + 0x6D2B79F5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

describe('home health never improves by itself (MA-10 monotonic)', () => {
  it('walking day by day with no user action, no item or home score ever rises', () => {
    const start = '2026-01-01';
    const days = 420; // across both 2026 DST changes in Chicago (Mar 8, Nov 1)
    for (let seed = 1; seed <= 60; seed++) {
      const random = rng(seed);
      const pick = <T,>(items: readonly T[]) => items[Math.floor(random() * items.length)];
      const day = (spread: number) => addDays(start, Math.floor(random() * spread) - 30);
      // Day strings, and sometimes the legacy ISO instant of local midnight.
      const stored = (value: string) => (random() < 0.3 ? zonedMidnightIso(value, TZ) : value);
      const maybe = <T,>(value: T, chance = 0.5) => (random() < chance ? value : undefined);

      const assets: HomeAsset[] = Array.from({ length: 1 + Math.floor(random() * 4) }, (_, a) => ({
        ...asset({ id: `a${a}`, name: `Asset ${a}`, status: pick(['active', 'active', 'needs_attention'] as const) }),
        warrantyExpiration: maybe(stored(day(420))),
        warrantyLifetime: maybe(true, 0.1),
        schedules: Array.from({ length: Math.floor(random() * 4) }, (_, s): HomeAssetSchedule => {
          const due = day(420);
          return {
            id: `s${s}`,
            mode: pick(['scheduled', 'scheduled', 'checklist', undefined] as const),
            scheduleName: `Schedule ${s}`,
            frequencyType: maybe('months' as const),
            intervalValue: 3,
            nextDueDate: maybe(stored(due), 0.85),
            snoozedUntil: maybe(due, 0.3),
          };
        }),
      }));
      const vehicles: Vehicle[] = Array.from({ length: Math.floor(random() * 3) }, (_, v) => {
        const currentMileage = 40_000 + Math.floor(random() * 20_000);
        return {
          ...vehicle({ id: `v${v}`, nickname: `Car ${v}`, status: pick(['active', 'needs_attention'] as const) }),
          currentMileage,
          registrationExpiration: maybe(stored(day(420))),
          inspectionExpiration: maybe(stored(day(420))),
          serviceSchedules: Array.from({ length: Math.floor(random() * 3) }, (_, s): VehicleServiceSchedule => {
            const due = day(420);
            return {
              id: `svc${s}`,
              mode: 'scheduled',
              serviceName: `Service ${s}`,
              nextDueDate: maybe(stored(due), 0.7),
              nextDueMileage: maybe(currentMileage + Math.floor(random() * 4000) - 1500, 0.6),
              snoozedUntil: maybe(due, 0.3),
            };
          }),
        };
      });

      let previous = health(assets, vehicles, [], start);
      for (let offset = 1; offset <= days; offset++) {
        const today = addDays(start, offset);
        const next = health(assets, vehicles, [], today);
        assert.deepEqual(Object.keys(next.targets).sort(), Object.keys(previous.targets).sort(), `seed ${seed}: tracked set changed on ${today}`);
        for (const [key, result] of Object.entries(next.targets)) {
          assert.ok(result.score <= previous.targets[key].score, `seed ${seed}: ${key} rose from ${previous.targets[key].score} to ${result.score} on ${today}`);
        }
        if (isScored(previous.overall)) {
          assert.ok(isScored(next.overall));
          assert.ok(next.overall.score <= previous.overall.score, `seed ${seed}: home score rose on ${today}`);
        }
        previous = next;
      }
    }
  });
});
