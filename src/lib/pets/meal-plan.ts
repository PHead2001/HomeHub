/**
 * Meal slots (PE-22, PE-10, PE-25, PE-26, PE-31; decisions D-P3, D-P5, D-P18):
 * the pet's confirmed meal plan, the plan in force on any household day, how
 * feedings are attributed to slots, which slot a new feed is for, and the one
 * shared feeding status that the cards, the pet page, the F picker, the
 * palette's Feeding mode, the dashboard, the seven-day strip, the attention
 * strip and the living-house bowl all read, so they never disagree (PE-22h).
 *
 * Pure: no Firebase, React or browser imports, so a device-authorized server
 * action can call the same functions with documents read by the Admin SDK.
 *
 * Time model. "Today" is the household day (`household.timeZone`, PE-7). A slot
 * time is household-local `HH:mm`; every comparison is in household-local
 * minutes after midnight (`localMinutes`), never instants, so a slot at 02:30 on
 * a spring-forward day counts as passed at 03:00, and a fall-back day neither
 * drops nor doubles a slot.
 *
 * Windows (D-P21, for D-P5). A day's served slots, sorted by time, split the day from the
 * first window's opening to midnight: slot i's window opens
 * `SLOT_EARLY_MINUTES` before its time, but never before the midpoint between
 * it and the previous slot (the first opens at most 2 h early, never before
 * midnight), and stays open until the next slot's window opens (the last one
 * until midnight). Before the first window no slot is open. A slot is
 * `upcoming` before its window, `open` in its window before its time, `due`
 * in its window once its time has passed, `missed` once its window has closed
 * unfed, and `fed` when a feeding is attributed to it.
 *
 * Assignment (D-P5). A new feed at time t goes to the slot whose window is open
 * at t if it is unfed; else to the next unfed slot later today; when no unfed
 * slot remains from the open window on, it is a repeat of the open (fed) slot.
 * Earlier slots whose window has closed are missed, never targeted.
 *
 * Repeat prompt (D-P5). "Feed again?" asks when the target slot is already fed
 * (`slot-fed`, or `complete` when every slot of today is fed), when no slot is
 * served today (`off-day`), or when the last feed was under 90 minutes ago and
 * the target slot's window is not open yet (`recent`). Feeding a slot whose
 * window is open never asks for recency alone (an early dinner after a late
 * lunch). Without confirmed slots the 2.1 rule stays (under 90 minutes, or
 * today's count complete).
 */
import { addDays, dayOfWeek, diffDays, localMinutes, parseTimeOfDay } from '../../../functions/src/shared/calendar';
import { householdDayZone } from '../household-day';
import {
  feedingPlan,
  feedingStatus,
  formatPortion,
  petDay,
  seenFeedingDate,
  type FeedingEntry,
  type FeedingPlan,
  type FeedingStatus,
} from './care';
import { MEAL_SLOTS_MAX, isValidPortion, parseSchedule, type ParsedSchedule } from './schedule-parser';
import { PORTION_UNITS, type MealPlan, type MealPlanHistoryEntry, type MealSlot, type PetProfile, type PortionUnit } from './types';

export { MEAL_SLOTS_MAX } from './schedule-parser';

/* ------------------------------------------------------------------------- */
/* Limits shared with firestore.rules                                         */
/* ------------------------------------------------------------------------- */

export const MEAL_SLOT_NAME_MAX = 30;
/** Previous plans kept on the pet; older days are judged with the oldest kept plan. */
export const MEAL_PLAN_HISTORY_MAX = 10;
/** A slot's window opens this long before its time (D-P5). */
export const SLOT_EARLY_MINUTES = 120;
/** A feed this recent asks "Feed again?" when its target slot is not open yet (the 2.1 window). */
export const SLOT_REPEAT_WINDOW_MS = 90 * 60_000;

const SLOT_ID = /^[A-Za-z0-9_-]{1,32}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MINUTES = 24 * 60;

/* ------------------------------------------------------------------------- */
/* Reading stored plans (defensive: a malformed plan is no plan)              */
/* ------------------------------------------------------------------------- */

function readSlot(value: unknown): MealSlot | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  if (typeof raw.id !== 'string' || !SLOT_ID.test(raw.id)) return null;
  if (!name || name.length > MEAL_SLOT_NAME_MAX) return null;
  if (typeof raw.time !== 'string' || !TIME.test(raw.time)) return null;
  if (typeof raw.amount !== 'number' || !isValidPortion(raw.amount)) return null;
  if (!(PORTION_UNITS as readonly unknown[]).includes(raw.unit)) return null;
  let offDays: number[] | undefined;
  if (raw.offDays !== undefined && raw.offDays !== null) {
    if (!Array.isArray(raw.offDays) || raw.offDays.length > 6) return null;
    if (!raw.offDays.every((day) => Number.isInteger(day) && day >= 0 && day <= 6)) return null;
    offDays = [...new Set(raw.offDays as number[])].sort((a, b) => a - b);
  }
  return { id: raw.id, name, time: raw.time, amount: raw.amount, unit: raw.unit as PortionUnit, ...(offDays && offDays.length > 0 ? { offDays } : {}) };
}

