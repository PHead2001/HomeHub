// "Last updated N days ago" for a vehicle's odometer (MA-19, MA-6e), pure.
import { differenceInCalendarDays, isValid, parseISO } from 'date-fns';
import type { Vehicle } from '../types';
import { mileageWarningMessage } from './action-call';
import { mileageWarning } from './operations';

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

export type MileageConfirmation = { reading: number; kind: 'lower' | 'jump'; message: string };

/**
 * What pressing Save in Update mileage does: ask once (a reading lower than the recorded mileage
 * shows the correction copy, a jump of more than 20,000 asks too), or send, as a correction when
 * the person confirmed a lower reading. `confirmed` is the question already on screen for this
 * reading.
 */
export const planMileageSave = (reading: number, recorded: number | undefined, confirmed: MileageConfirmation | null):
  | { kind: 'ask'; confirmation: MileageConfirmation }
  | { kind: 'send'; correction: boolean } => {
  const warning = mileageWarning(reading, recorded);
  if (warning && typeof recorded === 'number' && confirmed?.reading !== reading) {
    return { kind: 'ask', confirmation: { reading, kind: warning, message: mileageWarningMessage(warning, recorded, reading, 'correction') } };
  }
  return { kind: 'send', correction: warning === 'lower' || (confirmed?.reading === reading && confirmed.kind === 'lower') };
};

/**
 * The server refused a reading as lower than the mileage recorded now (someone raised it while the
 * dialog was open, PR #211 review): ask for the correction against that latest mileage, so the next
 * Save sends it as a correction. Without the latest value the question names none.
 */
export const correctionAfterRefusal = (reading: number, latest: number | undefined): MileageConfirmation => ({
  reading,
  kind: 'lower',
  message: typeof latest === 'number'
    ? mileageWarningMessage('lower', latest, reading, 'correction')
    : `The odometer was updated meanwhile to more than ${reading.toLocaleString('en-US')} mi. Saving corrects it down to ${reading.toLocaleString('en-US')} mi. Save anyway?`,
});
