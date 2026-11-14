/**
 * Pure helpers for the living pet cards and the pet detail page (H09, D17 and the
 * section 3 Pets items). No Firebase or React imports, so they are unit tested.
 */
import { sharedId } from '../motion';
import { diffDays, localDay } from '../../../functions/src/shared/calendar';
import { householdDayZone } from '../household-day';
import { FOOD_TYPES, type FoodType, type LoggedBy, type PetMedicationLog, type PetProfile, type PortionUnit } from './types';
import { isNonDailySchedule, isValidPortion, parseFeedingsPerDay, parsePortion, PORTION_MAX } from './schedule-parser';

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

/**
 * The photo hint (`dataAiHint`) to save with a pet's type (PE-8a). A new pet, or
 * a changed type, gets the type's own hint; saving with the type unchanged keeps
 * the stored hint, so a legacy "Other" pet drawn as a rabbit stays a rabbit.
 */
export function speciesHintFor(type: string, previous?: { type?: string | null; dataAiHint?: string | null } | null): string {
  const kept = previous?.dataAiHint?.trim();
  if (previous && previous.type === type && kept) return kept;
  return type.toLowerCase();
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

// Free-text schedule reading lives in schedule-parser.ts (PE-6); re-exported for existing callers.
export { isNonDailySchedule, isValidPortion, parseFeedingsPerDay, parsePortion, PORTION_MAX, roundPortion } from './schedule-parser';

/** A stored food type the forms accept, or undefined for legacy/unknown values. */
export function knownFoodType(value: unknown): FoodType | undefined {
  return (FOOD_TYPES as readonly unknown[]).includes(value) ? (value as FoodType) : undefined;
}

/** Whether a pet's feeding history (newest 20) has loaded, failed, or is still loading. */
export type FeedingHistoryState = 'loading' | 'ready' | 'unavailable';

export function feedingHistoryState(feedings: { loading: boolean; error?: unknown }): FeedingHistoryState {
  if (feedings.loading) return 'loading';
  return feedings.error ? 'unavailable' : 'ready';
}

export type QuickFeedFood = {
  /** False while the history loads: nothing may log yet (the food type is not known). */
  ready: boolean;
  foodType: FoodType;
  /** True when the history could not be read and Dry is used without knowing the last food. */
  fallback: boolean;
};

/**
 * The food type a quick feeding (Feed button, hold, `?feed=1` confirm) logs with:
 * the latest feeding's known type, or Dry for a pet with no history. While the
 * history loads nothing is ready, so a fast tap can never log Dry for a pet that
 * eats wet food (and make Dry the next default). When the history is unavailable
 * the feeding may still be logged as Dry, but flagged as a fallback so the UI says
 * so; unavailable history is never treated as empty history.
 */
export function quickFeedFood(history: FeedingHistoryState, latestFoodType: unknown): QuickFeedFood {
  if (history === 'loading') return { ready: false, foodType: 'Dry', fallback: false };
  if (history === 'unavailable') return { ready: true, foodType: 'Dry', fallback: true };
  return { ready: true, foodType: knownFoodType(latestFoodType) ?? 'Dry', fallback: false };
}

export type FeedingPlan = {
  /** Planned feedings per day; null when unknown (no ring target). */
  perDay: number | null;
  amount: number;
  unit: PortionUnit;
  /**
   * The schedule is explicitly not daily ("every other day", "twice a week") and no
   * structured daily count is set: a day without a feeding may be an off-day, so
   * it is never shown as a missed meal (PE-18b).
   */
  nonDaily?: boolean;
};

export const DEFAULT_PORTION = { amount: 1, unit: 'Cups' as PortionUnit };

/** Structured fields win; otherwise parse the free-text schedule; otherwise 1 cup. */
export function feedingPlan(pet: Pick<PetProfile, 'foodSchedule' | 'feedingsPerDay' | 'portionAmount' | 'portionUnit'>): FeedingPlan {
  const parsedPortion = parsePortion(pet.foodSchedule);
  const perDay = isPositiveInteger(pet.feedingsPerDay) ? pet.feedingsPerDay : parseFeedingsPerDay(pet.foodSchedule);
  // A stored portion outside the accepted bounds would make the detailed form's default invalid.
  const amount = isPositive(pet.portionAmount) && isValidPortion(pet.portionAmount) ? pet.portionAmount : parsedPortion?.amount ?? DEFAULT_PORTION.amount;
  const unit = pet.portionUnit ?? parsedPortion?.unit ?? DEFAULT_PORTION.unit;
  const nonDaily = !isPositiveInteger(pet.feedingsPerDay) && isNonDailySchedule(pet.foodSchedule);
  return { perDay, amount, unit, ...(nonDaily ? { nonDaily: true } : {}) };
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

/** Lower-case unit names for pickers and labels ("cups", "cans"; PE-18e). Stored values keep their case. */
export const UNIT_LABELS: Record<PortionUnit, string> = {
  Cups: 'cups',
  Cans: 'cans',
  Scoops: 'scoops',
  Other: 'other',
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

/**
 * The household day (`yyyy-MM-dd`) of an instant (16.1 D-6, PE-7): every "today",
 * "yesterday" and day count in Pets uses the household's time zone
 * (`household.timeZone`, default America/Chicago) through the shared `localDay`
 * that the server reminders and the dashboard use, never the viewer's device zone.
 */
export function petDay(instant: Date, timeZone?: string | null): string {
  return localDay(instant, householdDayZone(timeZone));
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/**
 * Under this age a past time always reads in hours, even across midnight: a
 * feeding at 23:00 reads "1 h ago" at 00:30, never "yesterday" (PE-8h).
 */
const HOURS_ACROSS_MIDNIGHT_MS = 12 * HOUR;

/**
 * "just now", "5 min ago", "2 h ago", "yesterday", "3 days ago", or "on Mar 3".
 * Days are household days (`timeZone`); a time ahead of `now` (another device's
 * clock) reads "just now".
 */
export function formatAgo(date: Date, now: Date, timeZone?: string | null): string {
  const diff = now.getTime() - date.getTime();
  if (diff < MINUTE) return 'just now';
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)} min ago`;
  const days = calendarDaysBetween(date, now, timeZone);
  if (diff < HOURS_ACROSS_MIDNIGHT_MS || days === 0) return `${Math.floor(diff / HOUR)} h ago`;
  if (days <= 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  return `on ${date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: householdDayZone(timeZone) })}`;
}

/** Whole household days from `a` to `b` (positive when `b` is later); a DST day still counts once. */
export function calendarDaysBetween(a: Date, b: Date, timeZone?: string | null): number {
  return diffDays(petDay(b, timeZone), petDay(a, timeZone));
}

/**
 * A stored log date for display, or null when it is blank or unreadable, so a
 * malformed legacy entry shows "Unknown time" instead of crashing its history
 * (PE-8b, PE-8c). Epoch 0 is how an unreadable feeding date is carried for
 * sorting, so it is unknown too.
 */
export function readableLogDate(value: unknown): Date | null {
  const date = toDate(value);
  return date && date.getTime() > 0 ? date : null;
}

/** Parses `yyyy-MM-dd` as a calendar date (a local Date at its midnight, for display; day math uses the string). */
export function parseLocalDate(value?: string | null): Date | null {
  const match = (value ?? '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return date.getMonth() === Number(match[2]) - 1 ? date : null;
}

/* ------------------------------------------------------------------------- */
/* Feeding status                                                             */
/* ------------------------------------------------------------------------- */

export type FeedingEntry = { date: unknown; id?: string; slotId?: unknown } & LoggedBy;

export type FeedingStatus = {
  fedToday: number;
  perDay: number | null;
  /** 0..1 ring fill; 1 when the target is met (or any feeding when no target). */
  progress: number;
  complete: boolean;
  last: { date: Date; by: string | null } | null;
  /** The plan is not daily (PE-18b): a day without a feeding may be an off-day. */
  nonDaily?: boolean;
};

/**
 * Feedings are stamped with server time (PE-5), so on a device whose clock runs
 * slow a feeding from another device looks a little "in the future". Up to this
 * far ahead it counts as just now (and today) instead of being hidden; anything
 * further ahead is treated as a bad date and ignored.
 */
export const FEEDING_CLOCK_SKEW_MS = 12 * HOUR;

/** A feeding's date as this device should read it: clock-skew futures become now; null when unusable. */
export function seenFeedingDate(value: unknown, now: Date): Date | null {
  const date = toDate(value);
  if (!date || date.getTime() > now.getTime() + FEEDING_CLOCK_SKEW_MS) return null;
  return date > now ? now : date;
}

/** Today's feedings (the household day, PE-7a) against the plan, and the latest feeding. */
export function feedingStatus(logs: FeedingEntry[], plan: Pick<FeedingPlan, 'perDay' | 'nonDaily'>, now: Date, timeZone?: string | null): FeedingStatus {
  let fedToday = 0;
  let last: FeedingStatus['last'] = null;
  const today = petDay(now, timeZone);
  for (const log of logs) {
    const date = seenFeedingDate(log.date, now);
    if (!date) continue;
    if (petDay(date, timeZone) === today) fedToday += 1;
    if (!last || date > last.date) last = { date, by: log.loggedByName?.trim() || null };
  }
  const perDay = plan.perDay;
  const progress = perDay ? Math.min(1, fedToday / perDay) : fedToday > 0 ? 1 : 0;
  return { fedToday, perDay, progress, complete: perDay ? fedToday >= perDay : fedToday > 0, last, ...(plan.nonDaily ? { nonDaily: true } : {}) };
}

/** "Fed 2 h ago by Sam" / "No feedings logged yet" (household days for "yesterday"). */
export function feedingHeadline(status: FeedingStatus, now: Date, timeZone?: string | null): string {
  if (!status.last) return 'No feedings logged yet';
  const ago = formatAgo(status.last.date, now, timeZone);
  return `Fed ${ago}${status.last.by ? ` by ${status.last.by}` : ''}`;
}

/**
 * "1 of 2 today" / "2 today" / "Not fed today"; on a non-daily schedule an unfed
 * day reads "No feeding planned daily" (PE-18b: an off-day is not a missed meal).
 */
export function feedingCountLabel(status: FeedingStatus): string {
  if (status.perDay) return `${status.fedToday} of ${status.perDay} today`;
  if (status.fedToday > 0) return `${status.fedToday} today`;
  return status.nonDaily ? 'No feeding planned daily' : 'Not fed today';
}

/* ------------------------------------------------------------------------- */
/* Medication                                                                 */
/* ------------------------------------------------------------------------- */

export type MedicationDue = {
  medication: string;
  dosage: string;
  /** The due day as a local Date, for display only. */
  due: Date;
  /** The due day as stored (`yyyy-MM-dd`, a household calendar day). */
  dueDay: string;
  /** Calendar days until due (negative when overdue). */
  days: number;
  state: 'overdue' | 'due' | 'soon' | 'upcoming';
  label: string;
};

type MedicationCountdownInput = Pick<PetMedicationLog, 'date' | 'medication' | 'dosage' | 'nextDueDate'>;

/**
 * Every current medication countdown, most urgent first (earliest due date, then
 * name). For each medication (case-insensitive name) the most recent entry decides
 * its next due date; a medication whose latest entry has no next due date has no
 * countdown. This is the one countdown rule: the pet card chips, the Medication
 * tab, the calendar's upcoming doses and (mirrored) the server reminders use it.
 */
export function currentMedications(logs: MedicationCountdownInput[], now: Date, timeZone?: string | null): MedicationDue[] {
  return currentMedicationsOn(logs, petDay(now, timeZone));
}

/**
 * `currentMedications` on a given household day (`yyyy-MM-dd`, PE-7b): days until
 * due count household calendar days, as the server reminder does, so the card,
 * the Medication tab and the Calendar agree with it on "Due today" across
 * midnight and daylight-saving changes.
 */
export function currentMedicationsOn(logs: MedicationCountdownInput[], today: string): MedicationDue[] {
  const latest = new Map<string, { at: number; log: MedicationCountdownInput }>();
  for (const log of logs) {
    const key = (log.medication ?? '').trim().toLowerCase();
    if (!key) continue;
    const at = toDate(log.date)?.getTime() ?? 0;
    const current = latest.get(key);
    if (!current || at > current.at) latest.set(key, { at, log });
  }
  const dues: MedicationDue[] = [];
  for (const { log } of latest.values()) {
    const due = parseLocalDate(log.nextDueDate);
    if (!due || !log.nextDueDate) continue;
    const days = diffDays(log.nextDueDate, today);
    dues.push({ medication: log.medication, dosage: log.dosage, due, dueDay: log.nextDueDate, days, ...medicationState(days) });
  }
  return dues.sort((a, b) => a.dueDay.localeCompare(b.dueDay) || a.medication.localeCompare(b.medication));
}

/** The most urgent medication dose (the first of `currentMedications`), or null. */
export function nextMedication(logs: MedicationCountdownInput[], now: Date, timeZone?: string | null): MedicationDue | null {
  return currentMedications(logs, now, timeZone)[0] ?? null;
}

/** Splits chips into the shown ones and the "+N" overflow count. */
export function chipOverflow<T>(items: readonly T[], max: number): { shown: T[]; hidden: number } {
  const limit = Math.max(1, Math.floor(max));
  // Never "+1": when only one would hide, show it instead.
  if (items.length <= limit + 1) return { shown: [...items], hidden: 0 };
  return { shown: items.slice(0, limit), hidden: items.length - limit };
}

/**
 * Start of the history needed to compute `nextMedication` exactly: the oldest
 * among the latest dated entry of each medication. Any entry that supersedes one
 * of those is newer, so loading every entry from here on (plus the dated entries)
 * is enough, however many unrelated doses were logged since. Null when nothing is
 * pending. Dates may be ISO strings or Firestore timestamps (legacy shapes).
 */
export function pendingWindowStart(
  datedLogs: { date: unknown; medication?: string; nextDueDate?: string }[],
): Date | null {
  const latest = new Map<string, Date>();
  for (const log of datedLogs) {
    const key = (log.medication ?? '').trim().toLowerCase();
    const date = toDate(log.date);
    if (!key || !date || !parseLocalDate(log.nextDueDate)) continue;
    const current = latest.get(key);
    if (!current || date > current) latest.set(key, date);
  }
  let start: Date | null = null;
  for (const date of latest.values()) if (!start || date < start) start = date;
  return start;
}

/**
 * Newest-first merge of entries whose `date` may be a Timestamp, Date or string
 * (Firestore orders different types separately, so each shape is queried on its
 * own and merged here). Entries without a readable date go last. Deduplicates by id.
 */
export function newestFirst<T extends { id: string; date: unknown }>(lists: T[][], max: number): T[] {
  const time = (entry: T) => toDate(entry.date)?.getTime() ?? Number.NEGATIVE_INFINITY;
  return mergeById(...lists).sort((a, b) => time(b) - time(a)).slice(0, max);
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

/**
 * Short display name stored on new log entries ("Alex"). Every member who can see
 * the pet reads it, so it is never taken from the email: a name that is an email
 * address is skipped, and someone without a name is "Someone".
 */
export function loggerName(user: { firstName?: string | null; displayName?: string | null }): string {
  const usable = (value: string | null | undefined) => {
    const trimmed = value?.trim() ?? '';
    return trimmed && !/\S+@\S+/.test(trimmed) ? trimmed : '';
  };
  const first = usable(user.firstName);
  if (first) return first.slice(0, 60);
  const display = usable(user.displayName);
  if (display) return display.split(/\s+/)[0].slice(0, 60);
  return 'Someone';
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

/**
 * Inline field errors for the add/edit pet dialogs. `existingNames` excludes the pet
 * being edited. When editing, pass the stored values as `original`: a value the
 * member did not change is never rejected by a rule newer than the document (name
 * or schedule length, feedings per day, portion bounds), so older pets stay
 * editable. (The name cannot be changed while editing.)
 */
export function validatePetForm(values: PetFormValues, existingNames: string[] = [], original?: PetFormValues, options: { hasMealTimes?: boolean } = {}): PetFormErrors {
  const errors: PetFormErrors = {};
  const unchanged = (field: keyof PetFormValues) => original !== undefined && values[field].trim() === original[field].trim();
  const name = values.name.trim();
  if (!unchanged('name')) {
    if (!name) errors.name = 'Give your pet a name.';
    else if (name.length > PET_NAME_MAX) errors.name = `Keep the name under ${PET_NAME_MAX + 1} characters.`;
    else if (existingNames.some((existing) => existing.trim().toLowerCase() === name.toLowerCase())) {
      errors.name = `You already have a pet named ${name}.`;
    }
  }
  const schedule = values.foodSchedule.trim();
  // With meal times (PE-22k) the free text is optional notes.
  if (!schedule && !options.hasMealTimes) errors.foodSchedule = 'Describe the feeding schedule, e.g. "1 cup at 8am and 6pm".';
  else if (schedule.length > FOOD_SCHEDULE_MAX && !unchanged('foodSchedule')) {
    errors.foodSchedule = `Keep the schedule under ${FOOD_SCHEDULE_MAX + 1} characters.`;
  }
  // The legacy count and portion are not used (nor shown) once meal times are set.
  if (options.hasMealTimes) return errors;
  if (values.feedingsPerDay.trim() && !unchanged('feedingsPerDay')) {
    const perDay = Number(values.feedingsPerDay);
    if (!Number.isInteger(perDay) || perDay < 1 || perDay > 12) errors.feedingsPerDay = 'Use a whole number from 1 to 12.';
  }
  if (values.portionAmount.trim() && !unchanged('portionAmount')) {
    const amount = Number(values.portionAmount);
    if (!isValidPortion(amount)) errors.portionAmount = `Use an amount above 0 and up to ${PORTION_MAX}.`;
  }
  return errors;
}

/* ------------------------------------------------------------------------- */
/* Links and shared elements                                                  */
/* ------------------------------------------------------------------------- */

/** The pet's page. */
export function petHref(petId: string): string {
  return `/pets/${encodeURIComponent(petId)}`;
}

/** The pet page's tabs, selectable with `?tab=`. */
export const PET_TABS = ['feeding', 'medication', 'care'] as const;
export type PetTab = (typeof PET_TABS)[number];

/** The tab a `?tab=` value selects (Feeding for a missing or unknown value). */
export function petTabFromParam(value: string | null | undefined): PetTab {
  return (PET_TABS as readonly string[]).includes(value ?? '') ? (value as PetTab) : 'feeding';
}

/** Shared-element name of a pet's photo: the /pets card photo morphs into the pet page hero (H12). */
export function petPhotoMorphName(petId: string): string {
  return sharedId('pet', petId, 'photo');
}

/** `/pets?feed=1`: the "Log feeding" home-screen shortcut opens the feeding picker. */
export const FEED_SHORTCUT_PARAM = 'feed';

export function wantsQuickFeed(params: { get(name: string): string | null } | null | undefined): boolean {
  return params?.get(FEED_SHORTCUT_PARAM) === '1';
}

/**
 * What `/pets?feed=1` does: nothing when not requested; `wait` until both the
 * member's permissions (auth and household membership) and the pet list have
 * loaded, so a late permission never turns into a silent "ignore"; then `open`
 * the picker for members who may log with at least one pet, else `ignore`. The
 * param is removed only after `open` or `ignore`.
 */
export type QuickFeedDecision = 'none' | 'wait' | 'open' | 'ignore';

export function quickFeedDecision(input: {
  requested: boolean;
  permissionsReady: boolean;
  petsReady: boolean;
  canFeed: boolean;
  petCount: number;
}): QuickFeedDecision {
  if (!input.requested) return 'none';
  if (!input.permissionsReady || !input.petsReady) return 'wait';
  return input.canFeed && input.petCount > 0 ? 'open' : 'ignore';
}
