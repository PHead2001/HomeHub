/**
 * The pure planning of one feed and of a feeding-time correction (PE-23c/f/g/h,
 * PE-5e). Given what a writer read (the pet's plan, `feeding-state/current`,
 * whether its latest log survives, the surviving feedings since `feedReadStart`,
 * and whether this press's own log already exists), it decides: the press was
 * already recorded (idempotent replay), ask "Feed again?", or write this log
 * and this state. No Firebase, React or browser imports: the client transaction
 * (`feed-transaction.ts`) uses it now, and a device-authorized server action can
 * read the same documents with the Admin SDK and call the same functions later.
 *
 * Meal slots (P2) plug in here: `planFeed` is the one place that picks the
 * repeat reason, so a slot-aware check replaces `feedConfirmDecision` without
 * changing the writers.
 */
import {
  AUTHOR_DELETE_WINDOW_MS,
  countOnHouseholdDay,
  feedConfirmDecision,
  householdDay,
  knownFromLogs,
  newerKnown,
  withSurvivingLatest,
  type FeedCheck,
  type FeedingStateView,
  type KnownFeedings,
} from './feed-decision';
import { FEEDING_CLOCK_SKEW_MS, toDate, type FeedingEntry } from './care';

/* ------------------------------------------------------------------------- */
/* Idempotency: one operation id per press                                    */
/* ------------------------------------------------------------------------- */

/** A feed operation id: generated once per press, reused by "Feed again" and Retry. */
const FEED_OP_ID = /^[A-Za-z0-9_-]{8,64}$/;

/** A new operation id for one press (a random UUID). */
export function newFeedOpId(): string {
  return globalThis.crypto.randomUUID();
}

/**
 * The feeding log's document id for an operation (PE-23h): the log is created
 * only under this id, so a retry after an uncertain response, a reconnect or a
 * second run of the same press finds the first write instead of adding another.
 * Rules refuse a create over an existing id.
 */
export function feedLogId(opId: string): string {
  if (!FEED_OP_ID.test(opId)) throw new Error('invalid-feed-operation');
  return opId;
}

/* ------------------------------------------------------------------------- */
/* "Feed again?" bound to what was shown (PE-23g)                             */
/* ------------------------------------------------------------------------- */

/**
 * The state a "Feed again?" question was shown for: the last feeding it named and
 * today's count. The answer only counts while both are unchanged.
 */
export type FeedConfirm = { lastLogId: string | null; countToday: number };

export function feedConfirmOf(check: Pick<FeedCheck, 'lastLogId' | 'countToday'>): FeedConfirm {
  return { lastLogId: check.lastLogId, countToday: check.countToday };
}

/** Whether a confirmation still describes the current check (same last feeding, same count). */
export function confirmStillHolds(confirm: FeedConfirm | null | undefined, check: Pick<FeedCheck, 'lastLogId' | 'countToday'>): boolean {
  return Boolean(confirm) && confirm!.lastLogId === check.lastLogId && confirm!.countToday === check.countToday;
}

/* ------------------------------------------------------------------------- */
/* Planning one feed                                                          */
/* ------------------------------------------------------------------------- */

/** What the writer read, all from the same attempt. */
export type FeedSnapshot = {
  now: Date;
  timeZone?: string | null;
  /** The pet's planned feedings per day (`feedingPlan(pet).perDay`); null without a daily target. */
  perDay: number | null;
  /** The stored `feeding-state/current` (`readFeedingState`), null when the pet has none. */
  stored: FeedingStateView | null;
  /** Whether the stored latest feed's log still exists (one deleted offline is not a feed). */
  latestSurvives: boolean;
  /** Surviving feedings dated from `feedReadStart` on (both date shapes) and the newest ones, with their ids. */
  recent: StateLog[];
  /** The caller's loaded logs: used only while the pet has no state document. */
  known?: KnownFeedings | null;
  /** This press's own log (`feedLogId(opId)`) when it already exists. */
  existing: { loggedByUid: string | null } | null;
};

export type FeedIntent = {
  /** The member credited with the feed (the signed-in member). */
  userUid: string;
  /** Their name as stored on the log (`loggedByName`). */
  userName?: string | null;
  /** This press's log id (`feedLogId(opId)`). */
  logId?: string;
  /** The answer to an earlier "Feed again?", bound to the state it was shown for. */
  confirm?: FeedConfirm | null;
  /** A deliberately chosen past time (the detailed form): no repeat check. */
  backdatedAt?: Date | null;
  /**
   * The rules refused this press as a plain feed (their server clock saw a
   * recent feed that this device's clock did not): ask "Feed again?" instead of
   * planning the same plain feed again.
   */
  serverRefusedPlain?: boolean;
};

