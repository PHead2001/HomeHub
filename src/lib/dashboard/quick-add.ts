/**
 * Natural-language quick-add (H13/H14). A deterministic parser runs first: it
 * recognizes shopping items, pet feedings, chores (with a date, assignee, room and
 * an optional repeat) and maintenance logs (with an odometer reading and the
 * vehicle or asset they belong to). Anything it cannot read confidently returns
 * `null`; the palette then falls back to search and offers the AI reader
 * (`src/ai/tasks/parse-command.ts`), whose output is mapped back to the same
 * intents by `intentFromAiParse` (`src/lib/dashboard/quick-add-ai.ts`).
 */
import { addLocalDays, dayKey, startOfLocalDay } from './dates';
import { knownFoodType, newestFirst, parsePortion } from '../pets/care';
import type { FoodType, PortionUnit, PetProfile } from '../pets/types';
import { parseQuickAdd as parseShoppingEntries, type QuickAddEntry } from '../shopping/items';
import { readMileage } from './quick-add-numbers';

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Matches `value` only as whole words (a letter or digit on either side does not count). */
const wholeToken = (value: string) => new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(value.toLowerCase())}(?![\\p{L}\\p{N}])`, 'u');
const PORTION_UNIT_WORD = /\b(?:cups?|cans?|tins?|pouch(?:es)?|scoops?)\b/i;

/** `email` is a local matching key only ("for sam" by email name) while member records still carry it; never shown. */
export type QuickAddMember = { uid: string; email?: string; name: string };
/** A pet, with its usual portion (Pets' `feedingPlan`) used when the sentence gives no amount. */
export type QuickAddPet = {
  id: string;
  name: string;
  portion?: { amount: number; unit: PortionUnit };
  /** The pet's plan fields, so a quick feed shows the same meal-slot status as the card (PE-22h). */
  profile?: Pick<PetProfile, 'foodSchedule' | 'feedingsPerDay' | 'portionAmount' | 'portionUnit' | 'mealPlan' | 'mealPlanHistory'>;
};
export type QuickAddList = { id: string; name: string; type?: string };
/** A chore room (Chores' `rooms` collection). */
export type QuickAddRoom = { id: string; name: string };
/** A vehicle the household tracks; `currentMileage` is its recorded odometer. */
export type QuickAddVehicle = { id: string; name: string; make?: string; model?: string; currentMileage?: number };
/** A home asset (Maintenance's `home-assets`). */
export type QuickAddAsset = { id: string; name: string };

export type QuickAddContext = {
  now: Date;
  viewer: { uid: string; email: string };
  members: QuickAddMember[];
  pets: QuickAddPet[];
  lists: QuickAddList[];
  rooms?: QuickAddRoom[];
  vehicles?: QuickAddVehicle[];
  assets?: QuickAddAsset[];
};

export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export type QuickAddRepeat =
  | { frequency: 'daily' }
  | { frequency: 'weekly' | 'biweekly'; dayOfWeek: Weekday }
  | { frequency: 'monthly'; dayOfMonth: number };

export type ShoppingIntent = {
  kind: 'shopping';
  items: Array<{ name: string; quantity: number }>;
  list: QuickAddList | null;
  /** True when the sentence clearly asked to add ("add", "buy", "to <list>"). */
  explicit: boolean;
};

export type FeedingIntent = {
  kind: 'feeding';
  pet: QuickAddPet;
  amount: number | null;
  unit: PortionUnit | null;
  /** The food the sentence names ("wet", "dry", "kibble"); null keeps the latest feeding's (QA-4). */
  food?: FoodType | null;
  /** Other pets the same sentence named ("fed Maple and Oreo"): each gets its own feeding (QA-4, QA-25). */
  alsoPets?: QuickAddPet[];
};

export type ChoreIntent = {
  kind: 'chore';
  task: string;
  dueDate: string; // yyyy-MM-dd
  assignee: QuickAddMember | null;
  repeat: QuickAddRepeat | null;
  /** The room the sentence names ("in the kitchen"); null is "Around the house". */
  room?: QuickAddRoom | null;
  /** A name ("Sam") that fits more than one member: the preview asks who it is for. */
  assigneeQuery?: string | null;
  /** Why the repeat differs from what was asked (a monthly day moved to the 28th). */
  repeatNote?: string | null;
};

export type MaintenanceTarget = { kind: 'vehicle'; vehicle: QuickAddVehicle } | { kind: 'asset'; asset: QuickAddAsset };

export type MaintenanceIntent = {
  kind: 'maintenance';
  title: string;
  mileage: number | null;
  /** The vehicle or asset the sentence names; null when it names none. */
  target?: MaintenanceTarget | null;
  /** A name ("Honda") that fits more than one vehicle or asset: the preview asks which. */
  targetQuery?: string | null;
};

export type QuickAddIntent = ShoppingIntent | FeedingIntent | ChoreIntent | MaintenanceIntent;

const WEEKDAYS: Array<[RegExp, Weekday]> = [
  [/^sun(day)?s?$/, 0],
  [/^mon(day)?s?$/, 1],
  [/^tue(s(day)?)?s?$/, 2],
  [/^wed(nesday)?s?$/, 3],
  [/^thu(r(s(day)?)?)?s?$/, 4],
  [/^fri(day)?s?$/, 5],
  [/^sat(urday)?s?$/, 6],
];

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
/**
 * Month words as whole words only (QA-3): "marshmallows 2" or "decorate 2 cakes"
 * never read as Mar 2 or Dec 2.
 */
const MONTH_WORDS = '(january|jan|february|feb|march|mar|april|apr|may|june|jun|july|jul|august|aug|september|sept|sep|october|oct|november|nov|december|dec)';
/** Day words that make a shopping verb a chore: never "n/n" or a bare short weekday. */
const STRONG_DAY = /\b(?:today|tonight|tomorrow|tmrw|day after tomorrow|next week|this weekend|in \d{1,3} (?:days?|weeks?)|sunday|monday|tuesday|wednesday|thursday|friday|saturday|(?:on|by|due|next|this) (?:sun|mon|tue|tues|wed|thu|thur|thurs|fri|sat))\b|\b(?:january|february|march|april|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\.? \d{1,2}(?:st|nd|rd|th)?\b/i;

/** Units after "1/2" that make it a fraction ("1/2 gallon milk"), never a date (QA-3). */
const FRACTION_UNIT = '(?:gal(?:lon)?s?|cups?|lbs?|pounds?|oz|ounces?|kg|g|grams?|l|lit(?:er|re)s?|ml|tsp|tbsp|teaspoons?|tablespoons?|pints?|quarts?|qt|dozen|cans?|bags?|box(?:es)?|packs?|sticks?|loaf|loaves|inch(?:es)?|ft|feet|bottles?|jars?|bunch(?:es)?|heads?|scoops?|pouch(?:es)?)';

export const weekdayFromWord = (word: string): Weekday | null => {
  const lower = word.toLowerCase();
  for (const [pattern, day] of WEEKDAYS) if (pattern.test(lower)) return day;
  return null;
};

const normalize = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const collapse = (value: string) => value.replace(/\s+/g, ' ').trim();

/** Next occurrence of `weekday` on or after today (`strictlyAfter` skips today). */
function nextWeekday(now: Date, weekday: Weekday, strictlyAfter = false): Date {
  const today = startOfLocalDay(now);
  let delta = (weekday - today.getDay() + 7) % 7;
  if (delta === 0 && strictlyAfter) delta = 7;
  return addLocalDays(today, delta);
}

/** Chores repeats monthly on days 1-28 only (every month has them), as its dialog offers. */
export const MONTHLY_MAX_DAY = 28;

/**
 * The repeat as Chores can store it: a monthly day after the 28th becomes the 28th,
 * with a note for the preview, so the schedule the member confirms is exactly the
 * one that is saved.
 */
export function normalizeRepeat(repeat: QuickAddRepeat): { repeat: QuickAddRepeat; note: string | null } {
  if (repeat.frequency !== 'monthly') return { repeat, note: null };
  const day = Math.max(1, Math.floor(repeat.dayOfMonth));
  if (day <= MONTHLY_MAX_DAY) return { repeat: { frequency: 'monthly', dayOfMonth: day }, note: null };
  return {
    repeat: { frequency: 'monthly', dayOfMonth: MONTHLY_MAX_DAY },
    note: `Chores repeat monthly on days 1-${MONTHLY_MAX_DAY}, so this one is set to the ${MONTHLY_MAX_DAY}th instead of the ${day}${day === 31 ? 'st' : 'th'}.`,
  };
}

/**
 * The first day a repeating chore is due: the coming weekday (today included) for
 * weekly and every-other-week repeats, the coming day of the month for monthly
 * ones (today included), otherwise today.
 */
export function firstDateForRepeat(repeat: QuickAddRepeat, now: Date): Date {
  if (repeat.frequency === 'weekly' || repeat.frequency === 'biweekly') return nextWeekday(now, repeat.dayOfWeek);
  const today = startOfLocalDay(now);
  if (repeat.frequency === 'monthly') {
    if (today.getDate() <= repeat.dayOfMonth) {
      const thisMonth = new Date(today.getFullYear(), today.getMonth(), repeat.dayOfMonth);
      if (thisMonth.getMonth() === today.getMonth()) return thisMonth;
    }
    return new Date(today.getFullYear(), today.getMonth() + 1, repeat.dayOfMonth);
  }
  return today;
}

type DateMatch = { date: Date; consumed: RegExp };

/** Finds one date phrase in `text`. Returns the date and a pattern that removes it. */
/**
 * "in" after "1/2" is inches ("1/2 in pipe"), unless it starts a place: an article or
 * possessive ("in the kitchen", "in our garage") or one of the household's rooms ("in
 * kitchen"). Then "8/20 in the kitchen" stays a date.
 */
function inchesAfter(rooms: readonly { name: string }[]): string {
  const places = ['the', 'a', 'an', 'my', 'our', 'his', 'her', 'their', 'your',
    ...rooms.map((room) => room.name.trim().toLowerCase()).filter(Boolean).map((name) => escapeRegExp(name).replace(/\s+/g, '\\s+'))];
  return `in\\b(?!\\s+(?:${places.join('|')})(?![\\p{L}\\p{N}]))`;
}

export function findDate(text: string, now: Date, rooms: readonly { name: string }[] = []): DateMatch | null {
  const lower = text.toLowerCase();
  const simple: Array<[RegExp, () => Date]> = [
    [/\b(today|tonight|this evening)\b/, () => startOfLocalDay(now)],
    [/\btomorrow\b|\btmrw\b/, () => addLocalDays(now, 1)],
    [/\bday after tomorrow\b/, () => addLocalDays(now, 2)],
    [/\bnext week\b/, () => addLocalDays(now, 7)],
    [/\bthis weekend\b|\bweekend\b/, () => nextWeekday(now, 6)],
  ];
  // "day after tomorrow" must win over "tomorrow".
  const ordered = [simple[2], simple[0], simple[1], simple[3], simple[4]];
  for (const [pattern, resolve] of ordered) {
    if (pattern.test(lower)) return { date: resolve(), consumed: new RegExp(`\\b(on |by |due )?(${pattern.source})`, 'i') };
  }

  const inDays = /\bin (\d{1,3}) (day|days|week|weeks)\b/.exec(lower);
  if (inDays) {
    const amount = Number(inDays[1]) * (inDays[2].startsWith('week') ? 7 : 1);
    return { date: addLocalDays(now, amount), consumed: /\bin \d{1,3} (day|days|week|weeks)\b/i };
  }

  // Full weekday names always; a short one ("sun", "wed") only after on/by/due/next/this,
  // so "sun dried tomatoes" or "sat nav" is never a date (QA-3).
  const weekday = /\b(next |this |on |by |due )?(sunday|monday|tues(?:day)?|wednesday|thur(?:s(?:day)?)?|thursday|friday|saturday)\b/.exec(lower)
    ?? /\b(next |this |on |by |due )(sun|mon|tue|wed|thu|fri|sat)\b/.exec(lower);
  if (weekday && !/\bevery\b/.test(lower.slice(Math.max(0, weekday.index - 12), weekday.index + 1))) {
    const day = weekdayFromWord(weekday[2]);
    if (day !== null) {
      // "friday" is the coming Friday (today if it is Friday); "next friday" skips today.
      const date = nextWeekday(now, day, weekday[1]?.trim() === 'next');
      return { date, consumed: new RegExp(`\\b(next |this |on |by |due )?${weekday[2]}\\b`, 'i') };
    }
  }

  // A named month is a date whatever follows ("on March 3 in the kitchen"); only
  // whole month words count, so "marshmallows 2" is no date (QA-3).
  const monthDay = new RegExp(`\\b(on |by |due )?${MONTH_WORDS}\\.? (\\d{1,2})(st|nd|rd|th)?\\b`).exec(lower);
  if (monthDay) {
    const month = MONTHS.indexOf(monthDay[2].slice(0, 3));
    const day = Number(monthDay[3]);
    let date = new Date(now.getFullYear(), month, day);
    if (date.getMonth() !== month) return null;
    if (date < startOfLocalDay(now)) date = new Date(now.getFullYear() + 1, month, day);
    return { date, consumed: new RegExp(monthDay[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') };
  }

  const numeric = new RegExp(`(?<![\\d.]\\s?)\\b(on |by |due )?(\\d{1,2})\\/(\\d{1,2})\\b(?!\\s*${FRACTION_UNIT}\\b)(?!\\s*${inchesAfter(rooms)})(?!\\/)`, 'u').exec(lower);
  if (numeric) {
    const month = Number(numeric[2]) - 1;
    const day = Number(numeric[3]);
    if (month < 0 || month > 11 || day < 1 || day > 31) return null;
    let date = new Date(now.getFullYear(), month, day);
    if (date.getMonth() !== month) return null;
    if (date < startOfLocalDay(now)) date = new Date(now.getFullYear() + 1, month, day);
    return { date, consumed: new RegExp(numeric[0].replace(/[.*+?^${}()|[\]\\/]/g, '\\$&'), 'i') };
  }
  return null;
}

type RepeatMatch = { repeat: QuickAddRepeat; consumed: RegExp; firstDate: Date; /** The monthly day asked for (before moving 29-31 to the 28th). */ askedDay?: number };

const WEEKDAY_WORD = '(sun(?:day)?|mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday)?|thu(?:r(?:s(?:day)?)?)?|fri(?:day)?|sat(?:urday)?)';

export function findRepeat(text: string, now: Date): RepeatMatch | null {
  const lower = text.toLowerCase();
  // Each pattern removes exactly what it matched (QA-4), never the first "every X".
  const exact = (match: RegExpExecArray) => new RegExp(escapeRegExp(match[0]), 'i');
  const daily = /\b(every day|daily|each day)\b/.exec(lower);
  if (daily) return { repeat: { frequency: 'daily' }, consumed: exact(daily), firstDate: startOfLocalDay(now) };
  const weekly = (match: RegExpExecArray, word: string, other: boolean): RepeatMatch | null => {
    const day = weekdayFromWord(word);
    return day === null ? null : { repeat: { frequency: other ? 'biweekly' : 'weekly', dayOfWeek: day }, consumed: exact(match), firstDate: nextWeekday(now, day) };
  };
  // "every week on Saturday", "every other week on Friday", "weekly on Monday".
  const weekOn = new RegExp(`\\b(?:(?:every|each)( other)? week|(bi)?weekly|fortnightly)\\s+on\\s+${WEEKDAY_WORD}s?\\b`).exec(lower);
  if (weekOn) {
    const found = weekly(weekOn, weekOn[3], Boolean(weekOn[1] || weekOn[2] || weekOn[0].startsWith('fortnightly')));
    if (found) return found;
  }
  const everyDay = new RegExp(`\\b(every|each)( other)? ${WEEKDAY_WORD}s?\\b`).exec(lower);
  if (everyDay) {
    const found = weekly(everyDay, everyDay[3], Boolean(everyDay[2]));
    if (found) return found;
  }
  // "every weekend" repeats on Saturdays (QA-4); "this weekend" stays one date.
  const weekend = /\b(?:every|each) weekend\b|\b(?:on )?weekends\b/.exec(lower);
  if (weekend) return { repeat: { frequency: 'weekly', dayOfWeek: 6 }, consumed: exact(weekend), firstDate: nextWeekday(now, 6) };
  // Plural weekdays repeat: "on Tuesdays", "trash mondays" (QA-4).
  const plural = /\b(?:on )?(sundays|mondays|tuesdays|wednesdays|thursdays|fridays|saturdays)\b/.exec(lower);
  if (plural) {
    const found = weekly(plural, plural[1], false);
    if (found) return found;
  }
  const week = /\b(every week|weekly|each week)\b/.exec(lower);
  if (week) return { repeat: { frequency: 'weekly', dayOfWeek: now.getDay() as Weekday }, consumed: exact(week), firstDate: startOfLocalDay(now) };
  const otherWeek = /\b(every other week|biweekly|fortnightly)\b/.exec(lower);
  if (otherWeek) return { repeat: { frequency: 'biweekly', dayOfWeek: now.getDay() as Weekday }, consumed: exact(otherWeek), firstDate: startOfLocalDay(now) };
  // "every month on the 15th", "monthly on the 1st", "on the 15th of every month" (QA-4).
  const monthOn = /\b(?:(?:every|each) month|monthly)\s+on\s+(?:the\s+)?(\d{1,2})(?:st|nd|rd|th)?\b/.exec(lower)
    ?? /\b(?:on\s+)?the\s+(\d{1,2})(?:st|nd|rd|th)?\s+of\s+(?:every|each)\s+month\b/.exec(lower);
  if (monthOn) {
    const asked = Number(monthOn[1]);
    if (asked >= 1 && asked <= 31) {
      const repeat = normalizeRepeat({ frequency: 'monthly', dayOfMonth: asked }).repeat;
      return { repeat, consumed: exact(monthOn), firstDate: firstDateForRepeat(repeat, now), askedDay: asked };
    }
  }
  const month = /\b(every month|monthly|each month)\b/.exec(lower);
  if (month) {
    const repeat = normalizeRepeat({ frequency: 'monthly', dayOfMonth: now.getDate() }).repeat;
    return { repeat, consumed: exact(month), firstDate: firstDateForRepeat(repeat, now), askedDay: now.getDate() };
  }
  return null;
}

/**
 * Matches "for Sam", "for me", "@sam" to a household member: by first name, full
 * name or email name, case-insensitively. The phrase is always removed from the
 * task once it names a member. When the name fits more than one member, `member`
 * is null and `ambiguous` holds the name, so the preview asks who it is for.
 */
export function findAssignee(text: string, context: QuickAddContext): { member: QuickAddMember | null; consumed: RegExp; ambiguous?: string } | null {
  for (const mention of text.matchAll(/(?:^|\s)(?:for\s+|to\s+|@)@?(\p{L}[\p{L}.'-]*)(?![\p{L}\p{N}])/giu)) {
    // Accented names are matched with or without their accents (QA-4).
    const word = foldAccents(mention[1]).replace(/[.'-]+$/, '');
    const consumed = new RegExp(mention[0].trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    if (word === 'me' || word === 'myself') {
      const self = context.members.find((member) => member.uid === context.viewer.uid);
      if (self) return { member: self, consumed };
      continue;
    }
    const matches = context.members.filter((candidate) => {
      const first = foldAccents(candidate.name.trim().split(/\s+/)[0] ?? '');
      const local = candidate.email?.split('@')[0]?.toLowerCase();
      return first === word || foldAccents(candidate.name) === word || local === word || local?.split(/[._-]/)[0] === word;
    });
    if (matches.length === 1) return { member: matches[0], consumed };
    if (matches.length > 1) return { member: null, consumed, ambiguous: mention[1].replace(/[.'-]+$/, '') };
  }
  return null;
}

/** A whole-word pattern for a multi-word name (any run of spaces between words). */
const namePattern = (name: string) => escapeRegExp(name.trim().toLowerCase()).replace(/\s+/g, '\\s+');
const WORD_BEFORE = '(?<![\\p{L}\\p{N}])';
const WORD_AFTER = '(?![\\p{L}\\p{N}])';

/**
 * The room a chore sentence names, as whole words ("kitchen", "Living Room").
 * "in the kitchen" / "for the kitchen" is removed from the task; a bare room word
 * stays in it ("clean kitchen" keeps its words). Longest names win.
 */
export function findRoom(text: string, rooms: readonly QuickAddRoom[]): { room: QuickAddRoom; consumed: RegExp | null } | null {
  const sorted = rooms.filter((room) => room.name.trim()).sort((a, b) => b.name.length - a.name.length);
  for (const room of sorted) {
    const name = namePattern(room.name);
    const phrase = new RegExp(`${WORD_BEFORE}(?:in|for)\\s+(?:the\\s+)?${name}${WORD_AFTER}`, 'iu');
    if (phrase.test(text)) return { room, consumed: phrase };
    if (new RegExp(`${WORD_BEFORE}${name}${WORD_AFTER}`, 'iu').test(text)) return { room, consumed: null };
  }
  return null;
}

/** Words that name a vehicle: its nickname, "make model", model and make. */
const vehicleNames = (vehicle: QuickAddVehicle) => [vehicle.name, vehicle.make && vehicle.model ? `${vehicle.make} ${vehicle.model}` : '', vehicle.model ?? '', vehicle.make ?? '']
  .map((name) => name.trim())
  .filter((name) => name.length >= 2);

const targetKey = (target: MaintenanceTarget) => (target.kind === 'vehicle' ? `vehicle:${target.vehicle.id}` : `asset:${target.asset.id}`);

/**
 * The vehicle or asset a maintenance sentence names (whole words, longest first).
 * "for the Civic" / "on my Civic" is removed from the title; a bare name stays.
 * When the matched name belongs to more than one record (two Hondas, two
 * "Furnace" assets), `target` is null and `ambiguous` holds the name, so the
 * preview asks which one instead of picking the first.
 */
export function findMaintenanceTarget(
  text: string,
  vehicles: readonly QuickAddVehicle[],
  assets: readonly QuickAddAsset[],
): { target: MaintenanceTarget | null; consumed: RegExp | null; ambiguous?: string } | null {
  const candidates: Array<{ name: string; target: MaintenanceTarget }> = [
    ...vehicles.flatMap((vehicle) => vehicleNames(vehicle).map((name) => ({ name, target: { kind: 'vehicle' as const, vehicle } }))),
    ...assets.filter((asset) => asset.name.trim().length >= 2).map((asset) => ({ name: asset.name.trim(), target: { kind: 'asset' as const, asset } })),
  ].sort((a, b) => b.name.length - a.name.length);
  // Every distinct record that answers to `name` (case-insensitive).
  const resolve = (name: string, consumed: RegExp | null) => {
    const matches = new Map<string, MaintenanceTarget>();
    for (const other of candidates) {
      if (other.name.toLowerCase() === name.toLowerCase()) matches.set(targetKey(other.target), other.target);
    }
    const distinct = [...matches.values()];
    return distinct.length === 1 ? { target: distinct[0], consumed } : { target: null, consumed, ambiguous: name };
  };
  for (const candidate of candidates) {
    const name = namePattern(candidate.name);
    const phrase = new RegExp(`${WORD_BEFORE}(?:for|on|in)\\s+(?:the\\s+|my\\s+|our\\s+)?${name}${WORD_AFTER}`, 'iu');
    if (phrase.test(text)) return resolve(candidate.name, phrase);
    if (new RegExp(`${WORD_BEFORE}${name}${WORD_AFTER}`, 'iu').test(text)) return resolve(candidate.name, null);
  }
  return null;
}

const LIST_TYPE_WORDS: Array<[RegExp, string]> = [
  [/^(grocery|groceries|grocery list|food|supermarket)$/, 'Grocery'],
  [/^(hardware|hardware store|tools)$/, 'Hardware'],
  [/^(auto|car|car parts)$/, 'Auto'],
  [/^(pet|pets|pet store|pet supplies)$/, 'Pets'],
];

export function findList(phrase: string, lists: QuickAddList[]): QuickAddList | null {
  const target = normalize(phrase.replace(/\b(the|my|our|list)\b/gi, ''));
  if (!target) return null;
  // Whole tokens only: "groceries" finds "Weekly Groceries"; "hard" finds nothing.
  const targetTokens = target.split(' ');
  const byName = lists.find((list) => normalize(list.name) === target)
    ?? lists.find((list) => {
      const tokens = normalize(list.name).split(' ');
      return targetTokens.every((token) => tokens.includes(token));
    });
  if (byName) return byName;
  for (const [pattern, type] of LIST_TYPE_WORDS) {
    if (pattern.test(target)) return lists.find((list) => list.type === type) ?? null;
  }
  return null;
}

const defaultList = (lists: QuickAddList[]) => lists.find((list) => list.type === 'Grocery') ?? lists[0] ?? null;

/**
 * Splits "2 milk, eggs and bread x3" into items. The whole words "and", "&" and "+"
 * also separate items; the result then goes through the Shopping module's own
 * quick-add parser, so counts, name casing ("milk" becomes "Milk") and repeated
 * names match the Shopping list's inline quick add exactly.
 */
export function splitItems(text: string): Array<{ name: string; quantity: number }> {
  // Known compound names keep their "and" (QA-3): "mac and cheese", "half and half".
  let protectedText = text;
  for (const compound of COMPOUND_ITEMS) {
    protectedText = protectedText.replace(new RegExp(`(?<![\\p{L}])${compound.replace(/ and /g, '\\s+(?:and|&)\\s+')}(?![\\p{L}])`, 'giu'), (match) => match.replace(/\s+(?:and|&)\s+/gi, AND_MARK));
  }
  const parts = protectedText.split(/[,;\n]+/);
  const withCommas = parts.length > 1;
  const split = parts.flatMap((part) => {
    const pieces = part.split(/\s+(?:and|&|\+)\s+/i);
    if (pieces.length === 1) return [part];
    // Without commas, "and" splits only single words ("milk and eggs"); "dry cleaning
    // and milk" stays one entry the preview can split (QA-19).
    return withCommas || pieces.every((piece) => itemWords(piece) <= 1) ? pieces : [part];
  });
  return parseShoppingEntries(split.join(',')).map((entry) => ({ ...entry, name: entry.name.split(AND_MARK).join(' and ') }));
}

const AND_MARK = '~and~';
/** Names that contain "and" and are one item. */
export const COMPOUND_ITEMS = [
  'mac and cheese', 'macaroni and cheese', 'half and half', 'salt and pepper', 'peanut butter and jelly', 'pb and j', 'fish and chips',
  'bread and butter', 'cookies and cream', 'sour cream and onion', 'ham and cheese', 'pork and beans', 'rice and beans', 'oil and vinegar',
  'spaghetti and meatballs', 'chicken and rice', 'biscuits and gravy', 'strawberries and cream', 'franks and beans', 'cheese and onion',
];
/** Words in one entry, without a leading count ("2 milk") or a trailing "x2". */
const itemWords = (piece: string) => piece.trim().replace(/^\d{1,3}\s*(?:[x×]\s+)?/i, '').replace(/\s+[x×]\s*\d{1,3}$/i, '').split(/\s+/).filter(Boolean).length;

/**
 * Words that make bare text a sentence rather than a thing to buy: pronouns and
 * verbs ("gave Rex his pill", "need to call the dentist", "replaced furnace
 * filter"). Bare text with one of these, or with more than four words in an entry,
 * is never guessed as groceries (QA-2): the palette offers "Read with AI" first.
 */
const NOT_AN_ITEM = /(?<![\p{L}'])(?:i|i'm|im|we|we're|you|he|she|they|it|it's|his|her|hers|their|our|my|me|us|him|them|your|gave|give|given|call|called|take|took|taken|replaced|replace|fix|fixed|fixing|clean|cleaned|ate|did|do|does|done|was|were|is|are|be|been|have|has|had|will|would|should|could|remind|nothing|went|go|going|walked|fed|feed|pay|paid|book|booked|schedule|scheduled|made|checked|tell|ask|text|email|today|yesterday|tonight|tomorrow)(?![\p{L}'])/iu;

/** True when bare text reads like things to buy: short noun phrases only (QA-2). */
export function looksLikeItems(text: string, items: ReadonlyArray<{ name: string }>): boolean {
  if (items.length === 0 || NOT_AN_ITEM.test(text)) return false;
  return items.every((item) => itemWords(item.name) <= 4);
}

const capitalize = (value: string) => value.charAt(0).toUpperCase() + value.slice(1);

function parseFeeding(text: string, context: QuickAddContext): FeedingIntent | null {
  const match = /^(?:i\s+)?(?:fed|feed|fed up|feeding)\s+(.+)$/i.exec(text) ?? /^(.+?)\s+(?:ate|was fed|has eaten|got fed)\b(.*)$/i.exec(text);
  if (!match) return null;
  const rest = match[1].toLowerCase();
  const pets = namedPets(rest, context.pets);
  if (pets.length === 0) return null;
  const [pet, ...alsoPets] = pets;
  // The Pets module's portion parser reads amounts whole (".5 cups", "1/2 cup",
  // "1 1/2 cups", "one can"), never the digits at the end of a decimal or fraction.
  const portion = parsePortion(text);
  // A unit with an amount the parser cannot read is rejected (falls back to search), never guessed.
  if (!portion && PORTION_UNIT_WORD.test(text)) return null;
  return {
    kind: 'feeding',
    pet,
    amount: portion?.amount ?? null,
    unit: portion?.unit ?? null,
    ...(foodFromText(rest) ? { food: foodFromText(rest) } : {}),
    ...(alsoPets.length > 0 ? { alsoPets } : {}),
  };
}

/** The food a feeding sentence names, or null (QA-4). */
export function foodFromText(text: string): FoodType | null {
  const lower = text.toLowerCase();
  if (/\b(?:mix|mixed)\b|\bwet and dry\b|\bdry and wet\b/.test(lower)) return 'Mix';
  if (/\b(?:wet|canned|can food)\b/.test(lower)) return 'Wet';
  if (/\b(?:dry|kibble|biscuits?)\b/.test(lower)) return 'Dry';
  return null;
}

/**
 * Every pet a feeding sentence names, in the order they appear (QA-4): full names
 * first (longest wins), then a single word of a pet's name ("Rex" for "Audit Rex")
 * when that word belongs to exactly one pet. Names are compared without accents.
 */
export function namedPets(text: string, pets: readonly QuickAddPet[]): QuickAddPet[] {
  const folded = foldAccents(text);
  const found = new Map<string, { pet: QuickAddPet; at: number }>();
  let rest = folded;
  for (const pet of [...pets].sort((a, b) => b.name.length - a.name.length)) {
    const match = wholeToken(foldAccents(pet.name)).exec(rest);
    if (!match) continue;
    found.set(pet.id, { pet, at: match.index });
    rest = rest.slice(0, match.index) + ' '.repeat(match[0].length) + rest.slice(match.index + match[0].length);
  }
  const words = rest.split(/[^\p{L}\p{N}]+/u).filter((word) => word.length >= 2);
  for (const word of words) {
    const owners = pets.filter((pet) => !found.has(pet.id) && foldAccents(pet.name).split(/[^\p{L}\p{N}]+/u).includes(word));
    if (owners.length === 1) found.set(owners[0].id, { pet: owners[0], at: rest.indexOf(word) });
  }
  return [...found.values()].sort((a, b) => a.at - b.at).map((entry) => entry.pet);
}

/** Lower case without accents, so "José" and "jose" match (QA-4). */
export const foldAccents = (value: string) => value.normalize('NFD').replace(/\p{M}+/gu, '').toLowerCase();

const MAINTENANCE_WORDS = /\b(oil change|tire rotation|tyre rotation|brakes?|filters?|inspections?|service[sd]?|tune[- ]?up|alignment|repair(?:ed|s)?|replaced?|maintenance|miles|mi|odometer)\b/i;

function parseMaintenance(text: string, context: QuickAddContext): MaintenanceIntent | null {
  const explicit = /^(?:log|logged|did|done)\s+(.+)$/i.exec(text);
  let body = explicit ? explicit[1] : text;
  if (!MAINTENANCE_WORDS.test(body)) return null;
  // "120k miles" is 120,000 and "48k" after a service word is a reading (QA-3).
  const mileageMatch = readMileage(body, { bareK: true });
  const mileage = mileageMatch?.value ?? null;
  if (!explicit && mileage === null && !/\b(oil change|tire rotation|tyre rotation|tune[- ]?up|alignment)\b/i.test(body)) return null;
  // A log records work that was done: "oil change tomorrow" is a chore to do, never
  // a log saved as done today (QA-3). A date of today is dropped from the title.
  const when = findDate(body, context.now, context.rooms ?? []);
  if (when && when.date.getTime() > startOfLocalDay(context.now).getTime()) return null;
  if (when) body = body.replace(when.consumed, ' ');
  if (mileageMatch) body = body.replace(mileageMatch.text, ' ');
  // A mileage reading belongs to a vehicle, so only vehicles are matched then.
  const found = findMaintenanceTarget(body, context.vehicles ?? [], mileage !== null ? [] : context.assets ?? []);
  if (found?.consumed) body = body.replace(found.consumed, ' ');
  const title = collapse(body).replace(/\s+\b(?:at|on|for)$/i, '');
  if (!title) return null;
  return {
    kind: 'maintenance',
    title: capitalize(title).slice(0, 100),
    mileage: mileage !== null && mileage > 0 && mileage < 2_000_000 ? mileage : null,
    target: found?.target ?? null,
    targetQuery: found?.ambiguous ?? null,
  };
}

function parseShopping(text: string, context: QuickAddContext): ShoppingIntent | null {
  return readShopping(text, context)?.intent ?? null;
}

/** Shopping, plus whether the sentence named a list ("to the hardware list"). */
function readShopping(text: string, context: QuickAddContext): { intent: ShoppingIntent; listNamed: boolean } | null {
  const verb = /^(?:please\s+)?(?:add|buy|get|grab|pick up|need|we need|i need|we're out of|out of)\s+(.+)$/i.exec(text);
  let body = verb ? verb[1] : text;
  let list: QuickAddList | null = null;
  let explicitList = false;
  const target = /\s+(?:to|on|onto|for)\s+(?:the\s+|my\s+|our\s+)?([a-z0-9' -]+?)(?:\s+list)?\s*$/i.exec(body);
  if (target) {
    // "to the list", "on my shopping list": the default list, and the words never
    // stay in the item's name (QA-3).
    const generic = /^(?:the\s+|my\s+|our\s+)?(?:shopping\s+)?list$|^shopping$/i.test(target[1].trim());
    const found = generic ? defaultList(context.lists) : findList(target[1], context.lists);
    if (found) {
      list = found;
      explicitList = true;
      body = body.slice(0, target.index);
    }
  }
  const items = splitItems(body);
  if (items.length === 0) return null;
  return { intent: { kind: 'shopping', items, list: list ?? defaultList(context.lists), explicit: Boolean(verb) || explicitList }, listNamed: explicitList };
}

/** What a command verb asks for: a feeding, a shopping item or a chore. */
export type CommandVerbKind = 'feeding' | 'item' | 'chore';
const BARE_VERBS: Array<[RegExp, CommandVerbKind]> = [
  [/^(?:i\s+)?(?:fed|feed|fed up|feeding)$/i, 'feeding'],
  [/^(?:please\s+)?(?:add|buy|get|grab|pick up|need|we need|i need|we're out of|out of)$/i, 'item'],
  [/^(?:chore|task|todo|to do|remind (?:me|us)(?: to)?)$/i, 'chore'],
];
/**
 * The command verbs on their own, with nothing to act on ("fed", "feed", "add",
 * "buy", "chore"), after trimming, collapsing spaces and dropping end punctuation.
 * Returns the kind of entry the verb asks for, or null when the text says more
 * than a verb. A bare verb is never an entry itself (QA-1): "Add" or "Fed" is not
 * a grocery item.
 */
export function bareCommandVerb(input: string): CommandVerbKind | null {
  const text = collapse(input).replace(/[.!?:]+$/, '').trim();
  for (const [pattern, kind] of BARE_VERBS) if (pattern.test(text)) return kind;
  return null;
}

/** A chore sentence ("vacuum Friday for Sam"; "chore …" also works). Exported for the palette's Chore mode. */
export function parseChore(text: string, context: QuickAddContext): ChoreIntent | null {
  // "remind Sam to take out the trash Tuesday": a chore for Sam (QA-25).
  const remindSomeone = /^remind\s+(\p{L}[\p{L}.'-]*)\s+to\s+(.+)$/iu.exec(text);
  if (remindSomeone && !/^(?:me|us)$/i.test(remindSomeone[1])) {
    const named = findAssignee(`for ${remindSomeone[1]}`, context);
    if (named) return parseChore(`chore ${remindSomeone[2]} for ${remindSomeone[1]}`, context);
  }
  const explicit = /^(?:chore|task|todo|to do|remind (?:me|us) to)[:\s]+(.+)$/i.exec(text);
  let body = explicit ? explicit[1] : text;
  const repeat = findRepeat(body, context.now);
  if (repeat) body = body.replace(repeat.consumed, ' ');
  const date = repeat ? null : findDate(body, context.now, context.rooms ?? []);
  if (date) body = body.replace(date.consumed, ' ');
  const assignee = findAssignee(body, context);
  if (assignee) body = body.replace(assignee.consumed, ' ');
  const room = findRoom(body, context.rooms ?? []);
  if (room?.consumed) body = body.replace(room.consumed, ' ');
  // Without an explicit "chore:" prefix we need at least one chore signal.
  if (!explicit && !repeat && !date && !assignee) return null;
  const task = collapse(body.replace(/\b(on|by|due|at)\s*$/i, '').replace(/^\s*(to)\s+/i, ''));
  if (!task || task.length > 100) return null;
  const due = repeat?.firstDate ?? date?.date ?? startOfLocalDay(context.now);
  return {
    kind: 'chore',
    task: capitalize(task),
    dueDate: dayKey(due),
    assignee: assignee?.member ?? null,
    assigneeQuery: assignee?.ambiguous ?? null,
    repeat: repeat?.repeat ?? null,
    repeatNote: repeat?.repeat.frequency === 'monthly' && (repeat.askedDay ?? 0) > MONTHLY_MAX_DAY
      ? normalizeRepeat({ frequency: 'monthly', dayOfMonth: repeat.askedDay ?? MONTHLY_MAX_DAY }).note
      : null,
    room: room?.room ?? null,
  };
}

/**
 * Parses one sentence. Order matters: feedings name a known pet, maintenance needs
 * a service word, explicit shopping verbs beat chores, and chores need a date,
 * repeat, assignee or "chore:" prefix. Bare text ("milk and eggs") becomes an
 * implicit shopping intent the palette offers only when search finds nothing.
 */
export function parseQuickAdd(input: string, context: QuickAddContext): QuickAddIntent | null {
  const text = collapse(input).replace(/[.!?]+$/, '');
  if (text.length < 2 || text.length > 200) return null;
  // A verb alone ("fed", "add ") names nothing to add: never a grocery item (QA-1).
  if (bareCommandVerb(text)) return null;

  const feeding = parseFeeding(text, context);
  if (feeding) return feeding;
  // "fed …" that names no known pet, or an amount that cannot be read, is never
  // reinterpreted as something else: it falls back to search.
  if (/^(?:i\s+)?(?:fed|feed|feeding)\s/i.test(text)) return null;

  if (/^(?:chore|task|todo|to do|remind (?:me|us) to)\b/i.test(text)) return parseChore(text, context);

  if (/^(?:please\s+)?(?:add|buy|get|grab|pick up|need|we need|i need|we're out of|out of)\s/i.test(text)) {
    // "need to call the dentist" is something to do, never an item (QA-3): a chore
    // when it has a date, repeat or person, otherwise nothing (the AI reader is offered).
    if (/^(?:please\s+)?(?:i\s+|we\s+)?need\s+to\s/i.test(text)) return parseChore(text.replace(/^(?:please\s+)?(?:i\s+|we\s+)?need\s+to\s+/i, ''), context);
    const shopping = readShopping(text, context);
    // A date, repeat or person makes it a chore ("pick up dry cleaning for Sam
    // tomorrow"), unless the sentence named a shopping list (QA-3).
    if (!shopping?.listNamed) {
      const chore = parseChore(text, context);
      // Only a person, a repeat or a plain day word flips it ("pick up dry cleaning for
      // Sam tomorrow"); "add 3/8 bolts" stays an item (QA-3).
      if (chore && (chore.assignee || chore.assigneeQuery || chore.repeat || STRONG_DAY.test(text))) return chore;
    }
    return shopping?.intent ?? null;
  }

  const maintenance = parseMaintenance(text, context);
  if (maintenance) return maintenance;

  const chore = parseChore(text, context);
  if (chore) return chore;

  const shopping = parseShopping(text, context);
  if (!shopping || !shopping.list) return null;
  // A sentence that named its list ("milk to my groceries") is explicit and kept as is.
  if (shopping.explicit) return shopping;
  // Bare text is a grocery guess only when it reads like things to buy, and never
  // when it names a room or a member (QA-2).
  if (!looksLikeItems(text, shopping.items)) return null;
  const lower = normalize(text);
  if ((context.rooms ?? []).some((room) => normalize(room.name) === lower)) return null;
  if (context.members.some((member) => normalize(member.name) === lower || normalize(member.name.split(/\s+/)[0] ?? '') === lower)) return null;
  // Nor a pet (or one word of its name: "rex" for "Audit Rex"), a vehicle or an asset.
  if (namedPets(text, context.pets).length > 0 && context.pets.some((pet) => normalize(pet.name) === lower || normalize(pet.name).split(' ').includes(lower))) return null;
  if ([...(context.vehicles ?? []).map((vehicle) => vehicle.name), ...(context.assets ?? []).map((asset) => asset.name)].some((name) => normalize(name) === lower)) return null;
  return shopping;
}

export function describeRepeat(repeat: QuickAddRepeat): string {
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  switch (repeat.frequency) {
    case 'daily':
      return 'every day';
    case 'weekly':
      return `every ${days[repeat.dayOfWeek]}`;
    case 'biweekly':
      return `every other ${days[repeat.dayOfWeek]}`;
    case 'monthly':
      return `monthly on day ${repeat.dayOfMonth}`;
  }
}

/**
 * Members a chore may be assigned to, as in the Chores module's Add Chore dialog:
 * everyone with `chores.assign`, otherwise only the viewer.
 */
export function assignableMembers(members: QuickAddMember[], viewer: { uid: string; email: string }, canAssign: boolean): QuickAddMember[] {
  return canAssign ? members : members.filter((member) => member.uid === viewer.uid);
}

/**
 * The assignee a quick-add chore will really get: the requested member when they
 * are assignable, otherwise the viewer. `restricted` is true when a requested
 * member was replaced because the viewer lacks `chores.assign`.
 */
export function resolveChoreAssignee(
  requested: QuickAddMember | null,
  assignable: QuickAddMember[],
  self: QuickAddMember | null,
): { assignee: QuickAddMember | null; restricted: boolean } {
  if (requested && assignable.some((member) => member.uid === requested.uid)) return { assignee: requested, restricted: false };
  const fallback = self && assignable.some((member) => member.uid === self.uid) ? self : assignable[0] ?? self;
  return { assignee: fallback, restricted: Boolean(requested && fallback && requested.uid !== fallback.uid) };
}

/** Shopping's save states (src/lib/shopping/save-status.ts), repeated here so this module stays Firebase-free. */
export type ShoppingEntryState = 'saved' | 'stored-locally' | 'sending' | 'uncertain' | 'failed';

export type ShoppingAddOutcome = {
  /** Confirmed: the server answered, or the durable cache on this device holds them. */
  saved: QuickAddEntry[];
  failed: QuickAddEntry[];
  /**
   * Not confirmed yet (`sending`: queued but not known to survive a reload;
   * `uncertain`: a merge transaction with no answer). They stay in the palette's
   * retry state until they settle.
   */
  unconfirmed: QuickAddEntry[];
  /** "Checking…" when any unconfirmed entry is an unanswered transaction, else "Still sending…"; null without any. */
  unconfirmedLabel: string | null;
  /** True when at least one saved entry is only stored on this device (`stored-locally`). */
  queued: boolean;
  firstError?: unknown;
};

/**
 * Per-entry outcome of a quick-add shopping submission: which entries are
 * confirmed (saved, or stored durably on this device), which are not confirmed
 * yet, and which failed. Only `stored-locally` counts as "saved on this device";
 * `sending` and `uncertain` never do. The palette keeps unconfirmed and failed
 * entries in the preview, so a retry never loses or repeats one.
 */
export function shoppingAddOutcome(
  entries: readonly QuickAddEntry[],
  results: readonly { state: ShoppingEntryState; error?: unknown }[],
): ShoppingAddOutcome {
  const pick = (states: readonly ShoppingEntryState[]) => entries.filter((_, index) => states.includes(results[index]?.state ?? 'failed'));
  const saved = pick(['saved', 'stored-locally']);
  const unconfirmed = pick(['sending', 'uncertain']);
  const failed = pick(['failed']);
  const states = results.map((result) => result.state);
  const unconfirmedLabel = unconfirmed.length === 0 ? null : states.includes('uncertain') ? 'Checking…' : 'Still sending…';
  const queued = states.includes('stored-locally');
  const failedIndex = entries.findIndex((_, index) => (results[index]?.state ?? 'failed') === 'failed');
  const outcome: ShoppingAddOutcome = { saved, failed, unconfirmed, unconfirmedLabel, queued };
  if (failedIndex >= 0) outcome.firstError = results[failedIndex]?.error ?? new Error('save-failed');
  return outcome;
}

/** Status line while entries are unconfirmed: "Still sending… Milk, Eggs". */
export function unconfirmedShoppingMessage(outcome: Pick<ShoppingAddOutcome, 'unconfirmed' | 'unconfirmedLabel'>): string | null {
  if (outcome.unconfirmed.length === 0 || !outcome.unconfirmedLabel) return null;
  return `${outcome.unconfirmedLabel} ${outcome.unconfirmed.map((entry) => entry.name).join(', ')} not confirmed yet. Keep this open; it updates when they are.`;
}

/**
 * Ties each wait for unconfirmed shopping entries to the palette preview that
 * started it. `begin` hands out a token; `invalidate` (Back, the palette closing
 * or unmounting) makes every earlier token stale, so a late settlement can no
 * longer touch a preview the member left, or close a palette opened since.
 */
export function createSettlementGuard() {
  let current = 0;
  return {
    begin: () => ++current,
    invalidate: () => {
      current += 1;
    },
    isActive: (token: number) => token === current,
  };
}

export type UnconfirmedSettlement<T> = {
  /** Entries that reached the server late: always announced (toast, data-changed), even after the palette closed. */
  confirmed: T[];
  /** Entries still to retry: the late failures, then the ones that failed at once. */
  remaining: T[];
  /** What the preview does: nothing when it is no longer the active one, else close or offer a retry. */
  next: 'ignore' | 'close' | 'retry';
};

/** Plans what a late settlement of unconfirmed shopping entries does (see `createSettlementGuard`). */
export function planUnconfirmedSettlement<T>(unconfirmed: readonly T[], failed: readonly T[], lateFailed: readonly T[], active: boolean): UnconfirmedSettlement<T> {
  const confirmed = unconfirmed.filter((entry) => !lateFailed.includes(entry));
  const remaining = [...lateFailed, ...failed];
  return { confirmed, remaining, next: !active ? 'ignore' : remaining.length === 0 ? 'close' : 'retry' };
}

/** Inline message for entries that could not be added; they stay in the preview. */
export function quickAddRetryMessage(failed: readonly QuickAddEntry[]): string | null {
  if (failed.length === 0) return null;
  const names = failed.map((entry) => entry.name);
  const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  return `Couldn't add ${list}. ${failed.length === 1 ? 'It is' : 'They are'} still here; press Confirm to try again.`;
}

