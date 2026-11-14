/**
 * Pure decisions behind the shared feed operation (`feed-operation.ts`, audit
 * PE-23 / PE-5 / PE-2): the "Feed again?" check, the per-pet feeding state that
 * the check reads, and how Undo changes that state. No Firebase or React
 * imports, so tests/unit/pets-feed-decision.test.ts covers them.
 *
 * "Today" here is the household day (`household.timeZone`, default
 * America/Chicago), computed with the shared `localDay` from
 * functions/src/shared/calendar.ts (the zone rule of `src/lib/household-day.ts`).
 * The whole planning of one feed (idempotency, the bound confirmation, the state
 * write) lives in `feed-plan.ts`, on top of these decisions.
 */
import { UNDO_WINDOW_MS } from '../undo-window';
import { DEFAULT_TIME_ZONE, localDay, safeTimeZone, zonedMidnightIso } from '../../../functions/src/shared/calendar';
import { formatAgo, seenFeedingDate, toDate, type FeedingEntry } from './care';

/** A feeding this recent asks "Feed again?" (audit PE-1/PE-23: "under about 90 minutes"). */
export const FEED_REPEAT_WINDOW_MS = 90 * 60_000;

/**
 * How long the Undo toast stays (audit 16.3: the 10-second Undo for everyone who
 * can log). Local constant: main has no shared Undo duration yet.
 */
export const FEED_UNDO_MS = UNDO_WINDOW_MS;

/** The author may delete their own feeding for this long after `loggedAt` (PE-2; firestore.rules mirrors it). */
export const AUTHOR_DELETE_WINDOW_MS = 10 * 60_000;

/** Document id of the per-pet state: `households/{h}/pets/{p}/feeding-state/current`. */
export const FEEDING_STATE_ID = 'current';

/**
 * Toast group of a pet's feeding Undo (PE-8i, D-P13): one group per pet, so a
 * newer feeding of the same pet replaces its toast, while feeding the cat keeps
 * the dog's Undo on screen.
 */
export function petFeedToastGroup(petId: string): string {
  return `pet-feed:${petId}`;
}

/** The household day of an instant. */
export function householdDay(instant: Date, timeZone?: string | null): string {
  return localDay(instant, safeTimeZone(timeZone ?? DEFAULT_TIME_ZONE));
}

/** The feeding-state document as the decisions read it (timestamps as Dates). */
export type FeedingStateView = {
  lastLogId: string | null;
  lastFedAt: Date | null;
  lastFedByUid: string | null;
  lastFedByName: string | null;
  /** The household day `countOnDay` counts. */
  day: string | null;
  countOnDay: number;
  /** The state before the latest feed (for Undo); null when unknown. */
  hasPrev: boolean;
  /** The log `prev` points at (the feed an Undo would bring back); null when none. */
  prevLogId: string | null;
};

const text = (value: unknown): string | null => (typeof value === 'string' && value.length > 0 ? value : null);
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Reads a stored feeding-state document; null when there is none (older pets until the backfill runs). */
export function readFeedingState(data: Record<string, unknown> | null | undefined): FeedingStateView | null {
  if (!data) return null;
  const count = typeof data.countOnDay === 'number' && Number.isFinite(data.countOnDay) && data.countOnDay > 0 ? Math.floor(data.countOnDay) : 0;
  return {
    lastLogId: text(data.lastLogId),
    lastFedAt: toDate(data.lastFedAt),
    lastFedByUid: text(data.lastFedByUid),
    lastFedByName: text(data.lastFedByName),
    day: typeof data.day === 'string' && DAY.test(data.day) ? data.day : null,
    countOnDay: count,
    hasPrev: Boolean(data.prev && typeof data.prev === 'object'),
    prevLogId: data.prev && typeof data.prev === 'object' ? text((data.prev as Record<string, unknown>).lastLogId) : null,
  };
}