/* ------------------------------------------------------------------------- */
/* The feeding state, derived from the surviving logs (one rule for every write) */
/* ------------------------------------------------------------------------- */

/** A log as the derivation reads it: its raw stored `date` (a Firestore Timestamp, a Date or a legacy string). */
export type StateLog = FeedingEntry & { id: string };

/** A feeding named by the state: its log, effective time (and the raw stored value to write back), author. */
export type DerivedFeed = { logId: string; at: Date; rawDate: unknown; byUid: string | null; byName: string | null };

/**
 * What `feeding-state/current` must hold: the latest and the previous surviving
 * feeding by effective time (`date`), and today's count (household day). Every
 * online writer (feed, backdated entry, Undo or delete, time correction) stores
 * exactly this, computed from the logs it read plus its own change, so the
 * state never carries a stale snapshot (a corrected or deleted previous feed).
 */
export type DerivedFeedingState = { latest: DerivedFeed | null; prev: DerivedFeed | null; day: string; countOnDay: number };

const isStoredTimestamp = (value: unknown) =>
  value instanceof Date || Boolean(value && typeof value === 'object' && typeof (value as { toDate?: unknown }).toDate === 'function');

/**
 * Derives the state from surviving logs (later entries with the same id win, so
 * a caller passes its own change last). Only Timestamp-dated logs can be named
 * (the rules compare `lastFedAt` with the log's `date`; legacy ISO-string
 * entries still count for the day); a date beyond the clock-skew allowance is
 * ignored, as every reader ignores it. `latestId` makes a live feed the latest
 * whatever the device clocks say (it is server time "now").
 */
export function deriveFeedingState(logs: StateLog[], options: { now: Date; timeZone?: string | null; latestId?: string | null }): DerivedFeedingState {
  const { now, timeZone } = options;
  const byId = new Map<string, StateLog>();
  for (const log of logs) byId.set(log.id, log);
  const surviving = [...byId.values()];
  const today = householdDay(now, timeZone);
  const limit = now.getTime() + FEEDING_CLOCK_SKEW_MS;
  const named = surviving
    .map((log) => ({ log, at: isStoredTimestamp(log.date) ? toDate(log.date) : null }))
    .filter((entry): entry is { log: StateLog; at: Date } => entry.at !== null && entry.at.getTime() <= limit)
    .sort((a, b) =>
      Number(b.log.id === options.latestId) - Number(a.log.id === options.latestId) ||
      b.at.getTime() - a.at.getTime() ||
      a.log.id.localeCompare(b.log.id));
  const feed = (entry: { log: StateLog; at: Date } | undefined): DerivedFeed | null => entry
    ? {
        logId: entry.log.id,
        at: entry.at,
        rawDate: entry.log.date,
        byUid: typeof entry.log.loggedByUid === 'string' ? entry.log.loggedByUid : null,
        byName: typeof entry.log.loggedByName === 'string' ? entry.log.loggedByName : null,
      }
    : null;
  return { latest: feed(named[0]), prev: feed(named[1]), day: today, countOnDay: countOnHouseholdDay(surviving, today, timeZone, now) };
}

/** The state after deleting a feeding (Undo or a history delete); null when the pet has no state yet. */
export function planFeedDelete(input: { now: Date; timeZone?: string | null; logs: StateLog[]; logId: string; hasState: boolean }): DerivedFeedingState | null {
  if (!input.hasState) return null;
  return deriveFeedingState(input.logs.filter((log) => log.id !== input.logId), input);
}

/**
 * The state after correcting a feeding's time (PE-5e): the corrected log at its
 * new time takes its place by effective time, as latest, previous or neither,
 * and today's count follows. Null when the pet has no state yet.
 */
export function planFeedCorrection(input: {
  now: Date;
  timeZone?: string | null;
  logs: StateLog[];
  logId: string;
  newDate: Date;
  /** The stored value written to the log (a Timestamp), so the state names the identical time. */
  rawNewDate?: unknown;
  hasState: boolean;
}): DerivedFeedingState | null {
  if (!input.hasState) return null;
  const corrected = input.logs.find((log) => log.id === input.logId);
  return deriveFeedingState([...input.logs, { ...corrected, id: input.logId, date: input.rawNewDate ?? input.newDate }], input);
}

