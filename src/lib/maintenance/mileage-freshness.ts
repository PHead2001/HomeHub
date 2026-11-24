// "Last updated N days ago" for a vehicle's odometer (MA-19, MA-6e), pure.
import { differenceInCalendarDays, isValid, parseISO } from 'date-fns';
import type { Vehicle } from '../types';

/** A reading older than this many days gets a nudge to update it. */
export const MILEAGE_STALE_DAYS = 30;

export type MileageFreshness =
  | { state: 'missing'; message: string }
  | { state: 'unknown'; message: string }
  | { state: 'fresh' | 'stale'; days: number; message: string };

const daysLabel = (days: number) => (days <= 0 ? 'today' : days === 1 ? 'yesterday' : `${days} days ago`);

/**
 * How current the odometer is, in household days: no mileage at all is `missing` (mileage
 * reminders cannot start), no `mileageUpdatedAt` (set before M1) is `unknown`, older than
 * MILEAGE_STALE_DAYS is `stale`.
 */
export const mileageFreshness = (vehicle: Pick<Vehicle, 'currentMileage' | 'mileageUpdatedAt'>, today: string): MileageFreshness => {
  if (typeof vehicle.currentMileage !== 'number') {
    return { state: 'missing', message: 'Add the current mileage so mileage reminders can start.' };
  }
  const updated = vehicle.mileageUpdatedAt ? parseISO(vehicle.mileageUpdatedAt) : null;
  const now = parseISO(today);
  if (!updated || !isValid(updated) || !isValid(now)) {
    return { state: 'unknown', message: 'Mileage last updated: not recorded. Update it to keep reminders accurate.' };
  }
  const days = Math.max(0, differenceInCalendarDays(now, updated));
  if (days > MILEAGE_STALE_DAYS) {
    return { state: 'stale', days, message: `Mileage last updated ${daysLabel(days)}. Update it to keep reminders accurate.` };
  }
  return { state: 'fresh', days, message: `Mileage updated ${daysLabel(days)}.` };
};

/** The Update mileage form's check of what was typed (a whole number 0 to 2,000,000). */
export const parseMileageInput = (raw: string): number | null => {
  const text = raw.replace(/[,\s]/g, '');
  if (!/^\d{1,7}$/.test(text)) return null;
  const value = Number(text);
  return value <= 2_000_000 ? value : null;
};
