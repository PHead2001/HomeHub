// Cost insights (MA-28): lifetime cost per asset or vehicle, spend per calendar
// year, cost per mile and a repair-versus-replace indication. Pure, unit tested
// (tests/unit/maintenance-insights-costs.test.ts); shown by
// src/components/maintenance/cost-summary.tsx.
//
// Money is a single currency: every cost is read as US dollars and nothing is
// converted. HomeHub stores no currency per log, so multi-currency households are
// not supported. Totals are rounded to whole dollars when shown; cost per mile is
// shown in cents (a whole-dollar figure would read $0).
import { toDay } from '../../../functions/src/shared/calendar';
import type { MaintenanceLog, MaintenanceLogType } from '../types';
import { linkedLogs, type LinkFields, type MaintenanceTarget } from './links';

export type CostLog = LinkFields & Pick<MaintenanceLog, 'date' | 'cost'> & Partial<Pick<MaintenanceLog, 'id' | 'type' | 'mileage'>>;

/** Label for logs whose date is missing or cannot be read. They are counted, never dropped. */
export const UNDATED = 'Undated';

/** Log types that count as repair spending for the repair-versus-replace hint. */
export const REPAIR_TYPES: readonly MaintenanceLogType[] = ['repair', 'replacement'];

/** Share of the purchase price repairs must pass before the hint is shown. */
export const REPAIR_SHARE_THRESHOLD = 0.5;

/** A vehicle needs readings spanning more than this many miles before cost per mile is shown. */
export const MIN_COST_PER_MILE_SPAN = 500;

export const NOT_ENOUGH_MILEAGE = 'Not enough mileage data';
export const ADD_PURCHASE_PRICE = 'Add the purchase price to compare';

/** A cost that is counted: a finite number above zero. */
export const isCountedCost = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0;

export type CostTotal = {
  /** Sum of counted costs, unrounded. */
  total: number;
  /** Logs whose cost was counted. */
  counted: number;
  /** Logs with no cost (missing, or not a number). */
  withoutCost: number;
  /** Logs with a cost of zero or less, left out of the total. */
  ignored: number;
};

/** Sums the counted costs of the given logs. */
export function sumCosts(logs: readonly Pick<MaintenanceLog, 'cost'>[]): CostTotal {
  const result: CostTotal = { total: 0, counted: 0, withoutCost: 0, ignored: 0 };
  for (const log of logs) {
    const cost = log.cost as unknown;
    if (isCountedCost(cost)) {
      result.total += cost;
      result.counted += 1;
    } else if (typeof cost === 'number' && Number.isFinite(cost)) {
      result.ignored += 1;
    } else {
      result.withoutCost += 1;
    }
  }
  return result;
}

/** Lifetime cost of an asset or vehicle: the logs linked to it now (former links are not counted). */
export const lifetimeCost = (logs: readonly CostLog[], target: MaintenanceTarget): CostTotal =>
  sumCosts(linkedLogs(logs, target));

export type YearSpend = { year: string; total: number; counted: number };

/**
 * Spend per calendar year of the household (`timeZone`), newest year first,
 * with "Undated" last for logs whose date is missing or unreadable. Logs without
 * a counted cost are left out; the year totals always add up to `sumCosts`.
 */
export function spendByYear(logs: readonly CostLog[], timeZone: string): YearSpend[] {
  const years = new Map<string, YearSpend>();
  for (const log of logs) {
    const cost = log.cost as unknown;
    if (!isCountedCost(cost)) continue;
    const day = toDay(log.date, timeZone);
    const year = day ? day.slice(0, 4) : UNDATED;
    const entry = years.get(year) ?? { year, total: 0, counted: 0 };
    entry.total += cost;
    entry.counted += 1;
    years.set(year, entry);
  }
  return [...years.values()].sort((a, b) => {
    if (a.year === UNDATED) return 1;
    if (b.year === UNDATED) return -1;
    return b.year.localeCompare(a.year);
  });
}

export type CostPerMile =
  | { kind: 'ok'; perMile: number; miles: number; total: number }
  | { kind: 'insufficient'; text: string };

