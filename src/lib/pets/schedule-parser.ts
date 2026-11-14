/**
 * Reading a pet's free-text feeding schedule (PE-6): "1.5 cups twice daily",
 * "once in the morning, once at night", "breakfast (morning) and dinner
 * (evening)", "8:00 and 18:00". The result is only ever a suggestion: the meal
 * plan form shows it for correction and nothing is saved until a member confirms
 * it (PE-6f, PE-6g). Ambiguous or unreadable text gives no suggestion at all,
 * and a non-daily schedule ("every other day") is reported as such, never turned
 * into invented daily meals.
 *
 * Pure: no Firebase, React or browser imports. `care.ts` re-exports the legacy
 * helpers (`parseFeedingsPerDay`, `parsePortion`, `isNonDailySchedule`).
 */
import type { PortionUnit } from './types';

/* ------------------------------------------------------------------------- */
/* Numbers and portions                                                       */
/* ------------------------------------------------------------------------- */

const WORD_NUMBERS: Record<string, number> = {
  a: 1, an: 1, one: 1, single: 1, half: 0.5, two: 2, three: 3, four: 4, five: 5, six: 6,
  seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
};

function toNumber(raw: string): number | null {
  const text = raw.trim().toLowerCase();
  if (text in WORD_NUMBERS) return WORD_NUMBERS[text];
  const fraction = text.match(/^(\d+)\s*\/\s*(\d+)$/);
  if (fraction) {
    const value = Number(fraction[1]) / Number(fraction[2]);
    return Number.isFinite(value) && value > 0 ? value : null;
  }
  const mixed = text.match(/^(\d+)\s+(\d+)\s*\/\s*(\d+)$/);
  if (mixed) return Number(mixed[1]) + Number(mixed[2]) / Number(mixed[3]);
  const value = Number(text);
  return Number.isFinite(value) && value > 0 ? value : null;
}

/** Largest portion any form or parser accepts. */
export const PORTION_MAX = 50;

/** Portions are kept to two decimals ("1/3 cup" → 0.33), never rounded to 0. */
export function roundPortion(value: number): number {
  return Math.max(0.01, Math.round(value * 100) / 100);
}

/** True when an amount is accepted by every portion input (feeding form, pet form, parser). */
export function isValidPortion(value: number): boolean {
  return Number.isFinite(value) && value > 0 && value <= PORTION_MAX;
}

const UNIT_WORDS: [PortionUnit, RegExp][] = [
  ['Cups', /^cups?$/],
  ['Cans', /^(cans?|tins?|pouch(?:es)?)$/],
  ['Scoops', /^scoops?$/],
];

// The number must start at a boundary (not inside "1.5" or "x5"), and leading-dot
// decimals (".5 cups") are read whole, so a portion is never misread tenfold.
const PORTION = /(?<![\w.])(\d+\s+\d+\s*\/\s*\d+|\d+\s*\/\s*\d+|\d*\.\d+|\d+(?:\.\d+)?|\ba\b|\ban\b|\bone\b|\bhalf\b|\btwo\b|\bthree\b|\bfour\b)\s*(?:a\s+)?(cups?|cans?|tins?|pouch(?:es)?|scoops?)\b/;

/** Best guess at the usual portion from free text such as "1.5 cups" or "One can". */
export function parsePortion(schedule?: string | null): { amount: number; unit: PortionUnit } | null {
  const match = (schedule ?? '').toLowerCase().match(PORTION);
  if (!match) return null;
  const raw = toNumber(match[1]);
  // Same bounds as every portion input: above 0, at most PORTION_MAX, two decimals.
  const amount = raw ? roundPortion(raw) : 0;
  if (!amount || amount > PORTION_MAX) return null;
  const unit = UNIT_WORDS.find(([, pattern]) => pattern.test(match[2]))?.[0] ?? 'Other';
  return { amount, unit };
}

/* ------------------------------------------------------------------------- */
/* Non-daily schedules                                                        */
/* ------------------------------------------------------------------------- */

/**
 * Explicitly non-daily or irregular schedules ("twice a week", "every other day",
 * "as needed", "free feed", "Mondays"). They get no daily target, so the ring never
 * presents them as a more frequent daily goal than the member entered.
 */
