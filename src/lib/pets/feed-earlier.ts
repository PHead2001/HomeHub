/**
 * "When did <pet> eat?" (owner request "Feed earlier"): the times a member can
 * pick for a feeding that already happened, in the HOUSEHOLD time zone (never
 * the device's), and what such a feeding counts for. Pure, so it is unit
 * tested across midnight and DST; the dialog is
 * src/components/pets/feed-earlier-dialog.tsx.
 *
 * Limits are the detailed feeding form's backdated path (`feeding-log.tsx`): a
 * time more than a minute ahead is refused ("Pick a time that has already
 * passed."); a time within a minute of now is a live feeding (server time, the
 * "Feed again?" check); anything earlier is a backdated entry (`backdated: true`,
 * `date` = the chosen time, no repeat check). The dialog offers today and
 * yesterday only (household days), so nothing older can be chosen.
 *
 * What it counts for: the plan in force on the chosen time's household day
 * (`planForDay`, D-P5 planning). A backdated entry carries no `slotId`, so the
 * status attributes it by its own time among that day's feedings
 * (`attributeFeeds`); this module runs the same attribution with the new
 * feeding added, so the dialog names the meal the status will show.
 */
import { addDays, localDay, localMinutes, parseTimeOfDay, zonedWallInstant } from '../../../functions/src/shared/calendar';
import { householdDayZone } from '../household-zone';
import { formatPortion, type FeedingEntry } from './care';
import { attributeFeeds, feedsOnDay, formatClock, planForDay, type FeedObservation } from './meal-plan';
import type { PortionUnit } from './types';

/** The quick choices, in minutes before now. */
export const EARLIER_CHIP_MINUTES = [15, 30, 60, 120] as const;
/** The detailed form's margin: within a minute of now is a live feeding; more than a minute ahead is refused. */
export const EARLIER_MARGIN_MS = 60_000;

export type EarlierDay = 'today' | 'yesterday';

const pad = (n: number) => String(n).padStart(2, '0');

/** "15 min ago", "1 h ago", "2 h ago". */
export function earlierChipLabel(minutes: number): string {
  return minutes < 60 ? `${minutes} min ago` : `${minutes / 60} h ago`;
}