export type FeedPlan =
  /** This press was already recorded by an earlier attempt: report it, write nothing. */
  | { kind: 'already'; countToday: number; perDay: number | null }
  /**
   * Ask "Feed again?" and write nothing. `staleConfirm`: the member did answer,
   * but for a state that has changed since (someone else fed meanwhile).
   */
  | { kind: 'needsConfirm'; check: FeedCheck; staleConfirm: boolean }
  | {
      kind: 'write';
      /** Server time (`date` = `loggedAt` = commit time); false for a backdated entry. */
      live: boolean;
      repeat: 'none' | 'confirmed';
      /** With `confirmed`: the last feeding's log the member saw when asked (stored as `confirmOf`). */
      confirmOf: string | null;
      fedAt: Date;
      /** The state to store: derived from the surviving logs and this feed. */
      state: DerivedFeedingState;
      /** Today's count after this feed. */
      countToday: number;
      perDay: number | null;
    };

/**
 * Plans one online feed from a consistent read. Order: an existing log for this
 * press wins (idempotent replay); then, for a live feed, the repeat check (the
 * last known feed under 90 minutes ago, or today's count complete); a
 * confirmation only passes while it still describes the current state; else
 * the write: the log, and the state derived from the surviving logs with it
 * (`deriveFeedingState`; a live feed is the latest).
 */
export function planFeed(snapshot: FeedSnapshot, intent: FeedIntent): FeedPlan {
  const { now, timeZone, perDay, stored, recent } = snapshot;
  const today = householdDay(now, timeZone);
  // Today's count from the surviving logs read in this attempt, never a stored or loaded count.
  const countToday = countOnHouseholdDay(recent, today, timeZone, now);
  if (snapshot.existing) {
    // An id collision with someone else's log is not this press: refuse instead of claiming it.
    if (snapshot.existing.loggedByUid !== intent.userUid) throw new Error('feed-operation-conflict');
    return { kind: 'already', countToday, perDay };
  }
  const backdatedAt = intent.backdatedAt ?? null;
  const state = withSurvivingLatest(stored, snapshot.latestSurvives);
  const fresh = knownFromLogs(recent, now, timeZone);
  // The caller's loaded logs only help while the pet has no state (before the backfill).
  const latestKnown = stored ? fresh : newerKnown(fresh, snapshot.known);

  let repeat: 'none' | 'confirmed' = 'none';
  let confirmOf: string | null = null;
  if (!backdatedAt) {
    const decided = feedConfirmDecision({ state, known: latestKnown, now, timeZone, perDay, countToday });
    // The rules refused this press as plain (their clock saw a recent feed): ask instead of retrying it.
    const check = !decided.needsConfirm && intent.serverRefusedPlain
      ? { ...decided, needsConfirm: true, reason: decided.lastFedAt ? 'recent' as const : 'complete' as const }
      : decided;
    if (check.needsConfirm && !confirmStillHolds(intent.confirm, check)) {
      return { kind: 'needsConfirm', check, staleConfirm: Boolean(intent.confirm) };
    }
    // An answer that still holds is written as confirmed even when this device's
    // clock no longer sees a repeat (the rules, on server time, may still).
    if (check.needsConfirm || confirmStillHolds(intent.confirm, check)) {
      repeat = 'confirmed';
      confirmOf = check.lastLogId;
    }
  }

  const fedAt = backdatedAt ?? now;
  const logId = intent.logId ?? 'new-feeding';
  const derived = deriveFeedingState(
    [...recent, { id: logId, date: fedAt, loggedByUid: intent.userUid, loggedByName: intent.userName ?? undefined }],
    { now, timeZone, latestId: backdatedAt ? null : logId },
  );
  return { kind: 'write', live: !backdatedAt, repeat, confirmOf, fedAt, state: derived, countToday: derived.countOnDay, perDay };
}

/**
 * Plans an offline feed from what this device has cached (no transaction can
 * run): the same check and the same bound confirmation, but the log alone is
 * queued (`repeat: 'offline'`), the state is left for the next online writer.
 */