/** Valid slots sorted by time, or null when the list is empty, too long, or any slot is malformed or repeated. */
export function readSlots(value: unknown): MealSlot[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > MEAL_SLOTS_MAX) return null;
  const slots: MealSlot[] = [];
  for (const entry of value) {
    const slot = readSlot(entry);
    if (!slot) return null;
    if (slots.some((other) => other.id === slot.id || other.time === slot.time)) return null;
    slots.push(slot);
  }
  return slots.sort((a, b) => a.time.localeCompare(b.time));
}

/** The pet's confirmed plan, or null (none, or malformed: then the pet is treated as unconfirmed, never guessed). */
export function readMealPlan(pet: { mealPlan?: unknown } | null | undefined): MealPlan | null {
  const raw = pet?.mealPlan as Record<string, unknown> | undefined;
  if (!raw || typeof raw !== 'object') return null;
  const slots = readSlots(raw.slots);
  if (!slots || typeof raw.effectiveFrom !== 'string' || !DAY.test(raw.effectiveFrom)) return null;
  return {
    slots,
    effectiveFrom: raw.effectiveFrom,
    confirmedAt: raw.confirmedAt,
    ...(typeof raw.confirmedByUid === 'string' ? { confirmedByUid: raw.confirmedByUid } : {}),
    ...(typeof raw.confirmedByName === 'string' ? { confirmedByName: raw.confirmedByName } : {}),
  };
}

/** The stored previous plans, valid entries only, oldest first. */
export function readMealPlanHistory(pet: { mealPlanHistory?: unknown } | null | undefined): MealPlanHistoryEntry[] {
  const raw = pet?.mealPlanHistory;
  if (!Array.isArray(raw)) return [];
  const entries: MealPlanHistoryEntry[] = [];
  for (const value of raw) {
    if (!value || typeof value !== 'object') continue;
    const entry = value as Record<string, unknown>;
    if (typeof entry.until !== 'string' || !DAY.test(entry.until)) continue;
    if (entry.slots !== undefined) {
      const slots = readSlots(entry.slots);
      if (slots) entries.push({ until: entry.until, slots });
      continue;
    }
    const perDay = typeof entry.perDay === 'number' && Number.isInteger(entry.perDay) && entry.perDay >= 1 && entry.perDay <= 12 ? entry.perDay : null;
    entries.push({ until: entry.until, perDay, ...(entry.nonDaily === true ? { nonDaily: true } : {}) });
  }
  return entries.sort((a, b) => a.until.localeCompare(b.until));
}

/* ------------------------------------------------------------------------- */
/* The plan in force on a household day (PE-22g)                              */
/* ------------------------------------------------------------------------- */

export type DayPlan =
  /** Confirmed slots: `slots` are the ones served that day (by time), `off` the ones skipped on that weekday. */
  | { kind: 'slots'; day: string; slots: MealSlot[]; off: MealSlot[] }
  /** No confirmed slots that day: the legacy daily target (structured fields or the parsed schedule). */
  | { kind: 'legacy'; day: string; plan: FeedingPlan };

type PlanSource = Pick<PetProfile, 'foodSchedule' | 'feedingsPerDay' | 'portionAmount' | 'portionUnit'> & { mealPlan?: unknown; mealPlanHistory?: unknown };

function slotsDay(slots: MealSlot[], day: string): DayPlan {
  const weekday = dayOfWeek(day);
  const served = slots.filter((slot) => !slot.offDays?.includes(weekday));
  return { kind: 'slots', day, slots: served, off: slots.filter((slot) => slot.offDays?.includes(weekday)) };
}

/**
 * The plan that applied on a household day: the current plan from its
 * `effectiveFrom` on, else the history entry covering that day (each entry
 * covers the days before its `until`), else the legacy target. Editing a plan
 * never changes how an earlier day is judged (PE-22g, PE-25d).
 */