/**
 * Food type for a quick-logged meal, the Pets way: `knownFoodType` of the newest
 * feeding across both date-shape lists (merged with Pets' `newestFirst`), else Dry
 * (Pets' own default when there is no history).
 */
export function foodTypeFromLatest(lists: Array<Array<{ id: string; date: unknown; foodType?: unknown }>>): FoodType {
  return knownFoodType(newestFirst(lists, 1)[0]?.foodType) ?? 'Dry';
}

const CLAUSE_SPLIT = /\s*;\s*|,?\s+and then\s+|,\s+then\s+|,\s*(?:and\s+)?(?:also\s+)?(?=(?:remind|fed|feed|add|buy|get|grab|pick up|chore|task|log|logged|did|done|we need|i need)\b)/i;

/**
 * Several things in one sentence (QA-25): "milk and eggs, and remind Sam to take out
 * the trash Tuesday" or "fed Maple and Oreo". Splits into clauses at ";", "and then"
 * or a comma before a command word, and gives one intent per clause (one feeding per
 * pet named), but only when every clause reads on its own; otherwise null and the
 * single reading stands. A shopping list alone is never split here ("milk, eggs and
 * bread" is one shopping intent).
 */
export function parseQuickAddClauses(input: string, context: QuickAddContext): QuickAddIntent[] | null {
  const text = collapse(input).replace(/[.!?]+$/, '');
  if (text.length < 2 || text.length > 200) return null;
  const parts = text.split(CLAUSE_SPLIT).map((part) => part.trim()).filter(Boolean);
  const intents: QuickAddIntent[] = [];
  if (parts.length >= 2) {
    for (const part of parts) {
      const one = parseQuickAdd(part, context);
      if (!one) return expandPets(parseQuickAdd(text, context));
      intents.push(one);
    }
    if (intents.every((intent) => intent.kind === 'shopping')) return expandPets(parseQuickAdd(text, context));
  } else {
    return expandPets(parseQuickAdd(text, context));
  }
  const expanded = intents.flatMap((intent) => expandPets(intent) ?? [intent]);
  return expanded.length >= 2 ? expanded : null;
}

/** A feeding that named several pets, as one feeding per pet; null for anything else. */
function expandPets(intent: QuickAddIntent | null): QuickAddIntent[] | null {
  if (!intent || intent.kind !== 'feeding' || !intent.alsoPets?.length) return null;
  const { alsoPets, ...first } = intent;
  return [first, ...alsoPets.map((pet) => ({ ...first, pet }))];
}