/** What a client already knows from the feeding logs it has loaded (fallback while a pet has no state document). */
export type KnownFeedings = {
  /** The newest feeding's log id, when the logs carry ids. */
  lastLogId?: string | null;
  lastFedAt: Date | null;
  lastFedByUid?: string | null;
  lastFedByName: string | null;
  /** Feedings on today's household day; null when not known (e.g. only the newest log was read). */
  countToday: number | null;
};

/**
 * The newest feeding and today's count (household day) from loaded logs.
 * Dates are read as `feedingStatus` reads them (`seenFeedingDate`): a little in
 * the future (clock skew) counts as now, far in the future is ignored.
 */
export function knownFromLogs(logs: FeedingEntry[], now: Date, timeZone?: string | null): KnownFeedings {
  const today = householdDay(now, timeZone);
  let last: { id: string | null; date: Date; uid: string | null; name: string | null } | null = null;
  let countToday = 0;
  for (const log of logs) {
    const date = seenFeedingDate(log.date, now);
    if (!date) continue;
    if (householdDay(date, timeZone) === today) countToday += 1;
    if (!last || date > last.date) last = { id: text(log.id), date, uid: text(log.loggedByUid), name: log.loggedByName?.trim() || null };
  }
  return { lastLogId: last?.id ?? null, lastFedAt: last?.date ?? null, lastFedByUid: last?.uid ?? null, lastFedByName: last?.name ?? null, countToday };
}

export type FeedCheck = {
  needsConfirm: boolean;
  /** `recent`: fed under 90 minutes ago (wins); `complete`: today's planned feedings are done. */
  reason: 'recent' | 'complete' | null;
  /**
   * The log of the last feeding the check saw (null when none, or unknown). A
   * "Feed again?" answer is bound to it and to `countToday` (PE-23g).
   */
  lastLogId: string | null;
  lastFedAt: Date | null;
  lastFedByUid: string | null;
  lastFedByName: string | null;
  countToday: number;
  perDay: number | null;
};

/**
 * The duplicate-feed check (PE-23): ask before logging when the last known
 * feeding was under 90 minutes ago, or when today's planned feedings are all
 * logged. The state document is authoritative; loaded logs fill in when a pet has
 * no state yet (or an offline feed has not reached it), and the newer of the two wins.
 */
export function feedConfirmDecision(input: {
  state: FeedingStateView | null;
  known?: KnownFeedings | null;
  now: Date;
  timeZone?: string | null;
  perDay: number | null;
  /**
   * Today's feedings counted from the logs read in the operation's transaction.
   * When given it is the count (no max with stored or loaded counts, which can
   * still include a feeding deleted offline or while "Feed again?" was open).
   */
  countToday?: number | null;
}): FeedCheck {
  const { state, known, now, perDay } = input;
  const today = householdDay(now, input.timeZone);
  let lastFedAt = state?.lastFedAt ?? null;
  let lastLogId = lastFedAt ? state?.lastLogId ?? null : null;
  let lastFedByUid = state?.lastFedByUid ?? null;
  let lastFedByName = state?.lastFedByName ?? null;
  if (known?.lastFedAt && (!lastFedAt || known.lastFedAt > lastFedAt)) {
    lastFedAt = known.lastFedAt;
    lastLogId = known.lastLogId ?? null;
    lastFedByUid = known.lastFedByUid ?? null;
    lastFedByName = known.lastFedByName;
  }
  const stateCount = state && state.day === today ? state.countOnDay : 0;
  const countToday = typeof input.countToday === 'number' ? input.countToday : Math.max(stateCount, known?.countToday ?? 0);
  // A future time (another device's clock) counts as recent.
  const recent = Boolean(lastFedAt) && now.getTime() - lastFedAt!.getTime() < FEED_REPEAT_WINDOW_MS;
  const complete = perDay != null && perDay > 0 && countToday >= perDay;
  const reason = recent ? 'recent' : complete ? 'complete' : null;
  return { needsConfirm: reason !== null, reason, lastLogId, lastFedAt, lastFedByUid, lastFedByName, countToday, perDay };
}

