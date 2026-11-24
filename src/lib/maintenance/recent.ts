/**
 * The Overview's 30-day counts (MA-11f): logs dated in the last 30 days and what they cost,
 * counted on the household's calendar days, not the device's. A log dated today or in the
 * 29 days before counts (a log dated after today too, as before); its date is a `yyyy-MM-dd`
 * day or, on legacy logs, an instant read in the household zone. A log without a readable
 * date is not counted.
 */
import { addDays, toDay } from '../../../functions/src/shared/calendar';
import type { HomeAsset, MaintenanceLog, Vehicle } from '../types';

export const RECENT_LOG_DAYS = 30;

export function recentLogSummary(
  logs: Pick<MaintenanceLog, 'date' | 'cost'>[],
  assets: Pick<HomeAsset, 'status'>[],
  vehicles: Pick<Vehicle, 'status'>[],
  today: string,
  timeZone: string,
): { recentLogs: number; recentCost: number; needingAttention: number } {
  const cutoff = addDays(today, -RECENT_LOG_DAYS);
  let recentLogs = 0;
  let recentCost = 0;
  for (const log of logs) {
    const day = toDay(log.date, timeZone);
    if (!day || day <= cutoff) continue;
    recentLogs += 1;
    if (typeof log.cost === 'number') recentCost += log.cost;
  }
  const needingAttention = assets.filter((asset) => asset.status === 'needs_attention').length
    + vehicles.filter((vehicle) => vehicle.status === 'needs_attention').length;
  return { recentLogs, recentCost, needingAttention };
}
