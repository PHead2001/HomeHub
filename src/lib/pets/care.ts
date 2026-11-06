/**
 * Pure helpers for the living pet cards and the pet detail page (H09, D17 and the
 * section 3 Pets items). No Firebase or React imports, so they are unit tested.
 */
import type { LoggedBy, PetMedicationLog, PetProfile, PortionUnit } from './types';

/* ------------------------------------------------------------------------- */
/* Species and photos                                                         */
/* ------------------------------------------------------------------------- */

export type SpeciesArt = 'dog' | 'cat' | 'bird' | 'fish' | 'small-mammal' | 'reptile' | 'other';

const SPECIES_WORDS: [SpeciesArt, RegExp][] = [
  ['dog', /\b(dog|puppy|pup|canine)\b/],
  ['cat', /\b(cat|kitten|kitty|feline)\b/],
  ['bird', /\b(bird|parrot|budgie|parakeet|canary|cockatiel|finch|chicken|duck)\b/],
  ['fish', /\b(fish|goldfish|betta|guppy|koi)\b/],
  ['small-mammal', /\b(small mammal|rabbit|bunny|hamster|guinea pig|gerbil|mouse|rat|ferret|chinchilla|hedgehog)\b/],
  ['reptile', /\b(reptile|lizard|gecko|snake|turtle|tortoise|iguana|bearded dragon)\b/],
];

/** Which illustration a pet gets. Uses the type first, then the photo hint. */
export function speciesArt(type?: string | null, hint?: string | null): SpeciesArt {
  for (const source of [type, hint]) {
    const text = (source ?? '').toLowerCase();
    if (!text) continue;
    for (const [art, pattern] of SPECIES_WORDS) {
      if (pattern.test(text)) return art;
    }
  }
  return 'other';
}

export const SPECIES_ART_LABEL: Record<SpeciesArt, string> = {
  dog: 'dog',
  cat: 'cat',
  bird: 'bird',
  fish: 'fish',
  'small-mammal': 'small mammal',
  reptile: 'reptile',
  other: 'pet',
};

/** The legacy "no photo" value is a placehold.co URL; empty also means no photo. */
export function hasRealPhoto(url?: string | null): url is string {
  if (!url || !url.trim()) return false;
  return !/^https?:\/\/placehold\.co\//i.test(url.trim());
}

/**
 * Focal point for `object-position`. Pet portraits usually put the face in the
 * upper-middle of the frame, so a cover crop anchored a little above center keeps
 * heads and ears instead of cutting them off (D17). No face detection.
 */
export const PET_PHOTO_FOCUS = '50% 35%';

/* ------------------------------------------------------------------------- */
/* Feeding plan                                                               */
/* ------------------------------------------------------------------------- */