type PromptInput = Pick<FeedCheck, 'reason' | 'lastFedAt' | 'lastFedByUid' | 'lastFedByName' | 'perDay'>;

/** Why the member is asked: "Sam fed Rex 12 min ago." (or "You fed…", or the complete-day line). */
export function feedAgainReason(check: PromptInput, petName: string, now: Date, viewerUid?: string | null, timeZone?: string | null): string {
  const who = viewerUid && check.lastFedByUid === viewerUid ? 'You' : check.lastFedByName;
  const ago = check.lastFedAt ? formatAgo(check.lastFedAt, now, timeZone) : null;
  const fedLine = ago ? (who ? `${who} fed ${petName} ${ago}.` : `${petName} was fed ${ago}.`) : '';
  if (check.reason === 'complete') {
    const done = check.perDay ? `${petName} has had all ${check.perDay} feedings today.` : `${petName} is all fed today.`;
    return fedLine ? `${done} ${fedLine}` : done;
  }
  return fedLine || `${petName} was fed recently.`;
}

/** "Sam fed Rex 12 min ago. Feed again?" */
export function feedAgainPrompt(check: PromptInput, petName: string, now: Date, viewerUid?: string | null, timeZone?: string | null): string {
  return `${feedAgainReason(check, petName, now, viewerUid, timeZone)} Feed again?`;
}

/**
 * "Last fed 12 min ago by Sam (wet)" for places that show last-fed context before
 * logging (the palette preview, PE-23e / QA-17).
 */
export function lastFedLine(lastFedAt: Date | null, lastFedByName: string | null, now: Date, timeZone?: string | null, foodType?: string | null): string {
  if (!lastFedAt) return 'No feedings logged yet';
  const food = foodType ? ` (${foodType.toLowerCase()})` : '';
  return `Last fed ${formatAgo(lastFedAt, now, timeZone)}${lastFedByName ? ` by ${lastFedByName}` : ''}${food}`;
}

/** The instant a household day starts (for the bounded "today's feedings" read). */
export function householdDayStart(day: string, timeZone?: string | null): Date {
  return new Date(zonedMidnightIso(day, safeTimeZone(timeZone ?? DEFAULT_TIME_ZONE)));
}

/**
 * Where the online feed's log read starts: today's household midnight, or 90
 * minutes ago (`FEED_REPEAT_WINDOW_MS`) when that is earlier, so a feeding
 * logged just before midnight (for example an offline feed that synced at 23:55)
 * still counts as recent at 00:05. Today's count still counts only today's logs
 * (`countOnHouseholdDay`), so the extra minutes never add to it.
 */
export function feedReadStart(day: string, now: Date, timeZone?: string | null): Date {
  return new Date(Math.min(householdDayStart(day, timeZone).getTime(), now.getTime() - FEED_REPEAT_WINDOW_MS));
}

/**
 * Feedings on one household day, counted from the logs themselves (the online
 * operation reads them in its transaction). This is the count the state stores:
 * a feeding queued offline that has synced is in it, and one deleted offline or
 * by someone else meanwhile is not, so a stale stored count repairs itself.
 * `excludeId` leaves out a log being deleted in the same commit.
 */
export function countOnHouseholdDay(logs: (FeedingEntry & { id?: string })[], day: string, timeZone: string | null | undefined, now: Date, excludeId?: string): number {
  const seen = new Set<string>();
  let count = 0;
  for (const log of logs) {
    if (log.id && (log.id === excludeId || seen.has(log.id))) continue;
    if (log.id) seen.add(log.id);
    const date = seenFeedingDate(log.date, now);
    if (date && householdDay(date, timeZone) === day) count += 1;
  }
  return count;
}