export function planOfflineFeed(
  snapshot: Pick<FeedSnapshot, 'now' | 'timeZone' | 'perDay' | 'stored' | 'known'>,
  intent: FeedIntent,
): { kind: 'needsConfirm'; check: FeedCheck; staleConfirm: boolean } | { kind: 'write'; fedAt: Date; countToday: number; perDay: number | null } {
  const { now, timeZone, perDay, stored, known } = snapshot;
  const check = feedConfirmDecision({ state: stored, known, now, timeZone, perDay });
  if (!intent.backdatedAt && check.needsConfirm && !confirmStillHolds(intent.confirm, check)) {
    return { kind: 'needsConfirm', check, staleConfirm: Boolean(intent.confirm) };
  }
  const fedAt = intent.backdatedAt ?? now;
  const sameDay = householdDay(fedAt, timeZone) === householdDay(now, timeZone);
  return { kind: 'write', fedAt, countToday: check.countToday + (sameDay ? 1 : 0), perDay };
}

/* ------------------------------------------------------------------------- */
/* Correcting a saved feeding's time (PE-5e)                                  */
/* ------------------------------------------------------------------------- */

/** The form refuses a corrected time more than this far ahead of the device clock (as the detailed form does). */
export const CORRECTION_FUTURE_MARGIN_MS = 60_000;

/**
 * Who may correct a feeding's effective time (`date`): members with
 * `pets.deleteLogs`, or its author for 10 minutes after `loggedAt` (the same
 * window as deleting it). `loggedAt`, the server-recorded time, never changes.
 */
export function mayCorrectFeedTime(
  log: { loggedByUid?: unknown; loggedAt?: unknown },
  viewerUid: string | null | undefined,
  canDeleteLogs: boolean,
  now: Date,
): boolean {
  if (canDeleteLogs) return true;
  const loggedAt = toDate(log.loggedAt);
  return Boolean(viewerUid) && log.loggedByUid === viewerUid && loggedAt !== null && now.getTime() - loggedAt.getTime() < AUTHOR_DELETE_WINDOW_MS;
}

export type CorrectionCheck = { ok: true } | { ok: false; reason: 'not-allowed' | 'future' | 'unchanged' | 'invalid' };

/**
 * Whether a correction may be saved: allowed for this member, a real time, not
 * in the future (a minute's margin on this device; the rules allow the 12-hour
 * clock-skew window, `FEEDING_CLOCK_SKEW_MS`), and actually different.
 */
export function checkFeedCorrection(input: {
  log: { loggedByUid?: unknown; loggedAt?: unknown; date?: unknown };
  viewerUid: string | null | undefined;
  canDeleteLogs: boolean;
  newDate: Date;
  now: Date;
  /** The rules' bound (default) or the form's stricter one-minute margin. */
  futureMarginMs?: number;
}): CorrectionCheck {
  const { log, newDate, now } = input;
  if (Number.isNaN(newDate.getTime()) || newDate.getTime() <= 0) return { ok: false, reason: 'invalid' };
  if (!mayCorrectFeedTime(log, input.viewerUid, input.canDeleteLogs, now)) return { ok: false, reason: 'not-allowed' };
  if (newDate.getTime() > now.getTime() + (input.futureMarginMs ?? FEEDING_CLOCK_SKEW_MS)) return { ok: false, reason: 'future' };
  const current = toDate(log.date);
  if (current && current.getTime() === newDate.getTime()) return { ok: false, reason: 'unchanged' };
  return { ok: true };
}


/**
 * The two times of a feeding as history shows them (PE-5e): `effective` is when
 * the pet ate (`date`, correctable), `recorded` is when the server saved it
 * (`loggedAt`, immutable). `recorded` is shown only when it tells something:
 * the entry was backdated, queued offline, corrected, or the two differ by more
 * than a minute.
 */
export function feedingTimes(log: {
  date?: unknown;
  loggedAt?: unknown;
  backdated?: unknown;
  repeat?: unknown;
  originalDate?: unknown;
  dateCorrectedAt?: unknown;
  dateCorrectedByName?: unknown;
}): {
  effective: Date | null;
  recorded: Date | null;
  showRecorded: boolean;
  corrected: { from: Date | null; byName: string | null } | null;
} {
  const effective = toDate(log.date);
  const recorded = toDate(log.loggedAt);
  const correctedAt = toDate(log.dateCorrectedAt);
  const corrected = correctedAt
    ? { from: toDate(log.originalDate), byName: typeof log.dateCorrectedByName === 'string' && log.dateCorrectedByName.trim() ? log.dateCorrectedByName.trim() : null }
    : null;
  const apart = effective && recorded ? Math.abs(recorded.getTime() - effective.getTime()) > 60_000 : false;
  const showRecorded = Boolean(recorded) && (apart || log.backdated === true || log.repeat === 'offline' || corrected !== null);
  return { effective: effective && effective.getTime() > 0 ? effective : null, recorded, showRecorded, corrected };
}