export function planForDay(pet: PlanSource, day: string): DayPlan {
  const current = readMealPlan(pet);
  if (current && day >= current.effectiveFrom) return slotsDay(current.slots, day);
  const history = readMealPlanHistory(pet);
  // Days older than every kept entry use the oldest one (history is bounded).
  const entry = history.find((candidate) => day < candidate.until) ?? (current ? history[0] : undefined);
  if (entry?.slots) return slotsDay(entry.slots, day);
  if (entry) {
    const legacy = feedingPlan(pet);
    return { kind: 'legacy', day, plan: { perDay: entry.perDay ?? null, amount: legacy.amount, unit: legacy.unit, ...(entry.nonDaily ? { nonDaily: true } : {}) } };
  }
  return { kind: 'legacy', day, plan: feedingPlan(pet) };
}

/* ------------------------------------------------------------------------- */
/* Windows, attribution and assignment                                        */
/* ------------------------------------------------------------------------- */

/** Minutes after household midnight of a slot's time. */
export function slotMinutes(slot: Pick<MealSlot, 'time'>): number {
  return parseTimeOfDay(slot.time) ?? 0;
}

/** Each served slot's window `[open, close)` in household-local minutes (slots sorted by time). */
export function slotWindows(slots: Pick<MealSlot, 'time'>[]): { open: number; close: number }[] {
  const times = slots.map(slotMinutes);
  const opens = times.map((time, index) => (index === 0
    ? Math.max(0, time - SLOT_EARLY_MINUTES)
    : Math.max(time - SLOT_EARLY_MINUTES, Math.ceil((times[index - 1] + time) / 2))));
  return opens.map((open, index) => ({ open, close: index + 1 < opens.length ? opens[index + 1] : DAY_MINUTES }));
}

/** A feeding as the status reads it: when (as this device should read it), for which slot, by whom. */
export type FeedObservation = { id: string | null; at: Date; minutes: number; slotId: string | null; by: string | null; byUid: string | null };

/** The feedings on one household day, oldest first. */
export function feedsOnDay(logs: FeedingEntry[], day: string, now: Date, timeZone?: string | null): FeedObservation[] {
  const zone = householdDayZone(timeZone);
  const seen = new Set<string>();
  const feeds: FeedObservation[] = [];
  for (const log of logs) {
    if (log.id) {
      if (seen.has(log.id)) continue;
      seen.add(log.id);
    }
    const at = seenFeedingDate(log.date, now);
    // Epoch or unreadable dates (bad legacy data) are not feedings of any day.
    if (!at || at.getTime() <= 0 || petDay(at, timeZone) !== day) continue;
    feeds.push({
      id: typeof log.id === 'string' ? log.id : null,
      at,
      minutes: localMinutes(at, zone),
      slotId: typeof log.slotId === 'string' && log.slotId ? log.slotId : null,
      by: log.loggedByName?.trim() || null,
      byUid: typeof log.loggedByUid === 'string' ? log.loggedByUid : null,
    });
  }
  return feeds.sort((a, b) => a.at.getTime() - b.at.getTime());
}

export type SlotTarget = {
  index: number;
  /** The target's window is open (feeding now is on time or late). */
  open: boolean;
  /** The target is already fed: no unfed slot remains from the open window on. */
  alreadyFed: boolean;
};

/**
 * D-P5: which served slot a feed at `minutes` is for, given which are fed. The
 * open window's slot if unfed; else the next unfed slot later today; else the
 * open (fed) slot as a repeat. Null without served slots (an off-day).
 */
export function targetSlot(slots: Pick<MealSlot, 'time'>[], fed: boolean[], minutes: number): SlotTarget | null {
  if (slots.length === 0) return null;
  const windows = slotWindows(slots);
  let current = -1;
  windows.forEach((window, index) => {
    if (minutes >= window.open) current = index;
  });
  if (current >= 0 && !fed[current]) return { index: current, open: true, alreadyFed: false };
  for (let index = current + 1; index < slots.length; index += 1) {
    if (!fed[index]) return { index, open: false, alreadyFed: false };
  }
  return { index: Math.max(current, 0), open: current >= 0, alreadyFed: true };
}

/**
 * Which feedings fed which slot on a day. A feeding that names a served slot
 * (`slotId`) feeds it; one without (older entries, offline and backdated
 * entries, a 2.1 client) is assigned in time order by `targetSlot` at its own
 * time, in time order. A second feeding of a fed slot is an extra on that
 * slot (a double feed); a feeding naming a slot not served that day (an
 * off-day, or a slot removed by an edit), or any feeding on a day without
 * served slots, is an extra of the day.
 */