/** The newer of two last-fed views (each may be null). */
export function newerKnown(a: KnownFeedings | null | undefined, b: KnownFeedings | null | undefined): KnownFeedings | null {
  if (!a) return b ?? null;
  if (!b) return a;
  if (!a.lastFedAt) return b.lastFedAt ? b : a;
  if (!b.lastFedAt) return a;
  return b.lastFedAt > a.lastFedAt ? b : a;
}

/** The state as the check should read it: a latest feed whose log is gone (deleted offline) is not a feed. */
export function withSurvivingLatest(state: FeedingStateView | null, latestSurvives: boolean): FeedingStateView | null {
  if (!state || latestSurvives || !state.lastLogId) return state;
  return { ...state, lastFedAt: null, lastFedByUid: null, lastFedByName: null };
}

/** The day count after logging a feeding on `logDay`. */
export function countAfterFeed(base: { day: string; countOnDay: number }, logDay: string): { day: string; countOnDay: number } {
  if (logDay === base.day) return { day: base.day, countOnDay: base.countOnDay + 1 };
  // A later day starts a new count; an earlier (backdated) day leaves today's count alone.
  if (logDay > base.day) return { day: logDay, countOnDay: 1 };
  return base;
}

/**
 * Whether a new feeding at `fedAt` becomes the state's latest feed. Live feeds
 * always do; a backdated entry only when it is newer than every feeding known.
 */
export function becomesLatest(fedAt: Date, backdated: boolean, state: FeedingStateView | null, known?: KnownFeedings | null): boolean {
  if (!backdated) return true;
  const latest = [state?.lastFedAt, known?.lastFedAt].filter((value): value is Date => Boolean(value));
  return latest.every((date) => fedAt > date);
}

export type UndoPlan =
  | { kind: 'none' }
  /**
   * The undone log was the latest feed: restore `prev` (who and when) when its
   * log still exists (`restorePrev`), otherwise clear the latest feed; set the count.
   */
  | { kind: 'restore'; day: string | null; countOnDay: number; restorePrev: boolean }
  /** An older log: the count drops (when it was on the counted day), and `prev` is cleared when it pointed at this log. */
  | { kind: 'count'; day: string | null; countOnDay: number; dropPrev: boolean };

/**
 * How deleting a feeding changes the state (Undo and history deletes). Only the
 * fields that log affected change: the previous feed is restored only when the
 * state still points at this log, so an Undo never writes an old snapshot over a
 * newer feed by someone else, and never brings back a feed whose log is gone:
 * deleting the feed `prev` points at clears `prev`, and restoring needs `prev`'s
 * log to still exist (`prevSurvives`, read in the same transaction). Undoing the
 * record does not undo the meal: the next feed still runs the last-fed check
 * (audit 17.2, WT-20).
 */
export function planUndo(state: FeedingStateView | null, log: { id: string; day: string | null }, prevSurvives = true): UndoPlan {
  if (!state) return { kind: 'none' };
  const sameDay = log.day !== null && log.day === state.day;
  const countOnDay = sameDay ? Math.max(0, state.countOnDay - 1) : state.countOnDay;
  if (state.lastLogId === log.id) {
    return { kind: 'restore', day: state.day, countOnDay, restorePrev: state.prevLogId !== null && prevSurvives };
  }
  const dropPrev = state.prevLogId === log.id;
  if (dropPrev || (sameDay && state.countOnDay > 0)) return { kind: 'count', day: state.day, countOnDay, dropPrev };
  return { kind: 'none' };
}

/** Whether the author may still delete their own feeding (rules: within 10 minutes of `loggedAt`). */
export function authorMayDelete(log: { loggedByUid?: unknown; loggedAt?: unknown }, viewerUid: string | null | undefined, now: Date): boolean {
  const loggedAt = toDate(log.loggedAt);
  return Boolean(viewerUid) && log.loggedByUid === viewerUid && loggedAt !== null && now.getTime() - loggedAt.getTime() < AUTHOR_DELETE_WINDOW_MS;
}
