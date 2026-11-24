// Home health score (H10, MA-10). Pure and deterministic: computed from the same
// reminders the Reminders tab and the hourly server job use, plus flagged status.
// The formula is documented in docs/modules/maintenance-center/README.md
// ("Home health score"); keep both in sync.
//
// Honest by construction:
// - only tracked items are scored (a scheduled schedule, a registration or
//   inspection date, or a "Needs attention" flag); with none, there is no score;
// - the home score is the average of the tracked items' scores;
// - nothing that is merely coming up or due soon costs points, and nothing can
//   raise a score while time passes (warranties do not count at all; expiry costs
//   the same as overdue work); snoozed reminders cost nothing;
// - recent logs earn no bonus.
import { diffDays, isDayString, toDay } from '../../../functions/src/shared/calendar';
import {
  buildMaintenanceReminders,
  type AssetInput,
  type MaintenanceReminder,
  type VehicleInput,
} from '../../../functions/src/shared/maintenance-reminders';
import type { HomeAsset, MaintenanceLog, Vehicle } from '../types';
import { spanLabel } from './reminder-copy';
import { getAssetScheduleMode, getVehicleScheduleMode } from './schedules';

export const HEALTH_RULES = {
  /** Overdue schedule/service or expired registration/inspection: base points, plus `overduePerStep` per 30 days or 500 miles late, capped. */
  overdueBase: 10,
  overduePerStep: 2,
  overdueMax: 20,
  /** Schedule/service due today. */
  dueToday: 5,
  /** Due soon or upcoming costs nothing. */
  dueSoon: 0,
  /** Registration/inspection expiring today. */
  documentExpiresToday: 5,
  /** Registration/inspection expiring soon costs nothing. */
  documentExpiresSoon: 0,
  /** Warranties never affect health (they appear in reminders and Coming up only). */
  warranty: 0,
  /** Asset or vehicle flagged "Needs attention". */
  needsAttention: 10,
} as const;

export type HealthBand = 'good' | 'fair' | 'poor';

export type HealthDeduction = {
  id: string;
  /** Points off the item's own score. */
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
  /** Items averaged into this score (1 for an item's own score). */
  tracked: number;
};

/** The home has active items but none is tracked yet: no score rather than a meaningless 100. */
export type HealthUnscored = {
  score: null;
  reason: 'not_enough_tracked';
};

export type HomeHealth = {
  /** Null when there is nothing active at all; unscored when nothing active is tracked. */
  overall: HealthResult | HealthUnscored | null;
  /** Keyed by `home_asset:{id}` / `vehicle:{id}`; only tracked, active items (retired, sold and untracked are absent). */
  targets: Record<string, HealthResult>;
};

export const healthKey = (targetType: 'home_asset' | 'vehicle', id: string) => `${targetType}:${id}`;

export const healthBand = (score: number): HealthBand => (score >= 85 ? 'good' : score >= 60 ? 'fair' : 'poor');

export const HEALTH_BAND_LABELS: Record<HealthBand, string> = {
  good: 'In good shape',
  fair: 'Needs some care',
  poor: 'Needs attention',
};

/** True for a scored result (narrows `HomeHealth['overall']`). */
export const isScored = (health: HealthResult | HealthUnscored | null | undefined): health is HealthResult =>
  Boolean(health) && typeof health!.score === 'number';

const clamp = (value: number) => Math.max(0, Math.min(100, Math.round(value)));

const overduePoints = (steps: number) =>
  Math.min(HEALTH_RULES.overdueMax, HEALTH_RULES.overdueBase + HEALTH_RULES.overduePerStep * Math.max(0, steps));

const dayOf = (value: string | undefined, timeZone?: string) => {
  if (!value) return null;
  if (timeZone) return toDay(value, timeZone);
  const day = value.slice(0, 10);
  return isDayString(day) ? day : null;
};

/**
 * Points and plain-language reason for one reminder, or null when it costs
 * nothing. Never decreases as time passes for the same data: upcoming and due soon
 * cost 0, due today 5, overdue 10 rising by 2 per 30 days (or 500 miles) to 20.
 */
