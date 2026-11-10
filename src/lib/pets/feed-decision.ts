/**
 * Pure decisions behind the shared feed operation (`feed-operation.ts`, audit
 * PE-23 / PE-5 / PE-2): the "Feed again?" check, the per-pet feeding state that
 * the check reads, and how Undo changes that state. No Firebase or React
 * imports, so tests/unit/pets-feed-decision.test.ts covers them.
 *
 * "Today" here is the household day (`household.timeZone`, default
 * America/Chicago), computed with the shared `localDay` from
 * functions/src/shared/calendar.ts. (No `src/lib/household-day.ts` helper exists
 * on main yet; switch to it once the dashboard data PR adds one.)
 */
import { DEFAULT_TIME_ZONE, localDay, safeTimeZone } from '../../../functions/src/shared/calendar';
import { formatAgo, seenFeedingDate, toDate, type FeedingEntry } from './care';

/** A feeding this recent asks "Feed again?" (audit PE-1/PE-23: "under about 90 minutes"). */
export const FEED_REPEAT_WINDOW_MS = 90 * 60_000;

/**
 * How long the Undo toast stays (audit 16.3: the 10-second Undo for everyone who
 * can log). Local constant: main has no shared Undo duration yet.
 */
export const FEED_UNDO_MS = 10_000;

/** The author may delete their own feeding for this long after `loggedAt` (PE-2; firestore.rules mirrors it). */
export const AUTHOR_DELETE_WINDOW_MS = 10 * 60_000;

/** Document id of the per-pet state: `households/{h}/pets/{p}/feeding-state/current`. */
export const FEEDING_STATE_ID = 'current';

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
  };
}

/** What a client already knows from the feeding logs it has loaded (fallback while a pet has no state document). */
export type KnownFeedings = {
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
  let last: { date: Date; uid: string | null; name: string | null } | null = null;
  let countToday = 0;
  for (const log of logs) {
    const date = seenFeedingDate(log.date, now);
    if (!date) continue;
    if (householdDay(date, timeZone) === today) countToday += 1;
    if (!last || date > last.date) last = { date, uid: text(log.loggedByUid), name: log.loggedByName?.trim() || null };
  }
  return { lastFedAt: last?.date ?? null, lastFedByUid: last?.uid ?? null, lastFedByName: last?.name ?? null, countToday };
}

export type FeedCheck = {
  needsConfirm: boolean;
  /** `recent`: fed under 90 minutes ago (wins); `complete`: today's planned feedings are done. */
  reason: 'recent' | 'complete' | null;
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
}): FeedCheck {
  const { state, known, now, perDay } = input;
  const today = householdDay(now, input.timeZone);
  let lastFedAt = state?.lastFedAt ?? null;
  let lastFedByUid = state?.lastFedByUid ?? null;
  let lastFedByName = state?.lastFedByName ?? null;
  if (known?.lastFedAt && (!lastFedAt || known.lastFedAt > lastFedAt)) {
    lastFedAt = known.lastFedAt;
    lastFedByUid = known.lastFedByUid ?? null;
    lastFedByName = known.lastFedByName;
  }
  const stateCount = state && state.day === today ? state.countOnDay : 0;
  const countToday = Math.max(stateCount, known?.countToday ?? 0);
  // A future time (another device's clock) counts as recent.
  const recent = Boolean(lastFedAt) && now.getTime() - lastFedAt!.getTime() < FEED_REPEAT_WINDOW_MS;
  const complete = perDay != null && perDay > 0 && countToday >= perDay;
  const reason = recent ? 'recent' : complete ? 'complete' : null;
  return { needsConfirm: reason !== null, reason, lastFedAt, lastFedByUid, lastFedByName, countToday, perDay };
}

type PromptInput = Pick<FeedCheck, 'reason' | 'lastFedAt' | 'lastFedByUid' | 'lastFedByName' | 'perDay'>;

/** Why the member is asked: "Sam fed Rex 12 min ago." (or "You fed…", or the complete-day line). */
export function feedAgainReason(check: PromptInput, petName: string, now: Date, viewerUid?: string | null): string {
  const who = viewerUid && check.lastFedByUid === viewerUid ? 'You' : check.lastFedByName;
  const ago = check.lastFedAt ? formatAgo(check.lastFedAt, now) : null;
  const fedLine = ago ? (who ? `${who} fed ${petName} ${ago}.` : `${petName} was fed ${ago}.`) : '';
  if (check.reason === 'complete') {
    const done = check.perDay ? `${petName} has had all ${check.perDay} feedings today.` : `${petName} is all fed today.`;
    return fedLine ? `${done} ${fedLine}` : done;
  }
  return fedLine || `${petName} was fed recently.`;
}

/** "Sam fed Rex 12 min ago. Feed again?" */
export function feedAgainPrompt(check: PromptInput, petName: string, now: Date, viewerUid?: string | null): string {
  return `${feedAgainReason(check, petName, now, viewerUid)} Feed again?`;
}

/** "Last fed 12 min ago by Sam" for places that show last-fed context. */
export function lastFedLine(lastFedAt: Date | null, lastFedByName: string | null, now: Date): string {
  if (!lastFedAt) return 'No feedings logged yet';
  return `Last fed ${formatAgo(lastFedAt, now)}${lastFedByName ? ` by ${lastFedByName}` : ''}`;
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
  /** The undone log was the latest feed: restore `prev` (who and when) and set the count. */
  | { kind: 'restore'; day: string | null; countOnDay: number }
  /** An older log on the counted day: only the count drops. */
  | { kind: 'count'; day: string | null; countOnDay: number };

/**
 * How deleting a feeding changes the state (Undo and history deletes). Only the
 * fields that log affected change: the previous feed is restored only when the
 * state still points at this log, so an Undo never writes an old snapshot over a
 * newer feed by someone else. Undoing the record does not undo the meal: the
 * next feed still runs the last-fed check (audit 17.2, WT-20).
 */
export function planUndo(state: FeedingStateView | null, log: { id: string; day: string | null }): UndoPlan {
  if (!state) return { kind: 'none' };
  const sameDay = log.day !== null && log.day === state.day;
  const countOnDay = sameDay ? Math.max(0, state.countOnDay - 1) : state.countOnDay;
  if (state.lastLogId === log.id) return { kind: 'restore', day: state.day, countOnDay };
  if (sameDay && state.countOnDay > 0) return { kind: 'count', day: state.day, countOnDay };
  return { kind: 'none' };
}

/** Whether the author may still delete their own feeding (rules: within 10 minutes of `loggedAt`). */
export function authorMayDelete(log: { loggedByUid?: unknown; loggedAt?: unknown }, viewerUid: string | null | undefined, now: Date): boolean {
  const loggedAt = toDate(log.loggedAt);
  return Boolean(viewerUid) && log.loggedByUid === viewerUid && loggedAt !== null && now.getTime() - loggedAt.getTime() < AUTHOR_DELETE_WINDOW_MS;
}
