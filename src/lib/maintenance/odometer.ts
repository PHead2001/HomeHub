// Vehicle odometer (H10): mileage shown as rolling digit wheels. Pure helpers,
// unit tested; the component lives in src/components/maintenance/odometer.tsx.

/** Fewest wheels shown, like a real odometer (leading zeros fill the rest). */
export const ODOMETER_MIN_DIGITS = 6;

/**
 * The digits of `miles` (rounded down, never negative), left-padded with zeros to
 * at least `minDigits` wheels. 48750 → [0, 4, 8, 7, 5, 0].
 */
export function odometerDigits(miles: number, minDigits = ODOMETER_MIN_DIGITS): number[] {
  const value = Number.isFinite(miles) ? Math.max(0, Math.floor(miles)) : 0;
  return String(value).padStart(minDigits, '0').split('').map(Number);
}

/**
 * Vertical offset of a wheel's strip of 0–9 showing `digit`, as a percentage of
 * the strip's height (each of the 10 digits is 10%): digit 7 → -70.
 */
export function wheelOffset(digit: number): number {
  const d = Math.min(9, Math.max(0, Math.round(digit)));
  return d === 0 ? 0 : -d * 10;
}

/** Accessible text for a mileage, e.g. "48,750 miles". */
export function mileageText(miles: number): string {
  const value = Math.max(0, Math.floor(miles));
  return `${value.toLocaleString('en-US')} ${value === 1 ? 'mile' : 'miles'}`;
}
