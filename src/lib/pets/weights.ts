/**
 * Pet weight (P5: PE-28b-d, D-P10), pure: entries, units and conversion, draft
 * checks and the trend the pet page shows. The Firestore side is
 * `weight-transaction.ts`; the UI `src/components/pets/weight-card.tsx`.
 *
 * Each entry keeps the value and unit it was logged in
 * (`households/{h}/pets/{p}/weights/{id}`: `value`, `unit`, `date`, author,
 * `loggedAt`). The pet's `weightUnit` (kg or lb, default kg) is the one unit
 * history and trend are shown in; every entry is converted with the same
 * factor (1 lb = 0.45359237 kg, exact by definition) and rounded for display
 * only, so changing the pet's unit never changes a stored value.
 */
import { toDate } from './care';

export const WEIGHT_UNITS = ['kg', 'lb'] as const;
export type WeightUnit = (typeof WEIGHT_UNITS)[number];
export const DEFAULT_WEIGHT_UNIT: WeightUnit = 'kg';
export const WEIGHT_UNIT_LABELS: Record<WeightUnit, string> = { kg: 'kg', lb: 'lb' };

/** Exact by definition (international pound). */
export const KG_PER_LB = 0.45359237;
/** Largest value accepted per unit (rules: the same bounds). */
export const WEIGHT_MAX: Record<WeightUnit, number> = { kg: 500, lb: 1100 };
/** A weighing may be dated at most this far ahead of the server (device clock skew; rules: the same). */
export const WEIGHT_FUTURE_ALLOWANCE_MS = 10 * 60_000;

export type WeightEntry = {
  id: string;
  value: number;
  unit: WeightUnit;
  date: Date | null;
  loggedAt: Date | null;
  loggedByUid: string | null;
  loggedByName: string | null;
};

export const isWeightUnit = (value: unknown): value is WeightUnit =>
  typeof value === 'string' && (WEIGHT_UNITS as readonly string[]).includes(value);

/** The pet's display unit (a missing or unknown value reads as kg). */
export function petWeightUnit(pet: { weightUnit?: unknown } | null | undefined): WeightUnit {
  return isWeightUnit(pet?.weightUnit) ? pet.weightUnit : DEFAULT_WEIGHT_UNIT;
}

/** Reads a weight document; a malformed one has value NaN and is skipped by the lists. */
export function readWeight(id: string, data: Record<string, unknown>): WeightEntry {
  return {
    id,
    value: typeof data.value === 'number' ? data.value : Number.NaN,
    unit: isWeightUnit(data.unit) ? data.unit : DEFAULT_WEIGHT_UNIT,
    date: toDate(data.date),
    loggedAt: toDate(data.loggedAt),
    loggedByUid: typeof data.loggedByUid === 'string' ? data.loggedByUid : null,
    loggedByName: typeof data.loggedByName === 'string' ? data.loggedByName : null,
  };
}

/** Converts a value between units (no rounding). */
export function convertWeight(value: number, from: WeightUnit, to: WeightUnit): number {
  if (from === to) return value;
  return from === 'lb' ? value * KG_PER_LB : value / KG_PER_LB;
}

/** Rounds for display: one decimal, two under 10 (a cat at 4.25 kg). */
export function roundWeight(value: number): number {
  const places = Math.abs(value) < 10 ? 100 : 10;
  return Math.round(value * places) / places;
}

/** "4.2 kg", "12.5 lb" in the given unit. */
export function formatWeight(value: number, unit: WeightUnit): string {
  return `${roundWeight(value).toLocaleString('en-US', { maximumFractionDigits: 2 })} ${WEIGHT_UNIT_LABELS[unit]}`;
}

/** An entry's value in the display unit. */
export function weightIn(entry: Pick<WeightEntry, 'value' | 'unit'>, unit: WeightUnit): number {
  return convertWeight(entry.value, entry.unit, unit);
}

export type WeightDraft = { value: string; unit: WeightUnit; day: string };
export type WeightDraftErrors = { value?: string; day?: string };

