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
 * What it counts for (lead decision): the meal whose D-P21 window holds the chosen
 * time on the plan in force that household day; if that meal is already fed it is
 * an extra feeding (no slot), never the next unfed meal. The rule is
 * `earlierFeedSlot` (meal-plan.ts), which the feed operation applies when it writes.
 */
import { addDays, localDay, localMinutes, parseTimeOfDay, zonedWallInstant } from '../../../functions/src/shared/calendar';
import { householdDayZone } from '../household-zone';
import { formatPortion, type FeedingEntry } from './care';
import { earlierFeedSlot, formatClock, mealStatus, planForDay, type PlanSource } from './meal-plan';
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

/** What a feeding at the chosen time counts for, and the portion it logs. */
export type EarlierPlan =
  /** The meal whose window (D-P21) holds the time, unfed that day: its portion. */
  | { kind: 'slot'; slotName: string; amount: number; unit: PortionUnit }
  /**
   * An extra feeding of its day, never another meal (lead decision): the meal whose window
   * holds the time was already fed (`fed`, with when and by whom), no window holds it
   * (`no-window`), or no meal is served that day (`off-day`). The portion is that meal's
   * (else the day's first meal's).
   */
  | { kind: 'extra'; reason: 'fed' | 'no-window' | 'off-day'; slotName: string | null; alreadyFed: { at: Date; by: string | null } | null; amount: number; unit: PortionUnit }
  /** No confirmed meal times that day: the usual portion. */
  | { kind: 'legacy'; amount: number; unit: PortionUnit };

/**
 * What a feeding at `at` counts for: the shared rule (`earlierFeedSlot`, which the feed
 * operation and the tablet's server operation also apply), with the day's feedings
 * (`logs`; null while unknown: then as if none).
 */
export function earlierFeedPlan(pet: PlanSource, logs: FeedingEntry[] | null, at: Date, now: Date, timeZone?: string | null): EarlierPlan {
  const decision = earlierFeedSlot(pet, logs ?? [], at, now, timeZone);
  if (decision.kind === 'legacy') {
    const plan = planForDay(pet, localDay(at, householdDayZone(timeZone)));
    const legacy = plan.kind === 'legacy' ? plan.plan : { amount: 1, unit: 'Cups' as PortionUnit };
    return { kind: 'legacy', amount: legacy.amount, unit: legacy.unit };
  }
  if (decision.kind === 'slot') return { kind: 'slot', slotName: decision.slot.name, amount: decision.slot.amount, unit: decision.slot.unit };
  return {
    kind: 'extra',
    reason: decision.reason,
    slotName: decision.slot?.name ?? null,
    alreadyFed: decision.fedBy ? { at: decision.fedBy.at, by: decision.fedBy.by } : null,
    amount: decision.slot?.amount ?? 1,
    unit: decision.slot?.unit ?? 'Cups',
  };
}

/**
 * What a choice within a minute of now records: it is saved as a live feed, so the live rule
 * applies (D-P5, `mealStatus` → the target Feed would pick), not the earlier-time rule. The
 * preview and the submitted meal follow it, so the dialog describes the feeding it records.
 * An already-fed target is an extra (the save then asks "Feed again?"); an off-day is an extra.
 */
export function liveFeedPlan(pet: PlanSource, logs: FeedingEntry[] | null, now: Date, timeZone?: string | null): EarlierPlan {
  const status = mealStatus(pet, logs ?? [], now, timeZone);
  if (status.kind === 'legacy') return { kind: 'legacy', amount: status.plan.amount, unit: status.plan.unit };
  if (!status.target) {
    const first = status.day.off[0] ?? status.day.slots[0];
    return { kind: 'extra', reason: 'off-day', slotName: first?.name ?? null, alreadyFed: null, amount: first?.amount ?? 1, unit: first?.unit ?? 'Cups' };
  }
  const { slot, fed } = status.target.state;
  if (status.target.alreadyFed) {
    return { kind: 'extra', reason: 'fed', slotName: slot.name, alreadyFed: fed ? { at: fed.at, by: fed.by } : null, amount: slot.amount, unit: slot.unit };
  }
  return { kind: 'slot', slotName: slot.name, amount: slot.amount, unit: slot.unit };
}

/**
 * What a checked choice records: the live rule within a minute of now (no `backdatedAt`), else
 * the earlier-time rule at the chosen time.
 */
export function chosenFeedPlan(pet: PlanSource, logs: FeedingEntry[] | null, check: { at: Date; backdatedAt?: Date }, now: Date, timeZone?: string | null): EarlierPlan {
  return check.backdatedAt ? earlierFeedPlan(pet, logs, check.backdatedAt, now, timeZone) : liveFeedPlan(pet, logs, now, timeZone);
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
  if (plan.kind === 'slot') return `Counts for ${plan.slotName.toLowerCase()}: ${portion}.`;
  if (plan.reason === 'off-day') return `No meals were planned that day, so this is an extra feeding: ${portion}.`;
  if (plan.reason === 'no-window' || !plan.alreadyFed) return `No meal is planned around then, so this is an extra feeding: ${portion}.`;
  const by = plan.alreadyFed.by ? ` by ${plan.alreadyFed.by}` : '';
  return `${plan.slotName} was already logged at ${formatClock(plan.alreadyFed.at, timeZone)}${by}, so this is an extra feeding, not another meal: ${portion}.`;
}
