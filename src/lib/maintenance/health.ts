// Home health score (H10). Pure and deterministic: computed from the same
// reminders the Reminders tab and the hourly server job use, plus flagged status
// and recent logs. The formula is documented in
// docs/modules/maintenance-center/README.md ("Home health score"); keep both in sync.
import { addDays, diffDays, isDayString } from '../../../functions/src/shared/calendar';
import {
  buildMaintenanceReminders,
  type AssetInput,
  type MaintenanceReminder,
  type VehicleInput,
} from '../../../functions/src/shared/maintenance-reminders';
import type { HomeAsset, MaintenanceLog, Vehicle } from '../types';
import { spanLabel } from './reminder-copy';

export const HEALTH_RULES = {
  /** Overdue schedule/service: base points, plus `overduePerStep` per 30 days or 500 miles late, capped. */
  overdueBase: 10,
  overduePerStep: 2,
  overdueMax: 20,
  dueToday: 5,
  dueSoon: 2,
  /** Registration or inspection that has expired. */
  documentExpired: 15,
  /** Warranty ending today or within the reminder window (an expired warranty costs nothing). */
  warrantyEnding: 2,
  /** Asset or vehicle flagged "Needs attention". */
  needsAttention: 10,
  /** Each log for an item in the last `recentDays` days. */
  recentLog: 2,
  recentLogMaxPerItem: 6,
  recentLogMaxOverall: 10,
  recentDays: 90,
} as const;

export type HealthBand = 'good' | 'fair' | 'poor';

export type HealthDeduction = {
  id: string;
  points: number;
  /** Item name, e.g. "Main HVAC System". */
  targetName: string;
  /** What is wrong, e.g. "Replace air filter is 3 months overdue". */
  reason: string;
  targetType: 'home_asset' | 'vehicle';
  targetId: string;
  deepLink: string;
};

export type HealthResult = {
  score: number;
  band: HealthBand;
  deductions: HealthDeduction[];
  bonus: number;
  /** Logs counted toward the bonus. */
  recentLogs: number;
};

export type HomeHealth = {
  /** Null when there is nothing active to score. */
  overall: HealthResult | null;
  /** Keyed by `home_asset:{id}` / `vehicle:{id}`; retired, sold items are absent. */
  targets: Record<string, HealthResult>;
};

export const healthKey = (targetType: 'home_asset' | 'vehicle', id: string) => `${targetType}:${id}`;

export const healthBand = (score: number): HealthBand => (score >= 85 ? 'good' : score >= 60 ? 'fair' : 'poor');

export const HEALTH_BAND_LABELS: Record<HealthBand, string> = {
  good: 'In good shape',
  fair: 'Needs some care',
  poor: 'Needs attention',
};

const clamp = (value: number) => Math.max(0, Math.min(100, Math.round(value)));

const overduePoints = (steps: number) =>
  Math.min(HEALTH_RULES.overdueMax, HEALTH_RULES.overdueBase + HEALTH_RULES.overduePerStep * Math.max(0, steps));

const dayOf = (value?: string) => {
  if (!value) return null;
  const day = value.slice(0, 10);
  return isDayString(day) ? day : null;
};

/** Points and plain-language reason for one reminder, or null when it costs nothing. */
export const reminderDeduction = (
  reminder: MaintenanceReminder,
  today: string,
): { points: number; reason: string } | null => {
  const due = dayOf(reminder.dueDate);
  const daysLate = due ? -diffDays(due, today) : 0;
  const daysLeft = due ? diffDays(due, today) : 0;

  if (reminder.group === 'warranty') {
    if (reminder.status === 'due_today') return { points: HEALTH_RULES.warrantyEnding, reason: 'warranty ends today' };
    if (reminder.status === 'due_soon') return { points: HEALTH_RULES.warrantyEnding, reason: `warranty ends in ${spanLabel(daysLeft)}` };
    return null;
  }

  if (reminder.group === 'vehicle_document') {
    const bare = reminder.title.replace(/^Vehicle /, '');
    const name = bare.charAt(0).toUpperCase() + bare.slice(1);
    if (reminder.status === 'overdue') return { points: HEALTH_RULES.documentExpired, reason: `${name} expired ${spanLabel(daysLate)} ago` };
    if (reminder.status === 'due_today') return { points: HEALTH_RULES.dueToday, reason: `${name} expires today` };
    if (reminder.status === 'due_soon') return { points: HEALTH_RULES.dueSoon, reason: `${name} expires in ${spanLabel(daysLeft)}` };
    return null;
  }

  // Scheduled maintenance and vehicle service.
  if (reminder.status === 'overdue') {
    const milesOver = typeof reminder.dueMileage === 'number' && typeof reminder.currentMileage === 'number'
      ? reminder.currentMileage - reminder.dueMileage
      : -1;
    const byDate = due && daysLate > 0 ? overduePoints(Math.floor(daysLate / 30)) : 0;
    const byMiles = milesOver >= 0 ? overduePoints(Math.floor(milesOver / 500)) : 0;
    const reason = byMiles > byDate
      ? milesOver > 0
        ? `${reminder.title} is ${milesOver.toLocaleString('en-US')} miles overdue`
        : `${reminder.title} has reached its service mileage`
      : `${reminder.title} is ${spanLabel(daysLate)} overdue`;
    return { points: Math.max(byDate, byMiles, HEALTH_RULES.overdueBase), reason };
  }
  if (reminder.status === 'due_today') return { points: HEALTH_RULES.dueToday, reason: `${reminder.title} is due today` };
  if (reminder.status === 'due_soon') {
    const reason = due && daysLeft > 0
      ? `${reminder.title} is due in ${spanLabel(daysLeft)}`
      : `${reminder.title} is due soon`;
    return { points: HEALTH_RULES.dueSoon, reason };
  }
  return null;
};