const NON_DAILY: RegExp[] = [
  /\b(?:weekly|fortnightly|biweekly|monthly|bimonthly)\b/,
  /\b(?:a|per|each|every|the|this)\s+(?:week|month|fortnight)\b/,
  /\/\s*(?:week|wk|month)\b/,
  /\bevery\s+(?:other|second|third|alternate|few|couple(?:\s+of)?|\d+|two|three|four|five|six|seven)\s+(?:days?|weeks?|months?)\b/,
  /\b(?:alternate|alternating)\s+days\b/,
  /\b(?:as|when|if)\s+needed\b/,
  /\b(?:prn|on\s+demand|ad\s+lib(?:itum)?)\b/,
  /\bfree[-\s]?(?:feed|feeding|fed|choice)\b/,
  /\b(?:mon|tues?|wednes|thurs?|fri|satur|sun)days\b/,
];

export function isNonDailySchedule(schedule?: string | null): boolean {
  const text = (schedule ?? '').toLowerCase();
  return NON_DAILY.some((pattern) => pattern.test(text));
}

/* ------------------------------------------------------------------------- */
/* Meals of the day                                                           */
/* ------------------------------------------------------------------------- */

/** A part of the day a schedule can name. Synonyms of one part are one meal (PE-6c). */
export type MealGroup = 'morning' | 'midday' | 'afternoon' | 'evening' | 'bedtime';

/** Names and default times of the parts of the day (household-local `HH:mm`). */
export const MEAL_GROUPS: Record<MealGroup, { name: string; time: string; minutes: number }> = {
  morning: { name: 'Breakfast', time: '07:00', minutes: 7 * 60 },
  midday: { name: 'Lunch', time: '12:00', minutes: 12 * 60 },
  afternoon: { name: 'Afternoon', time: '15:00', minutes: 15 * 60 },
  evening: { name: 'Dinner', time: '18:00', minutes: 18 * 60 },
  bedtime: { name: 'Bedtime', time: '21:00', minutes: 21 * 60 },
};

/**
 * Synonym sets, most specific first: a match is removed from the text before the
 * next set is tried, so "late night" is bedtime only, never also "night"
 * (evening). "am" and "pm" count only on their own ("am and pm"); clock times
 * ("8am") are read before the words.
 */
const GROUP_WORDS: [MealGroup, RegExp][] = [
  ['bedtime', /\b(?:bed\s*time|before\s+bed|at\s+bed|late\s+night|midnight\s+snack)\b/g],
  ['morning', /\b(?:mornings?|breakfast|brekkie|sunrise|wake[\s-]?up|a\.?m\.?)(?![\w.])/g],
  ['midday', /\b(?:noon|midday|mid-day|lunch(?:time)?)\b/g],
  ['afternoon', /\b(?:afternoons?|tea\s*time)\b/g],
  ['evening', /\b(?:evenings?|dinner(?:time)?|supper|nights?|tonight|p\.?m\.?)(?![\w.])/g],
];

/** The part of the day a household-local time belongs to (for naming a slot read from a clock time). */
export function groupOfMinutes(minutes: number): MealGroup {
  if (minutes < 10 * 60 + 30) return 'morning';
  if (minutes < 14 * 60) return 'midday';
  if (minutes < 16 * 60 + 30) return 'afternoon';
  if (minutes < 20 * 60 + 30) return 'evening';
  return 'bedtime';
}

