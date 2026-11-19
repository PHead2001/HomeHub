/**
 * The documents one feed writes (the feeding log and `feeding-state/current`), built the
 * same way for the client transaction (`feed-transaction.ts`, the Firebase JS SDK) and the
 * server's device-authorized operation (`src/lib/server/pet-feeding.ts`, the Admin SDK).
 * Only the two time values differ per SDK, so they come in through `FeedTimes`: the
 * server's commit time (`serverTimestamp()` / `FieldValue.serverTimestamp()`) and a
 * stored timestamp for a given instant. Pure otherwise, so both writers store exactly the
 * shape the rules check (stage R2, `feedingCreateR2`, `feedingStateHonest`).
 */
import { format } from 'date-fns';
import type { DerivedFeed, DerivedFeedingState } from './feed-plan';
import type { FoodType, PortionUnit } from './types';

export type FeedTimes = {
  /** The commit's server time (rules: `request.time`). */
  serverTime: () => unknown;
  /** A stored timestamp for an instant. */
  timestamp: (at: Date) => unknown;
};

export type FeedLogInput = {
  portion: { amount: number; unit: PortionUnit };
  food: FoodType;
  comments?: string;
  backdatedAt?: Date | null;
  /** The member credited with the feed (`loggedByUid` / `loggedByName`). */
  user: { uid: string; name: string };
};

export type FeedLogPlan = {
  fedAt: Date;
  /** Server time (`date` = `loggedAt` = commit time); false for backdated and offline entries. */
  live: boolean;
  repeat: 'none' | 'confirmed' | 'offline';
  confirmOf?: string | null;
  slotId?: string | null;
};

/**
 * The feeding log. `stamp` is the stored time of a non-live entry (a backdated or offline
 * feed), the same value the state names; `extra` carries server-only fields (a tablet's
 * `deviceAttribution`, which the rules refuse from personal clients).
 */
export function feedLogDocument(
  input: FeedLogInput,
  plan: FeedLogPlan,
  times: FeedTimes,
  options: { stamp?: unknown; portion?: { amount: number; unit: PortionUnit }; extra?: Record<string, unknown> } = {},
): Record<string, unknown> {
  const portion = options.portion ?? input.portion;
  return {
    date: plan.live ? times.serverTime() : options.stamp ?? times.timestamp(plan.fedAt),
    loggedAt: times.serverTime(),
    cups: portion.amount,
    foodAmountType: portion.unit,
    foodType: input.food,
    comments: input.comments ?? '',
    ampm: format(plan.fedAt, 'a').toUpperCase(),
    loggedByUid: input.user.uid,
    loggedByName: input.user.name,
    repeat: plan.repeat,
    ...(plan.repeat === 'confirmed' ? { confirmOf: plan.confirmOf ?? null } : {}),
    ...(plan.repeat === 'offline' ? { clockSource: 'device' } : {}),
    ...(input.backdatedAt ? { backdated: true } : {}),
    ...(plan.slotId ? { slotId: plan.slotId } : {}),
    ...(options.extra ?? {}),
  };
}

/** A stored time as read (a Timestamp of either SDK, kept exactly), else the instant as a timestamp. */
export function storedFeedTime(raw: unknown, at: Date, times: FeedTimes): unknown {
  return raw && typeof raw === 'object' && typeof (raw as { toMillis?: unknown }).toMillis === 'function' ? raw : times.timestamp(at);
}

/**
 * The state document for a derived state (`deriveFeedingState`): each named feeding at its
 * log's stored time (server time for this press's live log), so the rules can compare them
 * exactly (`feedingStateHonest`).
 */
export function feedStateDocument(derived: DerivedFeedingState, liveLogId: string | null, times: FeedTimes): Record<string, unknown> {
  const at = (feed: DerivedFeed) => (feed.logId === liveLogId ? times.serverTime() : storedFeedTime(feed.rawDate, feed.at, times));
  const latest = derived.latest;
  const prev = derived.prev;
  return {
    lastLogId: latest?.logId ?? null,
    lastFedAt: latest ? at(latest) : null,
    lastFedByUid: latest?.byUid ?? null,
    lastFedByName: latest?.byName ?? null,
    day: derived.day,
    countOnDay: Math.min(derived.countOnDay, 1000),
    prev: prev ? { lastLogId: prev.logId, lastFedAt: at(prev), lastFedByUid: prev.byUid, lastFedByName: prev.byName } : null,
    // Today's fed meal slots (P2), only for a pet that tracks them (the rules check a plain slot feed against them).
    ...(derived.slotsFed ? { slotsFed: derived.slotsFed } : {}),
  };
}

/**
 * A backdated entry's log and state carry the same stored time, so the rules see one time:
 * the state's named feed for this log takes the log's `stamp`.
 */
export function withStampFor(state: DerivedFeedingState, logId: string, stamp: unknown): DerivedFeedingState {
  return {
    ...state,
    latest: state.latest?.logId === logId ? { ...state.latest, rawDate: stamp } : state.latest,
    prev: state.prev?.logId === logId ? { ...state.prev, rawDate: stamp } : state.prev,
  };
}
