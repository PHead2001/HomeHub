import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { CostSummary } from '../../src/components/maintenance/cost-summary';
import { FilterChips } from '../../src/components/maintenance/filter-chips';
import {
  ADD_PURCHASE_PRICE,
  costPerMile,
  costSummary,
  formatPerMile,
  formatWholeDollars,
  lifetimeCost,
  NOT_ENOUGH_MILEAGE,
  repairShare,
  spendByYear,
  sumCosts,
  UNDATED,
  withoutCostText,
  type CostLog,
} from '../../src/lib/maintenance/costs';

const TZ = 'America/Chicago';
const rng = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const assetLog = (overrides: Partial<CostLog> & { id: string }): CostLog => ({ targetType: 'home_asset', assetId: 'hvac', date: '2026-03-01', ...overrides });
const vehicleLog = (overrides: Partial<CostLog> & { id: string }): CostLog => ({ targetType: 'vehicle', vehicleId: 'car', date: '2026-03-01', ...overrides });

describe('lifetime cost (MA-28)', () => {
  it('sums only live links and counts logs without a cost', () => {
    const logs: CostLog[] = [
      assetLog({ id: 'a', cost: 120.4 }),
      assetLog({ id: 'b', cost: 80 }),
      assetLog({ id: 'c' }),
      assetLog({ id: 'd', cost: Number.NaN }),
      assetLog({ id: 'e', cost: 0 }),
      assetLog({ id: 'f', cost: -40 }),
      // A legacy log without targetType is still linked by its id.
      { id: 'g', assetId: 'hvac', date: '2026-01-01', cost: 10 },
      // A log of a deleted asset keeps only formerTargetName: not counted.
      { id: 'h', targetType: 'general', date: '2026-01-01', cost: 999 },
      assetLog({ id: 'i', assetId: 'other', cost: 500 }),
    ];
    const total = lifetimeCost(logs, { type: 'home_asset', id: 'hvac' });
    assert.equal(total.counted, 3);
    assert.ok(Math.abs(total.total - 210.4) < 1e-9);
    assert.equal(total.withoutCost, 2);
    assert.equal(total.ignored, 2);
    assert.equal(withoutCostText(total.withoutCost), '2 logs without a cost');
    assert.equal(withoutCostText(1), '1 log without a cost');
    assert.equal(withoutCostText(0), null);
    assert.equal(formatWholeDollars(total.total), '$210');
    assert.equal(formatWholeDollars(1234.5), '$1,235');
  });

  it('puts spending in household-zone years with Undated last', () => {
    const logs: CostLog[] = [
      // 2026-01-01T03:00Z is still Dec 31 in Chicago.
      assetLog({ id: 'a', date: '2026-01-01T03:00:00.000Z', cost: 100 }),
      assetLog({ id: 'b', date: '2026-06-01', cost: 50 }),
      assetLog({ id: 'c', date: '', cost: 25 }),
      assetLog({ id: 'd', date: 'not a date', cost: 5 }),
      assetLog({ id: 'e', date: '2024-02-02', cost: 7 }),
      assetLog({ id: 'f', date: '2026-07-01' }),
    ];
    assert.deepEqual(spendByYear(logs, TZ), [
      { year: '2026', total: 50, counted: 1 },
      { year: '2025', total: 100, counted: 1 },
      { year: '2024', total: 7, counted: 1 },
      { year: UNDATED, total: 30, counted: 2 },
    ]);
  });

  it('year totals always add up to the lifetime total (property)', () => {
    const random = rng(28);
    const dates = ['2024-05-01', '2025-12-31T23:30:00.000Z', '2026-01-01', '', 'garbage', '2023-07-04T12:00:00Z'];
    for (let run = 0; run < 300; run += 1) {
      const logs: CostLog[] = Array.from({ length: Math.floor(random() * 30) }, (_, index) => {
        const pick = random();
        const cost = pick < 0.15 ? undefined : pick < 0.25 ? Number.NaN : pick < 0.35 ? -random() * 100 : pick < 0.4 ? 0 : Math.round(random() * 100000) / 100;
        return assetLog({ id: String(index), date: dates[Math.floor(random() * dates.length)], cost });
      });
      const sum = sumCosts(logs);
      const years = spendByYear(logs, TZ);
      assert.ok(Math.abs(years.reduce((acc, year) => acc + year.total, 0) - sum.total) < 1e-6);
      assert.equal(years.reduce((acc, year) => acc + year.counted, 0), sum.counted);
      assert.equal(sum.counted + sum.withoutCost + sum.ignored, logs.length);
      assert.ok(years.every((year, index) => year.year !== UNDATED || index === years.length - 1));
    }
  });
});

describe('cost per mile (MA-28)', () => {
  it('needs two readings spanning more than 500 miles', () => {
    const logs = [vehicleLog({ id: 'a', cost: 300, mileage: 40000 }), vehicleLog({ id: 'b', cost: 100, mileage: 40400 })];
    assert.deepEqual(costPerMile({ id: 'car' }, logs), { kind: 'insufficient', text: NOT_ENOUGH_MILEAGE });
    assert.deepEqual(costPerMile({ id: 'car', currentMileage: 40500 }, logs), { kind: 'insufficient', text: NOT_ENOUGH_MILEAGE });
    assert.deepEqual(costPerMile({ id: 'car', currentMileage: 50000 }, [logs[0]]).kind, 'ok');
    assert.deepEqual(costPerMile({ id: 'car', currentMileage: 50000 }, []), { kind: 'insufficient', text: NOT_ENOUGH_MILEAGE });
    const ok = costPerMile({ id: 'car', currentMileage: 44000 }, logs);
    assert.equal(ok.kind, 'ok');
    if (ok.kind === 'ok') {
      assert.equal(ok.miles, 4000);
      assert.equal(ok.perMile, 0.1);
      assert.equal(formatPerMile(ok.perMile), '$0.10 per mile');
    }
  });

  it('ignores bad readings and says when nothing was spent', () => {
    const logs = [vehicleLog({ id: 'a', mileage: Number.NaN, cost: 5 }), vehicleLog({ id: 'b', mileage: -10 }), vehicleLog({ id: 'c', mileage: 1000 })];
    assert.equal(costPerMile({ id: 'car', currentMileage: 1400 }, logs).kind, 'insufficient');
    assert.deepEqual(costPerMile({ id: 'car', currentMileage: 9000 }, [vehicleLog({ id: 'a', mileage: 1000 })]), { kind: 'insufficient', text: 'No costs recorded yet' });
  });
});