const isReading = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;

/**
 * Lifetime cost divided by the miles the readings span (highest minus lowest of
 * the linked logs' mileage and the vehicle's current mileage). Shown only with at
 * least two readings spanning more than 500 miles and a cost to divide.
 */
export function costPerMile(
  vehicle: { id: string; currentMileage?: number | null },
  logs: readonly CostLog[],
): CostPerMile {
  const linked = linkedLogs(logs, { type: 'vehicle', id: vehicle.id });
  const readings = linked.map((log) => log.mileage as unknown).filter(isReading);
  if (isReading(vehicle.currentMileage)) readings.push(vehicle.currentMileage);
  const miles = readings.length >= 2 ? Math.max(...readings) - Math.min(...readings) : 0;
  if (miles <= MIN_COST_PER_MILE_SPAN) return { kind: 'insufficient', text: NOT_ENOUGH_MILEAGE };
  const { total } = sumCosts(linked);
  if (total <= 0) return { kind: 'insufficient', text: 'No costs recorded yet' };
  return { kind: 'ok', perMile: total / miles, miles, total };
}

export type RepairShare =
  | { kind: 'over'; percent: number; repairTotal: number; text: string }
  | { kind: 'under'; percent: number; repairTotal: number }
  | { kind: 'no-price'; repairTotal: number; text: string }
  | { kind: 'no-repairs' };

/**
 * Repair-versus-replace hint: the counted costs of repair and replacement logs
 * over the item's life, against its purchase price. Above 50% it says "Repairs
 * have cost about N% of the purchase price". Without a usable purchase price
 * (missing, zero, negative or not a number) and with repair costs, it asks for one.
 */
export function repairShare(
  item: { purchasePrice?: number | null },
  target: MaintenanceTarget,
  logs: readonly CostLog[],
): RepairShare {
  const repairs = linkedLogs(logs, target).filter((log) => REPAIR_TYPES.includes(log.type as MaintenanceLogType));
  const repairTotal = sumCosts(repairs).total;
  if (repairTotal <= 0) return { kind: 'no-repairs' };
  const price = item.purchasePrice as unknown;
  if (!isCountedCost(price)) return { kind: 'no-price', repairTotal, text: ADD_PURCHASE_PRICE };
  const percent = Math.round((repairTotal / price) * 100);
  if (repairTotal / price > REPAIR_SHARE_THRESHOLD) {
    return { kind: 'over', percent, repairTotal, text: `Repairs have cost about ${percent}% of the purchase price` };
  }
  return { kind: 'under', percent, repairTotal };
}

export type CostSummaryData = {
  lifetime: CostTotal;
  years: YearSpend[];
  /** Vehicles only. */
  perMile?: CostPerMile;
  repair: RepairShare;
};

/** Everything the cost summary shows for one asset or vehicle. */
export function costSummary(
  item: { id: string; purchasePrice?: number | null; currentMileage?: number | null },
  type: MaintenanceTarget['type'],
  logs: readonly CostLog[],
  timeZone: string,
): CostSummaryData {
  const target = { type, id: item.id };
  const linked = linkedLogs(logs, target);
  return {
    lifetime: sumCosts(linked),
    years: spendByYear(linked, timeZone),
    ...(type === 'vehicle' ? { perMile: costPerMile(item, logs) } : {}),
    repair: repairShare(item, target, logs),
  };
}

const wholeDollars = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 0, maximumFractionDigits: 0 });
const cents = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** A summary amount in whole US dollars ("$1,235"); costs are never converted. */
export const formatWholeDollars = (value: number) => wholeDollars.format(Math.round(value));

/** Cost per mile in cents ("$0.12 per mile"). */
export const formatPerMile = (value: number) => `${cents.format(value)} per mile`;

/** "1 log without a cost", "3 logs without a cost", or null. */
export const withoutCostText = (count: number) =>
  count > 0 ? `${count.toLocaleString('en-US')} ${count === 1 ? 'log' : 'logs'} without a cost` : null;