/** Checks a weight draft (`today`: the household day). */
export function validateWeightDraft(draft: WeightDraft, today: string): WeightDraftErrors {
  const errors: WeightDraftErrors = {};
  const raw = draft.value.trim();
  const value = Number(raw);
  if (!raw) errors.value = 'Enter the weight.';
  else if (!Number.isFinite(value) || value <= 0 || value > WEIGHT_MAX[draft.unit]) {
    errors.value = `Use a weight above 0 and up to ${WEIGHT_MAX[draft.unit]} ${WEIGHT_UNIT_LABELS[draft.unit]}.`;
  }
  if (draft.day) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(draft.day)) errors.day = 'Pick a date.';
    else if (draft.day > today) errors.day = 'Pick a day that has already started.';
  }
  return errors;
}

/** Valid entries, newest first. */
export function weightHistory(entries: readonly WeightEntry[]): WeightEntry[] {
  return entries
    .filter((entry) => Number.isFinite(entry.value) && entry.value > 0 && entry.date)
    .sort((a, b) => b.date!.getTime() - a.date!.getTime() || (b.loggedAt?.getTime() ?? 0) - (a.loggedAt?.getTime() ?? 0) || a.id.localeCompare(b.id));
}

export type WeightTrend = {
  latest: { value: number; date: Date };
  /** The weighing compared against: the earliest within `windowDays` before the latest, else the one before it. */
  previous: { value: number; date: Date } | null;
  /** latest − previous in the display unit (rounded), null without a previous weighing. */
  change: number | null;
  direction: 'up' | 'down' | 'steady' | null;
  /** Plain words, never colour alone: "Up 0.4 kg since Oct 3", "No change since Oct 3", "First weighing". */
  summary: string;
  /** Oldest first, in the display unit, for the sparkline (at most `points`). */
  series: { value: number; date: Date }[];
};

const shortDate = (date: Date, timeZone?: string | null) =>
  date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...(timeZone ? { timeZone } : {}) });

/**
 * The trend in the pet's unit: the latest weighing against the earliest one in
 * the last `windowDays` (90) before it, or the weighing just before it when
 * none is that recent. A change smaller than the display rounding is "No change".
 */
export function weightTrend(entries: readonly WeightEntry[], unit: WeightUnit, options: { windowDays?: number; points?: number; timeZone?: string | null } = {}): WeightTrend | null {
  const history = weightHistory(entries);
  if (history.length === 0) return null;
  const windowMs = (options.windowDays ?? 90) * 86_400_000;
  const latestEntry = history[0];
  const latest = { value: weightIn(latestEntry, unit), date: latestEntry.date! };
  const older = history.slice(1);
  const inWindow = older.filter((entry) => latest.date.getTime() - entry.date!.getTime() <= windowMs);
  const base = inWindow.length > 0 ? inWindow[inWindow.length - 1] : older[0];
  const series = history.slice(0, options.points ?? 12).reverse().map((entry) => ({ value: weightIn(entry, unit), date: entry.date! }));
  if (!base) return { latest, previous: null, change: null, direction: null, summary: 'First weighing', series };
  const previous = { value: weightIn(base, unit), date: base.date! };
  const change = roundWeight(latest.value - previous.value);
  const direction = change > 0 ? 'up' : change < 0 ? 'down' : 'steady';
  const since = shortDate(previous.date, options.timeZone);
  const summary = direction === 'steady'
    ? `No change since ${since}`
    : `${direction === 'up' ? 'Up' : 'Down'} ${formatWeight(Math.abs(change), unit)} since ${since}`;
  return { latest, previous, change, direction, summary, series };
}

/**
 * Sparkline points (SVG `points`, width × height box) for a series; a flat or
 * single-point series sits in the middle. Decorative: the summary carries the meaning.
 */
export function sparklinePoints(series: readonly { value: number }[], width: number, height: number, pad = 2): string {
  if (series.length === 0) return '';
  const values = series.map((point) => point.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min;
  const step = series.length > 1 ? (width - pad * 2) / (series.length - 1) : 0;
  return values
    .map((value, index) => {
      const x = series.length > 1 ? pad + index * step : width / 2;
      const y = span > 0 ? pad + (1 - (value - min) / span) * (height - pad * 2) : height / 2;
      return `${Math.round(x * 10) / 10},${Math.round(y * 10) / 10}`;
    })
    .join(' ');
}
