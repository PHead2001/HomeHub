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
import type { FoodType, PortionUnit } from '../pets/types';
import { parseQuickAdd as parseShoppingEntries, splitSettled, type QuickAddEntry } from '../shopping/items';

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Matches `value` only as whole words (a letter or digit on either side does not count). */
const wholeToken = (value: string) => new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(value.toLowerCase())}(?![\\p{L}\\p{N}])`, 'u');
const PORTION_UNIT_WORD = /\b(?:cups?|cans?|tins?|pouch(?:es)?|scoops?)\b/i;

export type QuickAddMember = { uid: string; email: string; name: string };
/** A pet, with its usual portion (Pets' `feedingPlan`) used when the sentence gives no amount. */
export type QuickAddPet = { id: string; name: string; portion?: { amount: number; unit: PortionUnit } };
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
export function findDate(text: string, now: Date): DateMatch | null {
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

  const weekday = /\b(next |this |on |by |due )?(sun(?:day)?|mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday)?|thu(?:r(?:s(?:day)?)?)?|fri(?:day)?|sat(?:urday)?)\b/.exec(lower);
  if (weekday && !/\bevery\b/.test(lower.slice(Math.max(0, weekday.index - 12), weekday.index + 1))) {
    const day = weekdayFromWord(weekday[2]);
    if (day !== null) {
      // "friday" is the coming Friday (today if it is Friday); "next friday" skips today.
      const date = nextWeekday(now, day, weekday[1]?.trim() === 'next');
      return { date, consumed: new RegExp(`\\b(next |this |on |by |due )?${weekday[2]}\\b`, 'i') };
    }
  }

  const monthDay = new RegExp(`\\b(on |by |due )?(${MONTHS.join('|')})[a-z]*\\.? (\\d{1,2})(st|nd|rd|th)?\\b`).exec(lower);
  if (monthDay) {
    const month = MONTHS.indexOf(monthDay[2]);
    const day = Number(monthDay[3]);
    let date = new Date(now.getFullYear(), month, day);
    if (date.getMonth() !== month) return null;
    if (date < startOfLocalDay(now)) date = new Date(now.getFullYear() + 1, month, day);
    return { date, consumed: new RegExp(monthDay[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') };
  }

  const numeric = /\b(on |by |due )?(\d{1,2})\/(\d{1,2})\b/.exec(lower);
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

type RepeatMatch = { repeat: QuickAddRepeat; consumed: RegExp; firstDate: Date };

export function findRepeat(text: string, now: Date): RepeatMatch | null {
  const lower = text.toLowerCase();
  if (/\b(every day|daily|each day)\b/.test(lower)) {
    return { repeat: { frequency: 'daily' }, consumed: /\b(every day|daily|each day)\b/i, firstDate: startOfLocalDay(now) };
  }
  const weekday = /\b(every|each)( other)? (sun(?:day)?|mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday)?|thu(?:r(?:s(?:day)?)?)?|fri(?:day)?|sat(?:urday)?)s?\b/.exec(lower);
  if (weekday) {
    const day = weekdayFromWord(weekday[3]);
    if (day !== null) {
      return {
        repeat: { frequency: weekday[2] ? 'biweekly' : 'weekly', dayOfWeek: day },
        consumed: /\b(every|each)( other)? [a-z]+\b/i,
        firstDate: nextWeekday(now, day),
      };
    }
  }
  if (/\b(every week|weekly|each week)\b/.test(lower)) {
    return {
      repeat: { frequency: 'weekly', dayOfWeek: now.getDay() as Weekday },
      consumed: /\b(every week|weekly|each week)\b/i,
      firstDate: startOfLocalDay(now),
    };
  }
  if (/\b(every other week|biweekly|fortnightly)\b/.test(lower)) {
    return {
      repeat: { frequency: 'biweekly', dayOfWeek: now.getDay() as Weekday },
      consumed: /\b(every other week|biweekly|fortnightly)\b/i,
      firstDate: startOfLocalDay(now),
    };
  }
  if (/\b(every month|monthly|each month)\b/.test(lower)) {
    const repeat = normalizeRepeat({ frequency: 'monthly', dayOfMonth: now.getDate() }).repeat;
    return {
      repeat,
      consumed: /\b(every month|monthly|each month)\b/i,
      firstDate: firstDateForRepeat(repeat, now),
    };
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
  for (const mention of text.matchAll(/(?:^|\s)(?:for\s+|to\s+|@)@?([a-z][a-z.'-]*)\b/gi)) {
    const word = mention[1].toLowerCase().replace(/[.'-]+$/, '');
    const consumed = new RegExp(mention[0].trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    if (word === 'me' || word === 'myself') {
      const self = context.members.find((member) => member.uid === context.viewer.uid || member.email === context.viewer.email);
      if (self) return { member: self, consumed };
      continue;
    }
    const matches = context.members.filter((candidate) => {
      const first = candidate.name.trim().split(/\s+/)[0]?.toLowerCase();
      const local = candidate.email.split('@')[0]?.toLowerCase();
      return first === word || candidate.name.toLowerCase() === word || local === word || local?.split(/[._-]/)[0] === word;
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
  return parseShoppingEntries(text.replace(/\s+(?:and|&|\+)\s+/gi, ','));
}

const capitalize = (value: string) => value.charAt(0).toUpperCase() + value.slice(1);

function parseFeeding(text: string, context: QuickAddContext): FeedingIntent | null {
  const match = /^(?:i\s+)?(?:fed|feed|fed up|feeding)\s+(.+)$/i.exec(text) ?? /^(.+?)\s+(?:ate|was fed|has eaten|got fed)\b(.*)$/i.exec(text);
  if (!match) return null;
  const rest = match[1].toLowerCase();
  const pet = [...context.pets]
    .sort((a, b) => b.name.length - a.name.length)
    .find((candidate) => wholeToken(candidate.name).test(rest));
  if (!pet) return null;
  // The Pets module's portion parser reads amounts whole (".5 cups", "1/2 cup",
  // "1 1/2 cups", "one can"), never the digits at the end of a decimal or fraction.
  const portion = parsePortion(text);
  // A unit with an amount the parser cannot read is rejected (falls back to search), never guessed.
  if (!portion && PORTION_UNIT_WORD.test(text)) return null;
  return { kind: 'feeding', pet, amount: portion?.amount ?? null, unit: portion?.unit ?? null };
}

const MAINTENANCE_WORDS = /\b(oil change|tire rotation|tyre rotation|brakes?|filters?|inspections?|service[sd]?|tune[- ]?up|alignment|repair(?:ed|s)?|replaced?|maintenance|miles|mi|odometer)\b/i;

function parseMaintenance(text: string, context: QuickAddContext): MaintenanceIntent | null {
  const explicit = /^(?:log|logged|did|done)\s+(.+)$/i.exec(text);
  let body = explicit ? explicit[1] : text;
  if (!MAINTENANCE_WORDS.test(body)) return null;
  const mileageMatch = /(\d{1,3}(?:,\d{3})+|\d{3,7})\s*(?:k\s*)?(?:miles|mi)\b/i.exec(body) ?? /\bat\s+(\d{1,3}(?:,\d{3})+|\d{4,7})\b/i.exec(body);
  const mileage = mileageMatch ? Number(mileageMatch[1].replace(/,/g, '')) : null;
  if (!explicit && mileage === null && !/\b(oil change|tire rotation|tyre rotation|tune[- ]?up|alignment)\b/i.test(body)) return null;
  body = body.replace(mileageMatch?.[0] ?? '', ' ');
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
  const verb = /^(?:please\s+)?(?:add|buy|get|grab|pick up|need|we need|i need|we're out of|out of)\s+(.+)$/i.exec(text);
  let body = verb ? verb[1] : text;
  let list: QuickAddList | null = null;
  let explicitList = false;
  const target = /\s+(?:to|on|onto|for)\s+(?:the\s+|my\s+|our\s+)?([a-z0-9' -]+?)(?:\s+list)?\s*$/i.exec(body);
  if (target) {
    const found = findList(target[1], context.lists);
    if (found) {
      list = found;
      explicitList = true;
      body = body.slice(0, target.index);
    }
  }
  const items = splitItems(body);
  if (items.length === 0) return null;
  return { kind: 'shopping', items, list: list ?? defaultList(context.lists), explicit: Boolean(verb) || explicitList };
}

function parseChore(text: string, context: QuickAddContext): ChoreIntent | null {
  const explicit = /^(?:chore|task|todo|to do|remind (?:me|us) to)[:\s]+(.+)$/i.exec(text);
  let body = explicit ? explicit[1] : text;
  const repeat = findRepeat(body, context.now);
  if (repeat) body = body.replace(repeat.consumed, ' ');
  const date = repeat ? null : findDate(body, context.now);
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
    repeatNote: repeat?.repeat.frequency === 'monthly' && context.now.getDate() > MONTHLY_MAX_DAY
      ? normalizeRepeat({ frequency: 'monthly', dayOfMonth: context.now.getDate() }).note
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

  const feeding = parseFeeding(text, context);
  if (feeding) return feeding;
  // "fed …" that names no known pet, or an amount that cannot be read, is never
  // reinterpreted as something else: it falls back to search.
  if (/^(?:i\s+)?(?:fed|feed|feeding)\s/i.test(text)) return null;

  if (/^(?:chore|task|todo|to do|remind (?:me|us) to)\b/i.test(text)) return parseChore(text, context);

  if (/^(?:please\s+)?(?:add|buy|get|grab|pick up|need|we need|i need|we're out of|out of)\s/i.test(text)) {
    return parseShopping(text, context);
  }

  const maintenance = parseMaintenance(text, context);
  if (maintenance) return maintenance;

  const chore = parseChore(text, context);
  if (chore) return chore;

  const shopping = parseShopping(text, context);
  return shopping && shopping.list ? shopping : null;
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
  return canAssign ? members : members.filter((member) => member.uid === viewer.uid || member.email === viewer.email);
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
  if (requested && assignable.some((member) => member.email === requested.email)) return { assignee: requested, restricted: false };
  const fallback = self && assignable.some((member) => member.email === self.email) ? self : assignable[0] ?? self;
  return { assignee: fallback, restricted: Boolean(requested && fallback && requested.email !== fallback.email) };
}

export type ShoppingAddOutcome = {
  saved: QuickAddEntry[];
  failed: QuickAddEntry[];
  /** True when at least one saved entry is only queued (offline). */
  queued: boolean;
  firstError?: unknown;
};

/**
 * Per-entry outcome of a quick-add shopping submission, with Shopping's
 * `splitSettled`: which entries were saved (or queued offline) and which failed.
 * The palette keeps only the failed ones in the preview for a retry.
 */
export function shoppingAddOutcome(
  entries: readonly QuickAddEntry[],
  settled: readonly PromiseSettledResult<'saved' | 'queued'>[],
): ShoppingAddOutcome {
  const { failed, firstError } = splitSettled(entries, settled);
  const saved = entries.filter((_, index) => settled[index]?.status === 'fulfilled');
  const queued = settled.some((result) => result.status === 'fulfilled' && result.value === 'queued');
  return firstError === undefined ? { saved, failed, queued } : { saved, failed, queued, firstError };
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
