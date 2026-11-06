/**
 * Natural-language quick-add (H13/H14). A deterministic parser, no model: it
 * recognizes shopping items, pet feedings, chores (with a date, assignee and an
 * optional repeat) and maintenance notes. Anything it cannot read confidently
 * returns `null`, and the palette falls back to search.
 */
import { addLocalDays, dayKey, startOfLocalDay } from './dates';

export type QuickAddMember = { uid: string; email: string; name: string };
export type QuickAddPet = { id: string; name: string };
export type QuickAddList = { id: string; name: string; type?: string };

export type QuickAddContext = {
  now: Date;
  viewer: { uid: string; email: string };
  members: QuickAddMember[];
  pets: QuickAddPet[];
  lists: QuickAddList[];
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
  unit: 'Cups' | 'Cans' | 'Scoops' | null;
};

export type ChoreIntent = {
  kind: 'chore';
  task: string;
  dueDate: string; // yyyy-MM-dd
  assignee: QuickAddMember | null;
  repeat: QuickAddRepeat | null;
};

export type MaintenanceIntent = {
  kind: 'maintenance';
  title: string;
  mileage: number | null;
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
    return {
      repeat: { frequency: 'monthly', dayOfMonth: now.getDate() },
      consumed: /\b(every month|monthly|each month)\b/i,
      firstDate: startOfLocalDay(now),
    };
  }
  return null;
}

/** Matches "for Sam", "for me", "@sam" to a household member. */
export function findAssignee(text: string, context: QuickAddContext): { member: QuickAddMember; consumed: RegExp } | null {
  for (const mention of text.matchAll(/(?:^|\s)(?:for\s+|to\s+|@)@?([a-z][a-z.'-]*)\b/gi)) {
    const word = mention[1].toLowerCase().replace(/[.'-]+$/, '');
    const consumed = new RegExp(mention[0].trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    if (word === 'me' || word === 'myself') {
      const self = context.members.find((member) => member.uid === context.viewer.uid || member.email === context.viewer.email);
      if (self) return { member: self, consumed };
      continue;
    }
    const member = context.members.find((candidate) => {
      const first = candidate.name.trim().split(/\s+/)[0]?.toLowerCase();
      const local = candidate.email.split('@')[0]?.toLowerCase();
      return first === word || candidate.name.toLowerCase() === word || local === word || local?.split(/[._-]/)[0] === word;
    });
    if (member) return { member, consumed };
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
  const byName = lists.find((list) => normalize(list.name) === target)
    ?? lists.find((list) => normalize(list.name).startsWith(target) || normalize(list.name).split(' ').includes(target));
  if (byName) return byName;
  for (const [pattern, type] of LIST_TYPE_WORDS) {
    if (pattern.test(target)) return lists.find((list) => list.type === type) ?? null;
  }
  return null;
}

const defaultList = (lists: QuickAddList[]) => lists.find((list) => list.type === 'Grocery') ?? lists[0] ?? null;

/** Splits "2 milk, eggs and bread x3" into items with quantities. */
export function splitItems(text: string): Array<{ name: string; quantity: number }> {
  return text
    .split(/,|\band\b|&|\+/i)
    .map((part) => collapse(part))
    .filter(Boolean)
    .map((part) => {
      const leading = /^(\d{1,3})\s*(?:x\s*)?(.+)$/i.exec(part);
      if (leading) return { name: collapse(leading[2]), quantity: Number(leading[1]) };
      const trailing = /^(.+?)\s*(?:x\s*(\d{1,3})|\((\d{1,3})\))$/i.exec(part);
      if (trailing) return { name: collapse(trailing[1]), quantity: Number(trailing[2] ?? trailing[3]) };
      return { name: part, quantity: 1 };
    })
    .filter((item) => item.name.length > 0 && item.name.length <= 100 && item.quantity > 0)
    .slice(0, 10);
}

const capitalize = (value: string) => value.charAt(0).toUpperCase() + value.slice(1);

function parseFeeding(text: string, context: QuickAddContext): FeedingIntent | null {
  const match = /^(?:i\s+)?(?:fed|feed|fed up|feeding)\s+(.+)$/i.exec(text) ?? /^(.+?)\s+(?:ate|was fed|has eaten|got fed)\b(.*)$/i.exec(text);
  if (!match) return null;
  const rest = match[1].toLowerCase();
  const pet = [...context.pets]
    .sort((a, b) => b.name.length - a.name.length)
    .find((candidate) => new RegExp(`\\b${candidate.name.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(rest));
  if (!pet) return null;
  const amount = /(\d+(?:\.\d+)?|half|one|two)\s*(cups?|cans?|scoops?)/i.exec(text);
  const numeric = amount ? ({ half: 0.5, one: 1, two: 2 } as Record<string, number>)[amount[1].toLowerCase()] ?? Number(amount[1]) : null;
  const unitWord = amount?.[2].toLowerCase() ?? '';
  const unit = unitWord.startsWith('cup') ? 'Cups' : unitWord.startsWith('can') ? 'Cans' : unitWord.startsWith('scoop') ? 'Scoops' : null;
  return { kind: 'feeding', pet, amount: numeric && numeric > 0 && numeric <= 20 ? numeric : null, unit };
}

const MAINTENANCE_WORDS = /\b(oil change|tire rotation|tyre rotation|brake|filter|inspection|serviced?|tune[- ]?up|alignment|repair(ed)?|replaced?|maintenance|miles|mi\b|odometer)/i;

function parseMaintenance(text: string): MaintenanceIntent | null {
  const explicit = /^(?:log|logged|did|done)\s+(.+)$/i.exec(text);
  const body = explicit ? explicit[1] : text;
  if (!MAINTENANCE_WORDS.test(body)) return null;
  const mileageMatch = /(\d{1,3}(?:,\d{3})+|\d{3,7})\s*(?:k\s*)?(?:miles|mi)\b/i.exec(body) ?? /\bat\s+(\d{1,3}(?:,\d{3})+|\d{4,7})\b/i.exec(body);
  const mileage = mileageMatch ? Number(mileageMatch[1].replace(/,/g, '')) : null;
  if (!explicit && mileage === null && !/\b(oil change|tire rotation|tyre rotation|tune[- ]?up|alignment)\b/i.test(body)) return null;
  const title = collapse(body.replace(mileageMatch?.[0] ?? '', '').replace(/\bat\s*$/i, ''));
  if (!title) return null;
  return { kind: 'maintenance', title: capitalize(title).slice(0, 100), mileage: mileage !== null && mileage > 0 && mileage < 2_000_000 ? mileage : null };
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
    repeat: repeat?.repeat ?? null,
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

  if (/^(?:chore|task|todo|to do|remind (?:me|us) to)\b/i.test(text)) return parseChore(text, context);

  if (/^(?:please\s+)?(?:add|buy|get|grab|pick up|need|we need|i need|we're out of|out of)\s/i.test(text)) {
    return parseShopping(text, context);
  }

  const maintenance = parseMaintenance(text);
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