export function attributeFeeds(slots: MealSlot[], feeds: FeedObservation[]): { bySlot: FeedObservation[][]; extras: FeedObservation[] } {
  const bySlot: FeedObservation[][] = slots.map(() => []);
  const extras: FeedObservation[] = [];
  // In time order, so a feeding without a slot sees only the slots fed before it.
  for (const feed of [...feeds].sort((a, b) => a.at.getTime() - b.at.getTime())) {
    const named = feed.slotId ? slots.findIndex((slot) => slot.id === feed.slotId) : -1;
    if (named >= 0) {
      bySlot[named].push(feed);
      continue;
    }
    const target = feed.slotId ? null : targetSlot(slots, bySlot.map((list) => list.length > 0), feed.minutes);
    if (target) bySlot[target.index].push(feed);
    else extras.push(feed);
  }
  return { bySlot, extras };
}

/** The name of the meal a feeding recorded (`slotId`), from the plan in force on its household day; null without one. */
export function slotNameOf(pet: PlanSource, log: FeedingEntry, now: Date, timeZone?: string | null): string | null {
  if (typeof log.slotId !== 'string' || !log.slotId) return null;
  const at = seenFeedingDate(log.date, now);
  if (!at || at.getTime() <= 0) return null;
  const plan = planForDay(pet, petDay(at, timeZone));
  const slots = plan.kind === 'slots' ? [...plan.slots, ...plan.off] : readMealPlan(pet)?.slots ?? [];
  return slots.find((slot) => slot.id === log.slotId)?.name ?? null;
}

/** Slot ids fed on a day, each with its first feeding's log id (the feeding state's `slotsFed`, checked by the rules). */
export function slotsFedOn(logs: FeedingEntry[], day: string, now: Date, timeZone?: string | null, excludeId?: string): Record<string, string> {
  const fed: Record<string, string> = {};
  for (const feed of feedsOnDay(logs.filter((log) => !excludeId || log.id !== excludeId), day, now, timeZone)) {
    if (feed.slotId && feed.id && !(feed.slotId in fed)) fed[feed.slotId] = feed.id;
  }
  return fed;
}

/* ------------------------------------------------------------------------- */
/* The shared status (PE-22h)                                                 */
/* ------------------------------------------------------------------------- */

export type SlotPhase = 'fed' | 'upcoming' | 'open' | 'due' | 'missed';

export type SlotState = {
  slot: MealSlot;
  phase: SlotPhase;
  /** The feeding that fed it (the first), null when unfed. */
  fed: FeedObservation | null;
  /** Further feedings attributed to this slot (double feeds). */
  extras: number;
  window: { open: number; close: number };
};

export type SlotDay = {
  day: string;
  slots: SlotState[];
  /** Slots of the plan not served on this weekday. */
  off: MealSlot[];
  /** Feedings that fed no served slot (an off-day feeding, or a slot not served that day). */
  extraFeeds: number;
  fedCount: number;
  planned: number;
  /** Total feedings on the day (fed slots, double feeds and extras). */
  feedings: number;
};

/** Slot states on a day. `nowMinutes`: household-local minutes for today; `Infinity` for a past day (every window closed). */
export function slotDay(plan: Extract<DayPlan, { kind: 'slots' }>, feeds: FeedObservation[], nowMinutes: number): SlotDay {
  const windows = slotWindows(plan.slots);
  const { bySlot, extras } = attributeFeeds(plan.slots, feeds);
  const slots = plan.slots.map<SlotState>((slot, index) => {
    const window = windows[index];
    const list = bySlot[index];
    const fed = list[0] ?? null;
    let phase: SlotPhase;
    if (fed) phase = 'fed';
    else if (nowMinutes < window.open) phase = 'upcoming';
    else if (nowMinutes < window.close) phase = nowMinutes < slotMinutes(slot) ? 'open' : 'due';
    else phase = 'missed';
    return { slot, phase, fed, extras: Math.max(0, list.length - 1), window };
  });
  return {
    day: plan.day,
    slots,
    off: plan.off,
    extraFeeds: extras.length,
    fedCount: slots.filter((state) => state.fed).length,
    planned: slots.length,
    feedings: feeds.length,
  };
}

export type MealStatus =
  | {
      kind: 'slots';
      day: SlotDay;
      /** The slot a feed now would be for (D-P5), with whether its window is open; null on an off-day. */
      target: (SlotTarget & { state: SlotState }) | null;
      /** A slot whose time has passed unfed while its window is open: the only "needs food" (bowl, amber, Fed). */
      due: SlotState | null;
      /** Earlier slots today whose window closed unfed. */
      missed: SlotState[];
      /** Every served slot of today is fed. */
      complete: boolean;
      /** No slot is served today (all off). */
      offDay: boolean;
      last: FeedingStatus['last'];
    }
  | {
      kind: 'legacy';
      /** The 2.1 status: today's count against the legacy target. */
      status: FeedingStatus;
      plan: FeedingPlan;
      /** PE-10b (D-P18): "Next meal: evening" from the parsed schedule, a neutral hint only. */
      nextMealHint: string | null;
    };

