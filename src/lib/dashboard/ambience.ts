/**
 * Time-of-day lighting (H02) and seasonal accents (H27). Pure helpers so the
 * blend is unit-tested; the components only map the weights onto token colors.
 */

export type DayPhase = 'dawn' | 'day' | 'dusk' | 'night';

export const DAY_PHASES: readonly DayPhase[] = ['dawn', 'day', 'dusk', 'night'];

/** Center hour of each phase on a 24 h circle. */
const PHASE_CENTER: Record<DayPhase, number> = { dawn: 6.5, day: 13, dusk: 19, night: 1 };
/** Half-width (hours) of each phase's influence. Wider for long phases. */
const PHASE_SPREAD: Record<DayPhase, number> = { dawn: 3.5, day: 6.5, dusk: 3.5, night: 6.5 };

const circularDistance = (a: number, b: number) => {
  const diff = Math.abs(a - b) % 24;
  return diff > 12 ? 24 - diff : diff;
};

/**
 * Weights for each phase that sum to 1 and change continuously with the time of
 * day (no jump at the hour). `date` is read in local time.
 */
export function phaseWeights(date: Date): Record<DayPhase, number> {
  const hour = date.getHours() + date.getMinutes() / 60 + date.getSeconds() / 3600;
  const raw = Object.fromEntries(DAY_PHASES.map((phase) => {
    const distance = circularDistance(hour, PHASE_CENTER[phase]);
    const spread = PHASE_SPREAD[phase];
    // Raised cosine: 1 at the center, 0 at the edge of the spread.
    const weight = distance >= spread ? 0 : 0.5 * (1 + Math.cos((Math.PI * distance) / spread));
    return [phase, weight];
  })) as Record<DayPhase, number>;
  const total = DAY_PHASES.reduce((sum, phase) => sum + raw[phase], 0) || 1;
  return Object.fromEntries(DAY_PHASES.map((phase) => [phase, raw[phase] / total])) as Record<DayPhase, number>;
}

export function dominantPhase(date: Date): DayPhase {
  const weights = phaseWeights(date);
  return DAY_PHASES.reduce((best, phase) => (weights[phase] > weights[best] ? phase : best), 'day' as DayPhase);
}

/** Window lights are on in the evening and at night. */
export function windowsLit(date: Date): boolean {
  const weights = phaseWeights(date);
  return weights.night + weights.dusk * 0.6 > 0.5;
}

/**
 * The hour (0-23) of `date` in `timeZone` (the household's zone, D-6); the device's hour
 * without a zone or when the zone is not valid.
 */
export function hourIn(date: Date, timeZone?: string | null): number {
  if (!timeZone) return date.getHours();
  try {
    const part = new Intl.DateTimeFormat('en-US', { hour: 'numeric', hourCycle: 'h23', timeZone })
      .formatToParts(date)
      .find((entry) => entry.type === 'hour');
    const hour = Number(part?.value);
    return Number.isInteger(hour) ? hour % 24 : date.getHours();
  } catch {
    return date.getHours();
  }
}

/**
 * The brief's greeting in the household's zone (HP-22c): "Hello" from midnight to 4:00
 * (never "Good evening" in the small hours), "Good morning" to noon, "Good afternoon" to
 * 17:00, then "Good evening".
 */
export function greeting(date: Date, timeZone?: string | null): string {
  const hour = hourIn(date, timeZone);
  if (hour < 4) return 'Hello';
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}

/** HP-22b: the brief's name matches the time of day ("Morning brief" only in the morning). */
export function briefLabel(date: Date, timeZone?: string | null): string {
  const hour = hourIn(date, timeZone);
  if (hour < 4) return "Today's brief";
  if (hour < 12) return 'Morning brief';
  if (hour < 17) return 'Afternoon brief';
  return 'Evening brief';
}

export type Season = 'winter' | 'halloween' | 'holidays' | null;

/**
 * Seasonal accent for the living house: a lit tree in December, a pumpkin in
 * October, snow on the roof in January and February. Northern-hemisphere months.
 */
export function seasonFor(date: Date): Season {
  const month = date.getMonth();
  if (month === 11) return 'holidays';
  if (month === 9) return 'halloween';
  if (month === 0 || month === 1) return 'winter';
  return null;
}

/** Completed chores before the living house's roof turns gold (H29). */
export const GOLDEN_ROOF_CHORES = 100;

/** Easter egg (H29): the roof is gold from the 100th completed chore on. */
export function isGoldenRoof(completedChores: number): boolean {
  return Number.isFinite(completedChores) && completedChores >= GOLDEN_ROOF_CHORES;
}