/** The household wall clock of an instant, as a time field's value ("07:30"). */
export function householdWallTime(at: Date, timeZone?: string | null): string {
  const minutes = localMinutes(at, householdDayZone(timeZone));
  return `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
}

/** Which of the dialog's two days an instant falls on (household days), or null. */
export function earlierDayOf(at: Date, now: Date, timeZone?: string | null): EarlierDay | null {
  const zone = householdDayZone(timeZone);
  const today = localDay(now, zone);
  const day = localDay(at, zone);
  if (day === today) return 'today';
  if (day === addDays(today, -1)) return 'yesterday';
  return null;
}

/**
 * A quick choice ("30 min ago"): the instant (to the minute, so the time field
 * and the saved time agree), and the day and time the fields then show. Just
 * after household midnight "1 h ago" is yesterday.
 */
export function earlierChoice(minutesAgo: number, now: Date, timeZone?: string | null): { at: Date; day: EarlierDay; time: string } {
  const at = new Date(Math.floor((now.getTime() - minutesAgo * 60_000) / 60_000) * 60_000);
  return { at, day: earlierDayOf(at, now, timeZone) ?? 'yesterday', time: householdWallTime(at, timeZone) };
}

/**
 * The instant of a day and wall time in the household zone. A time that
 * happens twice (fall back) is the first; one that never happens (spring
 * forward) moves forward by the gap (`zonedWallInstant`). Null for a blank or
 * malformed time.
 */
export function earlierInstant(day: EarlierDay, time: string, now: Date, timeZone?: string | null): Date | null {
  const minutes = parseTimeOfDay(time);
  if (minutes === null) return null;
  const zone = householdDayZone(timeZone);
  const today = localDay(now, zone);
  return new Date(zonedWallInstant(day === 'today' ? today : addDays(today, -1), minutes, zone));
}

export type EarlierRefusal = 'invalid' | 'future' | 'too-old';
export type EarlierCheck = { ok: true; at: Date; backdatedAt?: Date } | { ok: false; reason: EarlierRefusal };

export const EARLIER_REFUSALS: Record<EarlierRefusal, string> = {
  invalid: 'Choose when it was.',
  future: 'Pick a time that has already passed.',
  'too-old': 'Pick a time today or yesterday.',
};

/**
 * The detailed form's rule for a chosen time: refused when more than a minute
 * ahead (or before yesterday, which the dialog never offers); a backdated entry
 * when more than a minute ago; otherwise a live feeding (no `backdatedAt`).
 */
export function checkEarlierTime(at: Date | null, now: Date, timeZone?: string | null): EarlierCheck {
  if (!at || Number.isNaN(at.getTime())) return { ok: false, reason: 'invalid' };
  if (at.getTime() > now.getTime() + EARLIER_MARGIN_MS) return { ok: false, reason: 'future' };
  const zone = householdDayZone(timeZone);
  const yesterdayStart = zonedWallInstant(addDays(localDay(now, zone), -1), 0, zone);
  if (at.getTime() < yesterdayStart) return { ok: false, reason: 'too-old' };
  return at.getTime() < now.getTime() - EARLIER_MARGIN_MS ? { ok: true, at, backdatedAt: at } : { ok: true, at };
}

type PlanSource = Parameters<typeof planForDay>[0];

/** What a feeding at the chosen time counts for, and the portion it logs. */
export type EarlierPlan =
  /** A confirmed meal; `alreadyFed`: the meal already had a feeding before this time, so this one is an extra of it. */
  | { kind: 'slot'; slotName: string; amount: number; unit: PortionUnit; alreadyFed: { at: Date; by: string | null } | null }
  /** Confirmed meal times, but none served that day (all off): an extra of the day. */
  | { kind: 'off-day'; amount: number; unit: PortionUnit }
  /** No confirmed meal times that day: the usual portion. */
  | { kind: 'legacy'; amount: number; unit: PortionUnit };

/**
 * The meal a feeding at `at` counts for, judged with the plan in force on its
 * household day and that day's feedings (`logs`; null while unknown: then as
 * if none), exactly as the shared status will attribute it. Its portion is
 * that meal's portion (the usual portion without meal times; an off-day logs
 * the plan's first meal portion, as Feed does).
 */
export function earlierFeedPlan(pet: PlanSource, logs: FeedingEntry[] | null, at: Date, now: Date, timeZone?: string | null): EarlierPlan {
  const zone = householdDayZone(timeZone);
  const day = localDay(at, zone);
  const plan = planForDay(pet, day);
  if (plan.kind === 'legacy') return { kind: 'legacy', amount: plan.plan.amount, unit: plan.plan.unit };
  if (plan.slots.length === 0) {
    const first = plan.off[0];
    return { kind: 'off-day', amount: first?.amount ?? 1, unit: first?.unit ?? 'Cups' };
  }
  const mine: FeedObservation = { id: null, at, minutes: localMinutes(at, zone), slotId: null, by: null, byUid: null };
  const { bySlot } = attributeFeeds(plan.slots, [...feedsOnDay(logs ?? [], day, now, timeZone), mine]);
  const index = bySlot.findIndex((feeds) => feeds.includes(mine));
  if (index < 0) {
    // Not attributable (cannot happen with served slots); the first served meal's portion, no claim.
    const first = plan.slots[0];
    return { kind: 'off-day', amount: first.amount, unit: first.unit };
  }
  const slot = plan.slots[index];
  const first = bySlot[index][0];
  return {
    kind: 'slot',
    slotName: slot.name,
    amount: slot.amount,
    unit: slot.unit,
    alreadyFed: first === mine ? null : { at: first.at, by: first.by },
  };
}

/** "Today 7:30 am", "Yesterday 11:40 pm" (household zone). */
export function earlierWhenLabel(at: Date, now: Date, timeZone?: string | null): string {
  const day = earlierDayOf(at, now, timeZone);
  const clock = formatClock(at, timeZone);
  return day === 'today' ? `Today ${clock}` : day === 'yesterday' ? `Yesterday ${clock}` : clock;
}

/** The dialog's line about what the feeding counts for. */
export function earlierPlanLine(plan: EarlierPlan, timeZone?: string | null): string {
  const portion = formatPortion(plan.amount, plan.unit);
  if (plan.kind === 'legacy') return `Logs ${portion}.`;
  if (plan.kind === 'off-day') return `No meals were planned that day, so this is an extra feeding: ${portion}.`;
  if (plan.alreadyFed) {
    const by = plan.alreadyFed.by ? ` by ${plan.alreadyFed.by}` : '';
    return `${plan.slotName} was already logged at ${formatClock(plan.alreadyFed.at, timeZone)}${by}, so this is an extra feeding: ${portion}.`;
  }
  return `Counts for ${plan.slotName.toLowerCase()}: ${portion}.`;
}