/**
 * The one feeding status every surface reads (PE-22h). With confirmed slots:
 * the slots of the household day with their phases, the feed target, the due
 * slot and the missed ones. Without: the legacy status with a neutral parsed
 * hint; such a pet never "needs food" (D-P3: no guess shown as a need).
 */
export function mealStatus(pet: PlanSource, logs: FeedingEntry[], now: Date, timeZone?: string | null): MealStatus {
  const today = petDay(now, timeZone);
  const plan = planForDay(pet, today);
  if (plan.kind === 'legacy') {
    const status = feedingStatus(logs, plan.plan, now, timeZone);
    return { kind: 'legacy', status, plan: plan.plan, nextMealHint: legacyNextMeal(pet.foodSchedule, status.fedToday) };
  }
  const nowMinutes = localMinutes(now, householdDayZone(timeZone));
  const day = slotDay(plan, feedsOnDay(logs, today, now, timeZone), nowMinutes);
  const fed = day.slots.map((state) => state.fed !== null);
  const target = targetSlot(plan.slots, fed, nowMinutes);
  const last = feedingStatus(logs, { perDay: null }, now, timeZone).last;
  return {
    kind: 'slots',
    day,
    target: target ? { ...target, state: day.slots[target.index] } : null,
    due: day.slots.find((state) => state.phase === 'due') ?? null,
    missed: day.slots.filter((state) => state.phase === 'missed'),
    complete: day.planned > 0 && day.fedCount === day.planned,
    offDay: day.planned === 0,
    last,
  };
}

/**
 * PE-10b (D-P18): the next meal a legacy schedule names ("Next meal: evening",
 * "Next meal: 6:00 pm"), counted from today's feedings; null when the text names
 * no meals (a bare "twice daily" names none). A neutral hint, never a due claim.
 */
export function legacyNextMeal(schedule: string | null | undefined, fedToday: number): string | null {
  const parsed = parseSchedule(schedule);
  if (parsed.kind !== 'plan' || parsed.meals.some((meal) => meal.source === 'count')) return null;
  const next = parsed.meals[fedToday];
  if (!next) return null;
  return next.source === 'time' ? `Next meal: ${formatSlotTime(next.time)}` : `Next meal: ${next.group}`;
}

/* ------------------------------------------------------------------------- */
/* Shared labels                                                              */
/* ------------------------------------------------------------------------- */

/** "6:00 pm" for `18:00`; "12:30 am" for `00:30`. */
export function formatSlotTime(time: string): string {
  const minutes = parseTimeOfDay(time) ?? 0;
  const hours = Math.floor(minutes / 60);
  const hour12 = hours % 12 === 0 ? 12 : hours % 12;
  return `${hour12}:${String(minutes % 60).padStart(2, '0')} ${hours < 12 ? 'am' : 'pm'}`;
}