const result = (deductions: HealthDeduction[], bonus: number, recentLogs: number): HealthResult => {
  const score = clamp(100 - deductions.reduce((total, item) => total + item.points, 0) + bonus);
  return {
    score,
    band: healthBand(score),
    deductions: [...deductions].sort((a, b) => b.points - a.points || a.targetName.localeCompare(b.targetName)),
    bonus,
    recentLogs,
  };
};

/**
 * Scores the home and every active asset and vehicle.
 * Item score = 100 − its deductions + min(6, 2 × logs in the last 90 days), 0–100.
 * Home score = 100 − all deductions + min(10, the items' bonuses), 0–100.
 */
export const computeHomeHealth = (input: {
  assets: HomeAsset[];
  vehicles: Vehicle[];
  logs: MaintenanceLog[];
  today: string;
  timeZone: string;
}): HomeHealth => {
  const { assets, vehicles, logs, today, timeZone } = input;
  const activeAssets = assets.filter((asset) => asset.status !== 'retired');
  const activeVehicles = vehicles.filter((vehicle) => vehicle.status !== 'retired' && vehicle.status !== 'sold');
  if (activeAssets.length === 0 && activeVehicles.length === 0) return { overall: null, targets: {} };

  const reminders = buildMaintenanceReminders(
    activeAssets as unknown as AssetInput[],
    activeVehicles as unknown as VehicleInput[],
    today,
    timeZone,
  );
  const byTarget = new Map<string, HealthDeduction[]>();
  const push = (key: string, deduction: HealthDeduction) => {
    byTarget.set(key, [...(byTarget.get(key) || []), deduction]);
  };

  reminders.forEach((reminder) => {
    const deduction = reminderDeduction(reminder, today);
    if (!deduction) return;
    push(healthKey(reminder.targetType, reminder.targetId), {
      id: reminder.id,
      points: deduction.points,
      reason: deduction.reason,
      targetName: reminder.relatedName,
      targetType: reminder.targetType,
      targetId: reminder.targetId,
      deepLink: reminder.deepLink,
    });
  });

  const flagged = [
    ...activeAssets.filter((asset) => asset.status === 'needs_attention').map((asset) => ({
      targetType: 'home_asset' as const, id: asset.id, name: asset.name,
      deepLink: `/maintenance?asset=${encodeURIComponent(asset.id)}`,
    })),
    ...activeVehicles.filter((vehicle) => vehicle.status === 'needs_attention').map((vehicle) => ({
      targetType: 'vehicle' as const, id: vehicle.id, name: vehicle.nickname,
      deepLink: `/maintenance?vehicle=${encodeURIComponent(vehicle.id)}`,
    })),
  ];
  flagged.forEach((item) => push(healthKey(item.targetType, item.id), {
    id: `attention-${item.targetType}-${item.id}`,
    points: HEALTH_RULES.needsAttention,
    reason: 'flagged as needing attention',
    targetName: item.name,
    targetType: item.targetType,
    targetId: item.id,
    deepLink: item.deepLink,
  }));

  const since = addDays(today, -HEALTH_RULES.recentDays);
  const recentCount = (targetType: 'home_asset' | 'vehicle', id: string) => logs.filter((log) => {
    const day = dayOf(log.date);
    if (!day || day < since || day > today) return false;
    const type = log.targetType || (log.assetId ? 'home_asset' : log.vehicleId ? 'vehicle' : 'general');
    return targetType === 'home_asset' ? type === 'home_asset' && log.assetId === id : type === 'vehicle' && log.vehicleId === id;
  }).length;

  const targets: Record<string, HealthResult> = {};
  let bonusTotal = 0;
  let logsTotal = 0;
  const all = [
    ...activeAssets.map((asset) => ({ type: 'home_asset' as const, id: asset.id })),
    ...activeVehicles.map((vehicle) => ({ type: 'vehicle' as const, id: vehicle.id })),
  ];
  all.forEach(({ type, id }) => {
    const key = healthKey(type, id);
    const count = recentCount(type, id);
    const bonus = Math.min(HEALTH_RULES.recentLogMaxPerItem, HEALTH_RULES.recentLog * count);
    bonusTotal += bonus;
    logsTotal += count;
    targets[key] = result(byTarget.get(key) || [], bonus, count);
  });

  const allDeductions = [...byTarget.values()].flat();
  return {
    overall: result(allDeductions, Math.min(HEALTH_RULES.recentLogMaxOverall, bonusTotal), logsTotal),
    targets,
  };
};

/** Screen-reader and tooltip text, e.g. "Home health 82 out of 100, needs some care." */
export const healthSummaryText = (label: string, health: Pick<HealthResult, 'score' | 'band'>) =>
  `${label} ${health.score} out of 100, ${HEALTH_BAND_LABELS[health.band].toLowerCase()}.`;