/** `HH:mm` of minutes after midnight. */
export function timeOfMinutes(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  return `${String(hours).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

/* ------------------------------------------------------------------------- */
/* Reading one schedule                                                       */
/* ------------------------------------------------------------------------- */

/** Most meals one plan holds (the rules validate up to this many slots). */
export const MEAL_SLOTS_MAX = 6;

/** A suggested meal: a name, a household-local time and its portion. */
export type SuggestedMeal = {
  name: string;
  /** `HH:mm`, household-local. */
  time: string;
  amount: number;
  unit: PortionUnit;
  /** The part of the day it falls in. */
  group: MealGroup;
  /** Where the meal came from: a stated time, a named part of the day, or only a count ("twice daily"). */
  source: 'time' | 'part' | 'count';
};

export type ParsedSchedule =
  /** Readable as daily meals: a suggestion for the member to correct and confirm. */
  | {
      kind: 'plan';
      perDay: number;
      meals: SuggestedMeal[];
      /** Some times are defaults for a named part of the day or a bare count ("twice daily"), not stated times. */
      timesGuessed: boolean;
      /** No portion was stated (one cup is shown), or a meal took the portion of another one. */
      portionGuessed: boolean;
    }
  /** Not a daily schedule ("every other day", "free feed"): no daily meals are suggested. */
  | { kind: 'nonDaily' }
  /**
   * Could not be read as one set of meals (conflicting counts, too many meals, a
   * count of meals the text does not place). `perDay` is the stated count when
   * there is one, for the legacy daily target only; no meal times are suggested.
   */
  | { kind: 'ambiguous'; reason: string; perDay: number | null }
  /** Nothing about meals was found (or the text is empty). */
  | { kind: 'empty' };

type Segment = {
  times: number[];
  groups: MealGroup[];
  portion: { amount: number; unit: PortionUnit } | null;
  /** A stated count in this part ("twice", "2 meals", "every 8 hours"). */
  count: number | null;
  /** The count came from "every N hours" (meals spread evenly). */
  interval: boolean;
  /** An "every N hours" that does not divide the day (every 5 hours). */
  badInterval: boolean;
};

const COUNT_WORDS = /\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s*(?:x|times|meals?|feedings?|feeds?)\b/;
const EVERY_HOURS = /\bevery\s+(\d+|one|two|three|four|six|eight|twelve)\s*(?:hours?|hrs?|h)\b/;
const CLOCK_12 = /(?<![\d:])(\d{1,2})(?::([0-5]\d))?\s*(a\.?m\.?|p\.?m\.?)(?![\w])/g;
const CLOCK_24 = /(?<![\d:])([01]?\d|2[0-3]):([0-5]\d)(?![\d:])/g;

function readSegment(raw: string): Segment {
  let text = raw;
  const times: number[] = [];
  // Clock times first ("8am", "6:30 pm", "18:00"), removed so "am"/"pm" are not read again as words.
  text = text.replace(CLOCK_12, (_match, h: string, m: string | undefined, suffix: string) => {
    const hour = Number(h);
    if (hour < 1 || hour > 12) return ' ';
    const pm = suffix.startsWith('p');
    times.push(((hour % 12) + (pm ? 12 : 0)) * 60 + Number(m ?? 0));
    return ' ';
  });
  text = text.replace(CLOCK_24, (_match, h: string, m: string) => {
    times.push(Number(h) * 60 + Number(m));
    return ' ';
  });
  if (/\bmidnight\b/.test(text) && !/\bmidnight\s+snack\b/.test(text)) times.push(0);
  const groups: MealGroup[] = [];
  for (const [group, pattern] of GROUP_WORDS) {
    let found = false;
    text = text.replace(pattern, () => {
      found = true;
      return ' ';
    });
    if (found && !groups.includes(group)) groups.push(group);
  }
  const portion = parsePortion(raw);
  let count: number | null = null;
  let badInterval = false;
  const every = raw.match(EVERY_HOURS);
  if (every) {
    const hours = toNumber(every[1]) ?? 0;
    if (hours > 0 && hours <= 24 && Number.isInteger(24 / hours)) count = 24 / hours;
    else badInterval = true;
  } else if (/\bonce\b/.test(raw)) count = 1;
  else if (/\btwice\b/.test(raw)) count = 2;
  else if (/\bthrice\b/.test(raw)) count = 3;
  else {
    // "2 meals", "3x", "two times"; not a portion ("2 cups") and not a clock time.
    const stated = text.match(COUNT_WORDS);
    const value = stated ? toNumber(stated[1]) : null;
    if (value && Number.isInteger(value)) count = value;
  }
  return { times, groups, portion, count, interval: Boolean(every) && !badInterval, badInterval };
}

/** Parts of a schedule: "1 cup in the morning, 1/2 cup at night" → two parts. */
function segmentsOf(text: string): string[] {
  return text
    .split(/\s*(?:,|;|\n|&|\+|\.(?=\s|$)|\band\b|\bthen\b|\bplus\b)\s*/)
    .map((part) => part.trim())
    .filter(Boolean);
}

/** A count usable as the legacy daily target (1-12, as `feedingsPerDay`), else null. */
function dailyTarget(count: number | null): number | null {
  return count !== null && Number.isInteger(count) && count >= 1 && count <= 12 ? count : null;
}

/** Default meal times for a bare count ("twice daily": breakfast and dinner). */
function defaultMeals(count: number): { name: string; minutes: number }[] {
  const named = (groups: MealGroup[]) => groups.map((group) => ({ name: MEAL_GROUPS[group].name, minutes: MEAL_GROUPS[group].minutes }));
  switch (count) {
    case 1: return named(['morning']);
    case 2: return named(['morning', 'evening']);
    case 3: return named(['morning', 'midday', 'evening']);
    case 4: return named(['morning', 'midday', 'evening', 'bedtime']);
    default: {
      // Evenly spread from 07:00, as "every N hours" is.
      const step = Math.floor((24 * 60) / count);
      return Array.from({ length: count }, (_unused, index) => ({ name: `Meal ${index + 1}`, minutes: (7 * 60 + index * step) % (24 * 60) }));
    }
  }
}

/** Meals every N hours from 07:00 ("every 8 hours": 7:00, 15:00, 23:00). */
function intervalMeals(count: number): { name: string; minutes: number }[] {
  const step = (24 * 60) / count;
  return Array.from({ length: count }, (_unused, index) => ({ name: `Meal ${index + 1}`, minutes: (7 * 60 + index * step) % (24 * 60) }))
    .sort((a, b) => a.minutes - b.minutes)
    .map((meal, index) => ({ ...meal, name: `Meal ${index + 1}` }));
}

const DEFAULT_PORTION = { amount: 1, unit: 'Cups' as PortionUnit };

/**
 * Reads a free-text schedule (PE-6). A stated time or a named part of the day is
 * one meal; synonyms of one part ("breakfast (morning)") are one meal, never two
 * (PE-6c); each "once ..." with its own part counts once (PE-6a); "2 meals a day"
 * is 2 (PE-6b); "8:00 and 18:00" are 2 meals at those times (PE-6d), 12-hour forms
 * too. A count that disagrees with the meals the text names is ambiguous (no
 * suggestion). Per-meal portions are kept when stated per meal (PE-6e).
 */
export function parseSchedule(schedule?: string | null): ParsedSchedule {
  const text = (schedule ?? '').toLowerCase().trim();
  if (!text) return { kind: 'empty' };
  if (isNonDailySchedule(text)) return { kind: 'nonDaily' };
  const segments = segmentsOf(text).map(readSegment);

  type Meal = { name: string; minutes: number; guessed: boolean; group: MealGroup; portion: Segment['portion']; segment: number };
  const meals: Meal[] = [];
  const counts: number[] = [];
  let conflict: string | null = null;
  let interval: number | null = null;
  /** A count stated inside a part that conflicts with it, kept for the legacy target. */
  let explicit: number | null = null;
  for (const [index, segment] of segments.entries()) {
    if (segment.badInterval) conflict = 'The interval does not divide the day into whole meals.';
    const placed = segment.times.length > 0 ? segment.times.length : segment.groups.length;
    if (segment.times.length > 0) {
      // A part of the day next to a single time names it ("breakfast 7am").
      const label = segment.groups.length === 1 && segment.times.length === 1 ? segment.groups[0] : null;
      for (const minutes of segment.times) {
        const group = label ?? groupOfMinutes(minutes);
        meals.push({ name: MEAL_GROUPS[group].name, minutes, guessed: false, group, portion: segment.portion, segment: index });
      }
    } else {
      for (const group of segment.groups) {
        meals.push({ name: MEAL_GROUPS[group].name, minutes: MEAL_GROUPS[group].minutes, guessed: true, group, portion: segment.portion, segment: index });
      }
    }
    if (segment.count === null) continue;
    if (placed === 0) {
      counts.push(segment.count);
      if (segment.interval) interval = segment.count;
    } else if (segment.count > 1 && segment.count !== placed) {
      // "twice daily at 8am", "three times a day at 8am, noon and 6pm": a daily total
      // stated next to some of its meals. It is the stated count: it must match every
      // meal the text names, and it stays the legacy daily target when they disagree.
      counts.push(segment.count);
    } else if (segment.count !== placed) {
      // "once at 8am and 6pm" in one part: a count of one that names more meals.
      conflict = 'A count and the meals it names disagree.';
      explicit ??= segment.count;
    }
  }

  // A bare "daily" with nothing else is one meal a day (as before), only as a guess.
  if (meals.length === 0 && counts.length === 0 && /\b(?:daily|a day|per day|every day)\b/.test(text)) counts.push(1);
  const stated = counts.length > 0 ? counts[0] : null;
  if (counts.some((count) => count !== stated)) conflict = 'The schedule states different counts.';

  // Two mentions of one time, or of one part of the day without a time, are one meal.
  const unique: Meal[] = [];
  for (const meal of meals) {
    const same = unique.find((other) => other.minutes === meal.minutes || (meal.guessed && other.group === meal.group) || (other.guessed && other.group === meal.group));
    if (!same) unique.push(meal);
    else if (same.guessed && !meal.guessed) Object.assign(same, { minutes: meal.minutes, guessed: false, portion: same.portion ?? meal.portion });
    else if (!same.portion && meal.portion) same.portion = meal.portion;
  }

  // An explicit count always wins over the number of meals named for the legacy target.
  if (conflict) return { kind: 'ambiguous', reason: conflict, perDay: dailyTarget(stated ?? explicit ?? (unique.length || null)) };
  if (unique.length > 0 && stated !== null && stated !== unique.length) {
    return { kind: 'ambiguous', reason: `It says ${stated} a day but names ${unique.length} ${unique.length === 1 ? 'meal' : 'meals'}.`, perDay: dailyTarget(stated) };
  }
  // A stated count is checked before any meals are made from it: "9999999999 meals"
  // must never allocate (the form parses as the member types).
  if (unique.length === 0 && stated !== null && (!Number.isFinite(stated) || stated > MEAL_SLOTS_MAX)) {
    return { kind: 'ambiguous', reason: `More than ${MEAL_SLOTS_MAX} meals a day: set the times yourself.`, perDay: dailyTarget(stated) };
  }

  let planned: { name: string; minutes: number; guessed: boolean; portion: Segment['portion']; source: SuggestedMeal['source'] }[];
  if (unique.length > 0) planned = unique.map((meal) => ({ ...meal, source: meal.guessed ? 'part' : 'time' }));
  else if (stated !== null) {
    planned = (interval !== null ? intervalMeals(stated) : defaultMeals(stated)).map((meal) => ({ ...meal, guessed: true, portion: null, source: 'count' }));
  } else return { kind: 'empty' };

  if (planned.length > MEAL_SLOTS_MAX) {
    return { kind: 'ambiguous', reason: `More than ${MEAL_SLOTS_MAX} meals a day: set the times yourself.`, perDay: dailyTarget(planned.length) };
  }

  // Portions: per meal where stated; a single stated portion applies to every meal.
  const statedPortions = segments.map((segment) => segment.portion).filter((portion): portion is NonNullable<Segment['portion']> => portion !== null);
  const distinct = new Set(statedPortions.map((portion) => `${portion.amount} ${portion.unit}`));
  let portionGuessed = statedPortions.length === 0;
  const fallback = statedPortions[0] ?? DEFAULT_PORTION;
  const sorted = [...planned].sort((a, b) => a.minutes - b.minutes);
  const result: SuggestedMeal[] = sorted.map((meal) => {
    let portion = distinct.size <= 1 ? fallback : meal.portion;
    if (!portion) {
      portion = fallback;
      portionGuessed = true;
    }
    return { name: meal.name, time: timeOfMinutes(meal.minutes), amount: portion.amount, unit: portion.unit, group: groupOfMinutes(meal.minutes), source: meal.source };
  });
  // Two meals named alike (two clock times in the morning): number them so each name is clear.
  const names = new Map<string, number>();
  for (const meal of result) names.set(meal.name, (names.get(meal.name) ?? 0) + 1);
  const seen = new Map<string, number>();
  for (const meal of result) {
    if ((names.get(meal.name) ?? 0) < 2) continue;
    const n = (seen.get(meal.name) ?? 0) + 1;
    seen.set(meal.name, n);
    meal.name = `${meal.name} ${n}`;
  }
  return { kind: 'plan', perDay: result.length, meals: result, timesGuessed: planned.some((meal) => meal.guessed), portionGuessed };
}

/**
 * Best guess at feedings per day from free text (the legacy daily target of a
 * pet without confirmed meal times): the parsed meals, or the stated count of
 * an ambiguous text; null for non-daily, unreadable or empty text.
 */
export function parseFeedingsPerDay(schedule?: string | null): number | null {
  const parsed = parseSchedule(schedule);
  if (parsed.kind === 'plan') return parsed.perDay;
  if (parsed.kind === 'ambiguous') return parsed.perDay;
  return null;
}