/** "7:42 am" for an instant, in the household zone. */
export function formatClock(date: Date, timeZone?: string | null): string {
  const minutes = localMinutes(date, householdDayZone(timeZone));
  const time = `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
  return formatSlotTime(time);
}

/** One slot's line: "Breakfast ✓ 7:42 am · Sam", "Dinner due 6:00 pm", "Lunch missed", "Dinner 6:00 pm". */
export function slotLine(state: SlotState, timeZone?: string | null): string {
  const { slot } = state;
  if (state.fed) {
    const extra = state.extras > 0 ? ` (+${state.extras} more)` : '';
    return `${slot.name} ✓ ${formatClock(state.fed.at, timeZone)}${state.fed.by ? ` · ${state.fed.by}` : ''}${extra}`;
  }
  if (state.phase === 'due') return `${slot.name} due ${formatSlotTime(slot.time)}`;
  if (state.phase === 'missed') return `${slot.name} missed`;
  return `${slot.name} ${formatSlotTime(slot.time)}`;
}

/**
 * The status line every surface shows (PE-10a, PE-22b): "Dinner due 6:00 pm"
 * when a slot's time has passed unfed, the next meal ("Next: dinner at 6:00 pm"),
 * "All 2 meals done today", or "No meals planned today" on an off-day.
 */
export function mealHeadline(status: Extract<MealStatus, { kind: 'slots' }>): string {
  if (status.due) return `${status.due.slot.name} due ${formatSlotTime(status.due.slot.time)}`;
  if (status.offDay) return 'No meals planned today';
  if (status.complete) return status.day.planned === 1 ? 'Meal done today' : `All ${status.day.planned} meals done today`;
  const next = status.day.slots.find((state) => !state.fed && state.phase !== 'missed');
  if (next) return `Next: ${next.slot.name.toLowerCase()} at ${formatSlotTime(next.slot.time)}`;
  const missed = status.missed[status.missed.length - 1];
  return missed ? `${missed.slot.name} missed` : 'No meals left today';
}

/** "1 of 2 meals today" for a slot status. */
export function mealCountLabel(status: Extract<MealStatus, { kind: 'slots' }>): string {
  if (status.offDay) return status.day.feedings > 0 ? `${status.day.feedings} today (no meals planned)` : 'No meals planned today';
  return `${status.day.fedCount} of ${status.day.planned} ${status.day.planned === 1 ? 'meal' : 'meals'} today`;
}

/** The Feed button's target ("Feed dinner · 1 can") and the portion it logs. */
export function feedTarget(status: MealStatus): { label: string; slotName: string | null; amount: number; unit: PortionUnit } {
  if (status.kind === 'legacy') {
    return { label: formatPortion(status.plan.amount, status.plan.unit), slotName: null, amount: status.plan.amount, unit: status.plan.unit };
  }
  if (!status.target) {
    // An off-day: a feed is an extra (it asks first); it logs the plan's first meal portion.
    const first = status.day.off[0] ?? status.day.slots[0];
    const amount = first?.amount ?? 1;
    const unit = first?.unit ?? 'Cups';
    return { label: formatPortion(amount, unit), slotName: null, amount, unit };
  }
  const { slot } = status.target.state;
  return { label: `${slot.name.toLowerCase()} · ${formatPortion(slot.amount, slot.unit)}`, slotName: slot.name, amount: slot.amount, unit: slot.unit };
}

/**
 * The pet waits by the bowl, turns amber, gets one-tap Fed on the dashboard and
 * shows in the attention strip as "needs food" only when a confirmed slot is
 * due (D-P3, PE-31d): never for an unconfirmed plan, never all afternoon
 * because dinner is still ahead.
 */
export function needsMeal(status: MealStatus | null): boolean {
  return status?.kind === 'slots' && status.due !== null;
}

/** A meal needs attention (PE-26a): a slot due now or missed earlier today. */
export function mealAttention(status: MealStatus | null): string | null {
  if (status?.kind !== 'slots') return null;
  if (status.due) return `${status.due.slot.name} due ${formatSlotTime(status.due.slot.time)}`;
  const missed = status.missed[status.missed.length - 1];
  return missed ? `${missed.slot.name} missed` : null;
}

/* ------------------------------------------------------------------------- */
/* Seven-day strip (PE-25)                                                    */
/* ------------------------------------------------------------------------- */

export type DayMark = {
  day: string;
  /** "Mon" (household calendar). */
  weekday: string;
  /** Each day judged by the plan in force on it (PE-25d). */
  plan: 'slots' | 'legacy';
  /** Planned meals that day (null: no daily target, e.g. a non-daily legacy schedule). */
  planned: number | null;
  /** Meals fed (slots) or feedings (legacy). */
  fed: number;
  /** Double or extra feedings (PE-25b). */
  extra: number;
  /**
   * `met`: every planned meal fed; `partial`: some; `missed`: none (with a plan);
   * `off`: nothing planned that day (off-day, or a non-daily legacy plan) and
   * nothing fed; `fed`: fed without a daily target; `today`: today, still open;
   * `unknown`: older than the loaded history.
   */
  state: 'met' | 'partial' | 'missed' | 'off' | 'fed' | 'today' | 'unknown';
  label: string;
};

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/**
 * One mark per household day for the last `days` days (oldest first, today
 * last), each against the plan in force that day (PE-25a, PE-25d), from the
 * logs already loaded (PE-25c). `complete`: the logs cover every day back to
 * the first one; when they were cut at a limit, days before the oldest loaded
 * feeding are `unknown` instead of "missed".
 */
export function feedingWeek(pet: PlanSource, logs: FeedingEntry[], now: Date, timeZone: string | null | undefined, options: { days?: number; complete: boolean }): DayMark[] {
  const count = options.days ?? 7;
  const today = petDay(now, timeZone);
  let oldestLoaded: string | null = null;
  for (const log of logs) {
    const at = seenFeedingDate(log.date, now);
    if (!at || at.getTime() <= 0) continue;
    const day = petDay(at, timeZone);
    if (!oldestLoaded || day < oldestLoaded) oldestLoaded = day;
  }
  const marks: DayMark[] = [];
  for (let offset = count - 1; offset >= 0; offset -= 1) {
    const day = addDays(today, -offset);
    const weekday = WEEKDAYS[dayOfWeek(day)];
    const plan = planForDay(pet, day);
    // A cut history only covers the days after its oldest loaded feeding.
    const covered = options.complete || (oldestLoaded !== null && day > oldestLoaded);
    const feeds = feedsOnDay(logs, day, now, timeZone);
    const isToday = day === today;
    if (!covered && !isToday) {
      marks.push({ day, weekday, plan: plan.kind, planned: null, fed: 0, extra: 0, state: 'unknown', label: `${weekday}: not loaded` });
      continue;
    }
    if (plan.kind === 'slots') {
      const result = slotDay(plan, feeds, isToday ? localMinutes(now, householdDayZone(timeZone)) : Number.POSITIVE_INFINITY);
      const extra = result.extraFeeds + result.slots.reduce((sum, state) => sum + state.extras, 0);
      const state: DayMark['state'] = result.planned === 0
        ? (result.feedings > 0 ? 'fed' : 'off')
        : result.fedCount === result.planned ? 'met'
          : isToday ? 'today'
            : result.fedCount > 0 ? 'partial' : 'missed';
      marks.push({ day, weekday, plan: 'slots', planned: result.planned, fed: result.fedCount, extra, state, label: dayMarkLabel(weekday, state, result.fedCount, result.planned, extra) });
      continue;
    }
    const perDay = plan.plan.perDay;
    const fed = feeds.length;
    const extra = perDay ? Math.max(0, fed - perDay) : 0;
    const state: DayMark['state'] = !perDay
      ? (fed > 0 ? 'fed' : 'off')
      : fed >= perDay ? 'met'
        : isToday ? 'today'
          : fed > 0 ? 'partial' : 'missed';
    marks.push({ day, weekday, plan: 'legacy', planned: perDay, fed: perDay ? Math.min(fed, perDay) : fed, extra, state, label: dayMarkLabel(weekday, state, perDay ? Math.min(fed, perDay) : fed, perDay, extra) });
  }
  return marks;
}

function dayMarkLabel(weekday: string, state: DayMark['state'], fed: number, planned: number | null, extra: number): string {
  const extraText = extra > 0 ? `, ${extra} extra` : '';
  switch (state) {
    case 'met': return `${weekday}: all ${planned} fed${extraText}`;
    case 'partial': return `${weekday}: ${fed} of ${planned} fed${extraText}`;
    case 'missed': return `${weekday}: none of ${planned} fed`;
    case 'off': return `${weekday}: no meals planned`;
    case 'fed': return `${weekday}: fed ${fed}${fed === 1 ? ' time' : ' times'}`;
    case 'today': return `${weekday} (today): ${fed} of ${planned} so far${extraText}`;
    default: return `${weekday}: not loaded`;
  }
}

/** Days between two household days (for the strip's tests and history). */
export function daysBetween(later: string, earlier: string): number {
  return diffDays(later, earlier);
}

/* ------------------------------------------------------------------------- */
/* Editing and confirming a plan (PE-22k, PE-6f, PE-22i)                      */
/* ------------------------------------------------------------------------- */

/** A slot as the form edits it (strings until saved). */
export type MealSlotDraft = { id: string; name: string; time: string; amount: string; unit: PortionUnit; offDays: number[] };

/** A new stable slot id (random; never reused when a slot is renamed or moved). */
export function newMealSlotId(): string {
  return `slot-${globalThis.crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

/** Form rows from the stored plan. */
export function draftFromPlan(plan: MealPlan | null): MealSlotDraft[] {
  return (plan?.slots ?? []).map((slot) => ({ id: slot.id, name: slot.name, time: slot.time, amount: String(slot.amount), unit: slot.unit, offDays: slot.offDays ?? [] }));
}

/** Form rows from a parsed suggestion (shown for correction, saved only on confirmation). */
export function draftFromSuggestion(parsed: ParsedSchedule, newId: () => string = newMealSlotId): MealSlotDraft[] {
  if (parsed.kind !== 'plan') return [];
  return parsed.meals.map((meal) => ({ id: newId(), name: meal.name, time: meal.time, amount: String(meal.amount), unit: meal.unit, offDays: [] }));
}

export type MealSlotErrors = Partial<Record<'name' | 'time' | 'amount' | 'offDays', string>>;

/** Inline errors per row and for the plan; an empty draft is valid (no plan). */
export function validateMealDraft(rows: MealSlotDraft[]): { rows: MealSlotErrors[]; plan: string | null } {
  const errors = rows.map<MealSlotErrors>((row) => {
    const rowErrors: MealSlotErrors = {};
    const name = row.name.trim();
    if (!name) rowErrors.name = 'Name this meal.';
    else if (name.length > MEAL_SLOT_NAME_MAX) rowErrors.name = `Keep it under ${MEAL_SLOT_NAME_MAX + 1} characters.`;
    if (!TIME.test(row.time)) rowErrors.time = 'Pick a time.';
    const amount = Number(row.amount);
    if (!row.amount.trim() || !isValidPortion(amount)) rowErrors.amount = 'Use an amount above 0 and up to 50.';
    if (row.offDays.length >= 7) rowErrors.offDays = 'Serve it on at least one day.';
    return rowErrors;
  });
  rows.forEach((row, index) => {
    if (TIME.test(row.time) && rows.findIndex((other) => other.time === row.time) !== index) errors[index].time = 'Another meal is at this time.';
  });
  const plan = rows.length > MEAL_SLOTS_MAX ? `Up to ${MEAL_SLOTS_MAX} meals a day.` : null;
  return { rows: errors, plan };
}

/** Slots to save from valid rows (sorted by time, amounts rounded to two decimals). */
export function slotsFromDraft(rows: MealSlotDraft[]): MealSlot[] {
  return rows
    .map((row) => {
      const offDays = [...new Set(row.offDays)].filter((day) => day >= 0 && day <= 6).sort((a, b) => a - b);
      return { id: row.id, name: row.name.trim(), time: row.time, amount: Math.round(Number(row.amount) * 100) / 100, unit: row.unit, ...(offDays.length ? { offDays } : {}) };
    })
    .sort((a, b) => a.time.localeCompare(b.time));
}

/**
 * The pet fields that confirm a plan (`effectiveFrom` = the household day of the
 * edit). The previous plan stays in `mealPlanHistory` (PE-22g): a first plan
 * records the legacy target it replaces; a later edit records the replaced slots
 * up to today; a second edit on the same day replaces today's plan without a new
 * entry (it never applied to a finished day). At most `MEAL_PLAN_HISTORY_MAX`
 * entries are kept. `feedingsPerDay` and the usual portion follow the plan so
 * older clients and the legacy rule stay consistent. `confirmedAt` is filled in
 * by the writer (server time). Null when nothing changes.
 */
export function confirmMealPlan(pet: PlanSource, slots: MealSlot[], today: string): {
  mealPlan: Omit<MealPlan, 'confirmedAt' | 'confirmedByUid' | 'confirmedByName'>;
  mealPlanHistory: MealPlanHistoryEntry[];
  feedingsPerDay: number;
  portionAmount: number;
  portionUnit: PortionUnit;
} | null {
  const current = readMealPlan(pet);
  const storedHistory = Array.isArray(pet.mealPlanHistory) ? (pet.mealPlanHistory as MealPlanHistoryEntry[]) : [];
  if (current && sameSlots(current.slots, slots)) return null;
  let history: MealPlanHistoryEntry[];
  if (!current) {
    const legacy = feedingPlan(pet);
    history = [{ until: today, perDay: legacy.perDay, ...(legacy.nonDaily ? { nonDaily: true } : {}) }];
  } else if (current.effectiveFrom >= today) {
    // Edited again on the day it started (or a day it has not reached): it never judged a finished day.
    history = storedHistory;
  } else {
    history = [...storedHistory, { until: today, slots: storedSlots(pet) }];
    if (history.length > MEAL_PLAN_HISTORY_MAX) history = history.slice(history.length - MEAL_PLAN_HISTORY_MAX);
  }
  return {
    mealPlan: { slots, effectiveFrom: current && current.effectiveFrom > today ? current.effectiveFrom : today },
    mealPlanHistory: history,
    feedingsPerDay: slots.length,
    portionAmount: slots[0].amount,
    portionUnit: slots[0].unit,
  };
}

/** The current plan's slots exactly as stored (the rules compare the history entry to them). */
function storedSlots(pet: PlanSource): MealSlot[] {
  const raw = (pet.mealPlan as { slots?: MealSlot[] } | undefined)?.slots;
  return Array.isArray(raw) ? raw : [];
}

function sameSlots(a: MealSlot[], b: MealSlot[]): boolean {
  const key = (slots: MealSlot[]) => JSON.stringify([...slots].sort((x, y) => x.time.localeCompare(y.time)).map((slot) => [slot.id, slot.name, slot.time, slot.amount, slot.unit, slot.offDays ?? []]));
  return key(a) === key(b);
}

/** How a plan reads back for confirmation: "Reads as: 2 feedings of 1 cup" (PE-6f). */
export function readsAs(slots: Pick<MealSlot, 'amount' | 'unit'>[]): string {
  if (slots.length === 0) return 'No meal times yet.';
  const portions = new Set(slots.map((slot) => formatPortion(slot.amount, slot.unit)));
  const feedings = `${slots.length} ${slots.length === 1 ? 'feeding' : 'feedings'}`;
  return portions.size === 1 ? `Reads as: ${feedings} of ${[...portions][0]}` : `Reads as: ${feedings} (${[...portions].join(', ')})`;
}