export const reminderDeduction = (
  reminder: MaintenanceReminder,
  today: string,
  timeZone?: string,
): { points: number; reason: string } | null => {
  if (reminder.group === 'warranty') return null;
  // A snooze only applies to an upcoming or due-soon date, which costs nothing anyway.
  if (reminder.snoozed) return null;
  const due = dayOf(reminder.dueDate, timeZone);
  const daysLate = due ? -diffDays(due, today) : 0;

  if (reminder.group === 'vehicle_document') {
    const bare = reminder.title.replace(/^Vehicle /, '');
    const name = bare.charAt(0).toUpperCase() + bare.slice(1);
    if (reminder.status === 'overdue') {
      return { points: overduePoints(Math.floor(Math.max(0, daysLate) / 30)), reason: `${name} expired ${spanLabel(daysLate)} ago` };
    }
    if (reminder.status === 'due_today') return { points: HEALTH_RULES.documentExpiresToday, reason: `${name} expires today` };
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
  return null;
};

const validDay = (value: string | undefined, timeZone: string) => Boolean(toDay(value, timeZone));

/**
 * Whether an item counts toward the home score. Depends only on stored fields,
 * never on the date, so the tracked set (and the average) cannot shift as time
 * passes: an asset with a scheduled (non-checklist) schedule; a vehicle with a
 * scheduled service or a registration or inspection date; any item flagged
 * "Needs attention". A warranty alone does not make an item tracked.
 */
export const isTrackedAsset = (asset: HomeAsset) =>
  asset.status === 'needs_attention' || (asset.schedules || []).some((schedule) => getAssetScheduleMode(schedule) === 'scheduled');

export const isTrackedVehicle = (vehicle: Vehicle, timeZone: string) =>
  vehicle.status === 'needs_attention'
  || (vehicle.serviceSchedules || []).some((schedule) => getVehicleScheduleMode(schedule) === 'scheduled')
  || validDay(vehicle.registrationExpiration, timeZone)
  || validDay(vehicle.inspectionExpiration, timeZone);

const sortDeductions = (deductions: HealthDeduction[]) =>
  [...deductions].sort((a, b) => b.points - a.points || a.targetName.localeCompare(b.targetName) || a.reason.localeCompare(b.reason));

const itemResult = (deductions: HealthDeduction[]): HealthResult => {
  const score = clamp(100 - deductions.reduce((total, item) => total + item.points, 0));
  return { score, band: healthBand(score), deductions: sortDeductions(deductions), tracked: 1 };
};

/**
 * Scores the home and every tracked, active asset and vehicle.
 * Item score = 100 - its deductions, 0-100.
 * Home score = the average of the tracked items' scores (rounded), or no score
 * (`not_enough_tracked`) when nothing active is tracked. `logs` is accepted for
 * compatibility and ignored (there is no log bonus).
 */
export const computeHomeHealth = (input: {
  assets: HomeAsset[];
  vehicles: Vehicle[];
  logs?: MaintenanceLog[];
  today: string;
  timeZone: string;
}): HomeHealth => {
  const { assets, vehicles, today, timeZone } = input;
  const activeAssets = assets.filter((asset) => asset.status !== 'retired');
  const activeVehicles = vehicles.filter((vehicle) => vehicle.status !== 'retired' && vehicle.status !== 'sold');
  if (activeAssets.length === 0 && activeVehicles.length === 0) return { overall: null, targets: {} };

  const trackedAssets = activeAssets.filter(isTrackedAsset);
  const trackedVehicles = activeVehicles.filter((vehicle) => isTrackedVehicle(vehicle, timeZone));
  if (trackedAssets.length === 0 && trackedVehicles.length === 0) {
    return { overall: { score: null, reason: 'not_enough_tracked' }, targets: {} };
  }

  const reminders = buildMaintenanceReminders(
    trackedAssets as unknown as AssetInput[],
    trackedVehicles as unknown as VehicleInput[],
    today,
    timeZone,
  );
  const byTarget = new Map<string, HealthDeduction[]>();
  const push = (key: string, deduction: HealthDeduction) => {
    byTarget.set(key, [...(byTarget.get(key) || []), deduction]);
  };

  reminders.forEach((reminder) => {
    const deduction = reminderDeduction(reminder, today, timeZone);
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
    ...trackedAssets.filter((asset) => asset.status === 'needs_attention').map((asset) => ({
      targetType: 'home_asset' as const, id: asset.id, name: asset.name,
      deepLink: `/maintenance?asset=${encodeURIComponent(asset.id)}`,
    })),
    ...trackedVehicles.filter((vehicle) => vehicle.status === 'needs_attention').map((vehicle) => ({
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

  const targets: Record<string, HealthResult> = {};
  const keys = [
    ...trackedAssets.map((asset) => healthKey('home_asset', asset.id)),
    ...trackedVehicles.map((vehicle) => healthKey('vehicle', vehicle.id)),
  ];
  keys.forEach((key) => { targets[key] = itemResult(byTarget.get(key) || []); });

  const score = clamp(keys.reduce((total, key) => total + targets[key].score, 0) / keys.length);
  return {
    overall: {
      score,
      band: healthBand(score),
      deductions: sortDeductions([...byTarget.values()].flat()),
      tracked: keys.length,
    },
    targets,
  };
};

/** Screen-reader and tooltip text, e.g. "Home health 82 out of 100, needs some care." */
export const healthSummaryText = (label: string, health: Pick<HealthResult, 'score' | 'band'>) =>
  `${label} ${health.score} out of 100, ${HEALTH_BAND_LABELS[health.band].toLowerCase()}.`;