describe('repair versus replace (MA-28)', () => {
  const target = { type: 'home_asset' as const, id: 'hvac' };
  const repairs = [
    assetLog({ id: 'a', type: 'repair', cost: 2000 }),
    assetLog({ id: 'b', type: 'replacement', cost: 1100.6 }),
    assetLog({ id: 'c', type: 'routine', cost: 5000 }),
  ];

  it('speaks up past half the purchase price', () => {
    const over = repairShare({ purchasePrice: 5000 }, target, repairs);
    assert.deepEqual(over, { kind: 'over', percent: 62, repairTotal: 3100.6, text: 'Repairs have cost about 62% of the purchase price' });
    assert.equal(repairShare({ purchasePrice: 6201.2 }, target, repairs).kind, 'under');
    assert.equal(repairShare({ purchasePrice: 6201 }, target, repairs).kind, 'over');
  });

  it('asks for a usable purchase price', () => {
    for (const purchasePrice of [undefined, null, 0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.deepEqual(repairShare({ purchasePrice }, target, repairs), { kind: 'no-price', repairTotal: 3100.6, text: ADD_PURCHASE_PRICE });
    }
    assert.deepEqual(repairShare({}, target, [assetLog({ id: 'x', type: 'routine', cost: 10 })]), { kind: 'no-repairs' });
  });

  it('bundles a summary, with cost per mile for vehicles only', () => {
    assert.equal(costSummary({ id: 'hvac', purchasePrice: 5000 }, 'home_asset', repairs, TZ).perMile, undefined);
    const vehicle = costSummary({ id: 'car', currentMileage: 10000 }, 'vehicle', [vehicleLog({ id: 'v', cost: 50, mileage: 1000 })], TZ);
    assert.equal(vehicle.perMile?.kind, 'ok');
    assert.equal(vehicle.lifetime.total, 50);
  });
});

describe('insight components', () => {
  it('CostSummary prints whole dollars, Undated, cost per mile and the repair hint', () => {
    const logs: CostLog[] = [
      vehicleLog({ id: 'a', type: 'repair', cost: 1999.6, mileage: 10000, date: '2025-04-01' }),
      vehicleLog({ id: 'b', type: 'repair', cost: 1500.2, date: 'unknown' }),
      vehicleLog({ id: 'c' }),
    ];
    const html = renderToStaticMarkup(createElement(CostSummary, { name: 'Blue car', summary: costSummary({ id: 'car', currentMileage: 20000, purchasePrice: 6000 }, 'vehicle', logs, TZ) }));
    assert.match(html, /aria-label="Costs for Blue car"/);
    assert.match(html, /\$3,500/);
    assert.match(html, /1 log without a cost/);
    assert.match(html, /<dt[^>]*>2025<\/dt><dd[^>]*>\$2,000<\/dd>/);
    assert.match(html, /<dt[^>]*>Undated<\/dt><dd[^>]*>\$1,500<\/dd>/);
    assert.match(html, /\$0\.35 per mile/);
    assert.match(html, /Repairs have cost about 58% of the purchase price/);
    const empty = renderToStaticMarkup(createElement(CostSummary, { name: 'Drill', summary: costSummary({ id: 'drill' }, 'home_asset', [], TZ) }));
    assert.match(empty, /No costs recorded yet/);
    assert.doesNotMatch(empty, /Spend by year|purchase price/);
  });

  it('FilterChips marks the selected chip pressed, ignoring case', () => {
    const html = renderToStaticMarkup(createElement(FilterChips, {
      label: 'Location', selected: 'kitchen', onSelect: () => {},
      chips: [{ value: 'Garage', label: 'Garage', count: 1 }, { value: 'Kitchen', label: 'Kitchen', count: 2 }],
    }));
    assert.match(html, /role="group" aria-label="Location"/);
    assert.match(html, /aria-pressed="false"[^>]*>All</);
    assert.match(html, /aria-pressed="true" aria-label="Kitchen, 2"/);
    assert.match(html, /aria-pressed="false" aria-label="Garage, 1"/);
  });
});

describe('insight components use tokens only', () => {
  it('has no raw color literals', () => {
    for (const file of ['cost-summary.tsx', 'filter-chips.tsx', 'print-label.tsx']) {
      const source = readFileSync(resolve(process.cwd(), 'src/components/maintenance', file), 'utf8');
      assert.doesNotMatch(source, /#[0-9a-f]{3,8}\b|rgba?\(|hsla?\((?!var)/i, file);
    }
  });

  it('chips are toggle buttons at least --target-min tall', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/components/maintenance/filter-chips.tsx'), 'utf8');
    assert.match(source, /aria-pressed/);
    assert.match(source, /min-h-\[var\(--target-min\)\]/);
    assert.match(source, /overflow-x-auto/);
  });
});