const WORD_NUMBERS: Record<string, number> = {
  a: 1, an: 1, one: 1, single: 1, half: 0.5, two: 2, three: 3, four: 4, five: 5, six: 6,
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

/** Best guess at feedings per day from free text such as "1.5 cups twice daily". */
export function parseFeedingsPerDay(schedule?: string | null): number | null {
  const text = (schedule ?? '').toLowerCase();
  if (!text.trim()) return null;
  if (/\b(once)\b/.test(text)) return 1;
  if (/\b(twice)\b/.test(text)) return 2;
  if (/\b(thrice)\b/.test(text)) return 3;
  const times = text.match(/\b(\d+|one|two|three|four|five|six)\s*(?:x|times)\b/);
  if (times) {
    const value = toNumber(times[1]);
    if (value && Number.isInteger(value)) return value;
  }
  const clockTimes = text.match(/\b\d{1,2}(?::\d{2})?\s*(?:am|pm)\b/g);
  if (clockTimes && clockTimes.length > 0) return clockTimes.length;
  const meals = ['morning', 'breakfast', 'noon', 'lunch', 'midday', 'afternoon', 'evening', 'dinner', 'night', 'bedtime']
    .filter((word) => new RegExp(`\\b${word}\\b`).test(text));
  if (meals.length > 0) return meals.length;
  if (/\b(daily|a day|per day|every day)\b/.test(text)) return 1;
  return null;
}

const UNIT_WORDS: [PortionUnit, RegExp][] = [
  ['Cups', /^cups?$/],
  ['Cans', /^(cans?|tins?|pouch(?:es)?)$/],
  ['Scoops', /^scoops?$/],
];

/** Best guess at the usual portion from free text such as "1.5 cups" or "One can". */
export function parsePortion(schedule?: string | null): { amount: number; unit: PortionUnit } | null {
  const text = (schedule ?? '').toLowerCase();
  // The number must start at a boundary (not inside "1.5" or "x5"), and leading-dot
  // decimals (".5 cups") are read whole, so a portion is never misread tenfold.
  const match = text.match(/(?<![\w.])(\d+\s+\d+\s*\/\s*\d+|\d+\s*\/\s*\d+|\d*\.\d+|\d+(?:\.\d+)?|\ba\b|\ban\b|\bone\b|\bhalf\b|\btwo\b|\bthree\b|\bfour\b)\s*(?:a\s+)?(cups?|cans?|tins?|pouch(?:es)?|scoops?)\b/);
  if (!match) return null;
  const amount = toNumber(match[1]);
  if (!amount) return null;
  const unit = UNIT_WORDS.find(([, pattern]) => pattern.test(match[2]))?.[0] ?? 'Other';
  return { amount, unit };
}

export type FeedingPlan = {
  /** Planned feedings per day; null when unknown (no ring target). */
  perDay: number | null;
  amount: number;
  unit: PortionUnit;
};

export const DEFAULT_PORTION = { amount: 1, unit: 'Cups' as PortionUnit };

/** Structured fields win; otherwise parse the free-text schedule; otherwise 1 cup. */
export function feedingPlan(pet: Pick<PetProfile, 'foodSchedule' | 'feedingsPerDay' | 'portionAmount' | 'portionUnit'>): FeedingPlan {
  const parsedPortion = parsePortion(pet.foodSchedule);
  const perDay = isPositiveInteger(pet.feedingsPerDay) ? pet.feedingsPerDay : parseFeedingsPerDay(pet.foodSchedule);
  const amount = isPositive(pet.portionAmount) ? pet.portionAmount : parsedPortion?.amount ?? DEFAULT_PORTION.amount;
  const unit = pet.portionUnit ?? parsedPortion?.unit ?? DEFAULT_PORTION.unit;
  return { perDay, amount, unit };
}

function isPositive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function isPositiveInteger(value: unknown): value is number {
  return isPositive(value) && Number.isInteger(value);
}

/* ------------------------------------------------------------------------- */
/* Amount formatting                                                          */
/* ------------------------------------------------------------------------- */

const UNIT_NAMES: Record<PortionUnit, [string, string]> = {
  Cups: ['cup', 'cups'],
  Cans: ['can', 'cans'],
  Scoops: ['scoop', 'scoops'],
  Other: ['portion', 'portions'],
};

export function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Math.round(value * 100) / 100);
}

/** "1 cup", "1.5 cups", "2 cans" (fixes "1 Cups"). */
export function formatPortion(amount: number, unit?: string | null): string {
  const names = UNIT_NAMES[(unit as PortionUnit) ?? 'Cups'] ?? UNIT_NAMES.Other;
  return `${formatNumber(amount)} ${amount === 1 ? names[0] : names[1]}`;
}

/* ------------------------------------------------------------------------- */
/* Dates                                                                      */
/* ------------------------------------------------------------------------- */

/** Firestore Timestamp, Date, ISO string or millis → Date (null when unreadable). */
export function toDate(value: unknown): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === 'string' || typeof value === 'number') {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  if (value && typeof value === 'object' && typeof (value as { toDate?: unknown }).toDate === 'function') {
    return toDate((value as { toDate: () => Date }).toDate());
  }
  return null;
}

export function isSameLocalDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** "just now", "5 min ago", "2 h ago", "yesterday", "3 days ago", or a date. */
export function formatAgo(date: Date, now: Date): string {
  const diff = now.getTime() - date.getTime();
  if (diff < MINUTE) return 'just now';
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)} min ago`;
  if (diff < DAY && isSameLocalDay(date, now)) return `${Math.floor(diff / HOUR)} h ago`;
  const days = calendarDaysBetween(date, now);
  if (days <= 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  return `on ${date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
}

function startOfLocalDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/** Whole calendar days from `a` to `b` (positive when `b` is later). */
export function calendarDaysBetween(a: Date, b: Date): number {
  return Math.round((startOfLocalDay(b) - startOfLocalDay(a)) / DAY);
}

/** Parses `yyyy-MM-dd` as a local calendar date. */
export function parseLocalDate(value?: string | null): Date | null {
  const match = (value ?? '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return date.getMonth() === Number(match[2]) - 1 ? date : null;
}

/* ------------------------------------------------------------------------- */
/* Feeding status                                                             */
/* ------------------------------------------------------------------------- */

export type FeedingEntry = { date: unknown } & LoggedBy;

export type FeedingStatus = {
  fedToday: number;
  perDay: number | null;
  /** 0..1 ring fill; 1 when the target is met (or any feeding when no target). */
  progress: number;
  complete: boolean;
  last: { date: Date; by: string | null } | null;
};

export function feedingStatus(logs: FeedingEntry[], plan: Pick<FeedingPlan, 'perDay'>, now: Date): FeedingStatus {
  let fedToday = 0;
  let last: FeedingStatus['last'] = null;
  for (const log of logs) {
    const date = toDate(log.date);
    if (!date || date.getTime() > now.getTime() + MINUTE) continue;
    if (isSameLocalDay(date, now)) fedToday += 1;
    if (!last || date > last.date) last = { date, by: log.loggedByName?.trim() || null };
  }
  const perDay = plan.perDay;
  const progress = perDay ? Math.min(1, fedToday / perDay) : fedToday > 0 ? 1 : 0;
  return { fedToday, perDay, progress, complete: perDay ? fedToday >= perDay : fedToday > 0, last };
}

/** "Fed 2 h ago by Sam" / "Not fed today" / "No feedings logged yet". */
export function feedingHeadline(status: FeedingStatus, now: Date): string {
  if (!status.last) return 'No feedings logged yet';
  const ago = formatAgo(status.last.date, now);
  return `Fed ${ago}${status.last.by ? ` by ${status.last.by}` : ''}`;
}

/** "1 of 2 today" / "2 today" / "Not fed today". */
export function feedingCountLabel(status: FeedingStatus): string {
  if (status.perDay) return `${status.fedToday} of ${status.perDay} today`;
  return status.fedToday > 0 ? `${status.fedToday} today` : 'Not fed today';
}

/* ------------------------------------------------------------------------- */
/* Medication                                                                 */
/* ------------------------------------------------------------------------- */

export type MedicationDue = {
  medication: string;
  dosage: string;
  due: Date;
  /** Calendar days until due (negative when overdue). */
  days: number;
  state: 'overdue' | 'due' | 'soon' | 'upcoming';
  label: string;
};

/**
 * The next medication dose: for each medication (case-insensitive name), the most
 * recent entry decides its next due date; the earliest of those is returned.
 */
export function nextMedication(
  logs: Pick<PetMedicationLog, 'date' | 'medication' | 'dosage' | 'nextDueDate'>[],
  now: Date,
): MedicationDue | null {
  const latest = new Map<string, { at: number; log: (typeof logs)[number] }>();
  for (const log of logs) {
    const key = (log.medication ?? '').trim().toLowerCase();
    if (!key) continue;
    const at = toDate(log.date)?.getTime() ?? 0;
    const current = latest.get(key);
    if (!current || at > current.at) latest.set(key, { at, log });
  }
  let best: MedicationDue | null = null;
  for (const { log } of latest.values()) {
    const due = parseLocalDate(log.nextDueDate);
    if (!due) continue;
    if (!best || due < best.due) {
      const days = calendarDaysBetween(now, due);
      best = { medication: log.medication, dosage: log.dosage, due, days, ...medicationState(days) };
    }
  }
  return best;
}

/**
 * Start of the history needed to compute `nextMedication` exactly: the oldest
 * among the latest dated entry of each medication. Any entry that supersedes one
 * of those is newer, so loading every entry from here on (plus the dated entries)
 * is enough, however many unrelated doses were logged since. Null when nothing is
 * pending. Medication dates are ISO strings, so they compare as text.
 */
export function pendingWindowStart(
  datedLogs: Pick<PetMedicationLog, 'date' | 'medication' | 'nextDueDate'>[],
): string | null {
  const latest = new Map<string, string>();
  for (const log of datedLogs) {
    const key = (log.medication ?? '').trim().toLowerCase();
    if (!key || typeof log.date !== 'string' || !parseLocalDate(log.nextDueDate)) continue;
    const current = latest.get(key);
    if (!current || log.date > current) latest.set(key, log.date);
  }
  let start: string | null = null;
  for (const date of latest.values()) if (!start || date < start) start = date;
  return start;
}

/** Merges entry lists by id (later lists win), for `nextMedication` over two queries. */
export function mergeById<T extends { id: string }>(...lists: T[][]): T[] {
  const byId = new Map<string, T>();
  for (const list of lists) for (const entry of list) byId.set(entry.id, entry);
  return [...byId.values()];
}

export function medicationState(days: number): Pick<MedicationDue, 'state' | 'label'> {
  if (days < 0) return { state: 'overdue', label: days === -1 ? 'Overdue by 1 day' : `Overdue by ${-days} days` };
  if (days === 0) return { state: 'due', label: 'Due today' };
  if (days === 1) return { state: 'soon', label: 'Due tomorrow' };
  return { state: days <= 3 ? 'soon' : 'upcoming', label: `Due in ${days} days` };
}

/* ------------------------------------------------------------------------- */
/* Who logged                                                                 */
/* ------------------------------------------------------------------------- */

/** Short display name stored on new log entries ("Alex"). */
export function loggerName(user: { firstName?: string | null; displayName?: string | null; email?: string | null }): string {
  const first = user.firstName?.trim();
  if (first) return first.slice(0, 60);
  const display = user.displayName?.trim();
  if (display) return display.split(/\s+/)[0].slice(0, 60);
  return (user.email?.split('@')[0] ?? 'Someone').slice(0, 60);
}

/* ------------------------------------------------------------------------- */
/* Pet form validation                                                        */
/* ------------------------------------------------------------------------- */

export const PET_NAME_MAX = 40;
export const FOOD_SCHEDULE_MAX = 200;

export type PetFormValues = {
  name: string;
  foodSchedule: string;
  feedingsPerDay: string;
  portionAmount: string;
};

export type PetFormErrors = Partial<Record<keyof PetFormValues, string>>;

/** Inline field errors for the add/edit pet dialogs. `existingNames` excludes the pet being edited. */
export function validatePetForm(values: PetFormValues, existingNames: string[] = []): PetFormErrors {
  const errors: PetFormErrors = {};
  const name = values.name.trim();
  if (!name) errors.name = 'Give your pet a name.';
  else if (name.length > PET_NAME_MAX) errors.name = `Keep the name under ${PET_NAME_MAX + 1} characters.`;
  else if (existingNames.some((existing) => existing.trim().toLowerCase() === name.toLowerCase())) {
    errors.name = `You already have a pet named ${name}.`;
  }
  const schedule = values.foodSchedule.trim();
  if (!schedule) errors.foodSchedule = 'Describe the feeding schedule, e.g. "1 cup at 8am and 6pm".';
  else if (schedule.length > FOOD_SCHEDULE_MAX) errors.foodSchedule = `Keep the schedule under ${FOOD_SCHEDULE_MAX + 1} characters.`;
  if (values.feedingsPerDay.trim()) {
    const perDay = Number(values.feedingsPerDay);
    if (!Number.isInteger(perDay) || perDay < 1 || perDay > 12) errors.feedingsPerDay = 'Use a whole number from 1 to 12.';
  }
  if (values.portionAmount.trim()) {
    const amount = Number(values.portionAmount);
    if (!Number.isFinite(amount) || amount <= 0 || amount > 50) errors.portionAmount = 'Use an amount above 0 and up to 50.';
  }
  return errors;
}
