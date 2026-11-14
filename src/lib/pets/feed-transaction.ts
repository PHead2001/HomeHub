/**
 * The feed operation's Firestore side (audit PE-23, canonical for PE-1; PE-5;
 * PE-2), with the Firestore instance passed in so the same code runs in the app
 * (`feed-operation.ts` binds the app's `db`) and against the emulator in tests.
 * The decisions are pure and live in `feed-plan.ts` / `feed-decision.ts`.
 *
 * Online, one transaction reads this press's log (`feedLogId(opId)`), the pet,
 * `feeding-state/current`, whether the state's latest log survives, and the
 * surviving feedings since `feedReadStart`; `planFeed` then answers "already
 * recorded" (a retry or a second run of the same press: nothing is written),
 * "ask Feed again?" (nothing is written), or the log and the state to write in
 * the same commit. Two writers of the same press: the second commit fails its
 * "log does not exist" precondition, retries, and finds the first. Two presses
 * at once: the state document changes under the second, which retries and asks.
 *
 * Offline a transaction cannot run: the log alone is queued under the same id,
 * marked `repeat: 'offline'`, `clockSource: 'device'` (date = this device's
 * clock), and the state is left for the next online writer.
 */
import {
  collection,
  doc,
  getDocFromCache,
  getDocs,
  limit,
  orderBy,
  query,
  runTransaction,
  serverTimestamp,
  Timestamp,
  where,
  writeBatch,
  type DocumentData,
  type Firestore,
  type Transaction,
} from 'firebase/firestore';
import { format } from 'date-fns';
import { awaitWriteUnlessOffline, isBrowserOffline } from '../firestore-offline';
import { feedingPlan } from './care';
import {
  FEEDING_STATE_ID,
  feedReadStart,
  householdDay,
  householdDayStart,
  readFeedingState,
  type FeedCheck,
  type KnownFeedings,
} from './feed-decision';
import {
  checkFeedCorrection,
  feedLogId,
  planFeed,
  planFeedCorrection,
  planFeedDelete,
  planOfflineFeed,
  type DerivedFeed,
  type DerivedFeedingState,
  type FeedConfirm,
  type FeedPlan,
  type StateLog,
} from './feed-plan';
import type { FoodType, PetProfile, PortionUnit } from './types';

const petRef = (db: Firestore, householdId: string, petId: string) => doc(db, 'households', householdId, 'pets', petId);
const logsRef = (db: Firestore, householdId: string, petId: string) => collection(db, 'households', householdId, 'pets', petId, 'feeding-logs');
const stateRef = (db: Firestore, householdId: string, petId: string) => doc(db, 'households', householdId, 'pets', petId, 'feeding-state', FEEDING_STATE_ID);

export type FeedPetInput = {
  householdId: string;
  petId: string;
  /**
   * One id per press (`newFeedOpId`), reused by "Feed again" and Retry: the log
   * is created under it only once (PE-23h).
   */
  opId: string;
  portion: { amount: number; unit: PortionUnit };
  food: FoodType;
  comments?: string;
  /** The answer to "Feed again?": the state it was shown for (`feedConfirmOf` of the asking result). */
  confirm?: FeedConfirm | null;
  /** A deliberately chosen past time (feeding-log form): `backdated: true`, no repeat check. */
  backdatedAt?: Date;
  /** The signed-in member (rules require `loggedByUid` to be the writer). */
  user: { uid: string; name: string };
  /** `household.timeZone`; the day count uses the household day. */
  timeZone?: string | null;
  /** What this client already knows from loaded logs (used while a pet has no state document). */
  known?: KnownFeedings | null;
  /** Reports a queued (offline) write that the server later refuses. */
  onLateError?: (error: unknown) => void;
  /** This device's clock (injected in tests to model a clock ahead of or behind the server). */
  clock?: () => Date;
};

export type FeedPetResult =
  /** Nothing written: ask "Feed again?". `staleConfirm`: an earlier answer no longer applies (someone fed since). */
  | ({ status: 'needsConfirm'; staleConfirm: boolean } & FeedCheck)
  /** Committed on the server, with today's count after this feed. `replayed`: an earlier attempt of this press had already saved it. */
  | { status: 'saved'; logId: string; countToday: number; perDay: number | null; replayed?: boolean }
  /** Offline: queued on this device; nobody else's feed could be checked. */
  | { status: 'queued'; logId: string; countToday: number; perDay: number | null; replayed?: boolean };

type WritePlan = Extract<FeedPlan, { kind: 'write' }>;

function logData(input: FeedPetInput, plan: { fedAt: Date; live: boolean; repeat: 'none' | 'confirmed' | 'offline'; confirmOf?: string | null }, stamp?: Timestamp): DocumentData {
  return {
    date: plan.live ? serverTimestamp() : stamp ?? Timestamp.fromDate(plan.fedAt),
    loggedAt: serverTimestamp(),
    cups: input.portion.amount,
    foodAmountType: input.portion.unit,
    foodType: input.food,
    comments: input.comments ?? '',
    ampm: format(plan.fedAt, 'a').toUpperCase(),
    loggedByUid: input.user.uid,
    loggedByName: input.user.name,
    repeat: plan.repeat,
    ...(plan.repeat === 'confirmed' ? { confirmOf: plan.confirmOf ?? null } : {}),
    ...(plan.repeat === 'offline' ? { clockSource: 'device' } : {}),
    ...(input.backdatedAt ? { backdated: true } : {}),
  };
}

/** A stored time as read (a Timestamp, kept exactly), else the Date as a Timestamp. */
function storedTime(raw: unknown, at: Date): unknown {
  return raw && typeof raw === 'object' && typeof (raw as { toMillis?: unknown }).toMillis === 'function' ? raw : Timestamp.fromDate(at);
}

/**
 * The state document for a derived state (`deriveFeedingState`): each named
 * feeding at its log's stored time (server time for this press's live log), so
 * the rules can compare them exactly (feedingStateHonest).
 */
function stateDocument(derived: DerivedFeedingState, liveLogId: string | null): DocumentData {
  const at = (feed: DerivedFeed) => (feed.logId === liveLogId ? serverTimestamp() : storedTime(feed.rawDate, feed.at));
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
  };
}

/** More feedings than this on one day are not counted beyond it (the state's count is bounded too). */
const DAY_READ_LIMIT = 100;

/**
 * Feedings dated from `start` on, read from the server (both date shapes:
 * Timestamps and older ISO strings, which Firestore orders separately; at most
 * `DAY_READ_LIMIT` of each, newest first). It runs inside the transaction
 * callback, so a conflicting feed or Undo (each writes the state document) makes
 * the transaction retry with a fresh read.
 */
export async function dayFeedings(db: Firestore, householdId: string, petId: string, start: Date): Promise<StateLog[]> {
  // Date-only or differently formatted strings compare as text: a one-day margin keeps them in range.
  const stringFloor = new Date(start.getTime() - 24 * 3_600_000).toISOString().slice(0, 10);
  const ref = logsRef(db, householdId, petId);
  const shapes = await Promise.all([
    getDocs(query(ref, where('date', '>=', Timestamp.fromDate(start)), orderBy('date', 'desc'), limit(DAY_READ_LIMIT))),
    getDocs(query(ref, where('date', '>=', stringFloor), orderBy('date', 'desc'), limit(DAY_READ_LIMIT))),
  ]);
  return shapes.flatMap((snapshot) => snapshot.docs.map((entry) => ({ id: entry.id, ...entry.data() }) as StateLog));
}

/** Lowest Timestamp, so the Timestamp-shape query matches every Timestamp date. */
const MIN_TIMESTAMP = Timestamp.fromMillis(-62135596800000);

/**
 * What the state is derived from: today's feedings (`dayFeedings` from `start`)
 * plus the newest Timestamp-dated feedings whatever their day (the latest and
 * previous feed may be days old). Read in the transaction callback, as
 * `dayFeedings`, so a conflicting state write makes the attempt retry.
 */
async function stateFeedings(db: Firestore, householdId: string, petId: string, start: Date): Promise<StateLog[]> {
  const [day, newest] = await Promise.all([
    dayFeedings(db, householdId, petId, start),
    getDocs(query(logsRef(db, householdId, petId), where('date', '>=', MIN_TIMESTAMP), orderBy('date', 'desc'), limit(5))),
  ]);
  return [...day, ...newest.docs.map((entry) => ({ id: entry.id, ...entry.data() }) as StateLog)];
}

/**
 * Logs a feeding, or returns `needsConfirm` (with who fed and when) so the UI can
 * ask "Sam fed Rex 12 min ago. Feed again?"; call again with the same `opId` and
 * `confirm: feedConfirmOf(result)`. A confirmation for a state that has changed
 * since returns a fresh `needsConfirm` (`staleConfirm: true`) instead of writing.
 */
export async function runFeed(db: Firestore, input: FeedPetInput): Promise<FeedPetResult> {
  const logId = feedLogId(input.opId);
  if (isBrowserOffline()) return feedOffline(db, input, logId);
  try {
    return await feedOnline(db, input, logId, false);
  } catch (error) {
    // A refused commit: it raced another writer (this press's log already exists,
    // or the state now names someone else's feed), or the rules' server clock saw
    // a recent feed this device's clock did not. Run the press once more on a
    // fresh read, never planning the same plain feed: it finds its own log, or
    // asks "Feed again?" (so a skewed clock never ends in an endless Retry). A
    // refusal that is real is refused again and thrown.
    if (!isPermissionDenied(error)) throw error;
    return feedOnline(db, input, logId, true);
  }
}

const isPermissionDenied = (error: unknown) =>
  Boolean(error && typeof error === 'object' && (error as { code?: unknown }).code === 'permission-denied');

async function feedOnline(db: Firestore, input: FeedPetInput, logId: string, serverRefusedPlain: boolean): Promise<FeedPetResult> {
  const { householdId, petId, known, timeZone } = input;
  return runTransaction(db, async (tx) => {
    const logRef = doc(logsRef(db, householdId, petId), logId);
    const existingSnapshot = await tx.get(logRef);
    const petSnapshot = await tx.get(petRef(db, householdId, petId));
    const stateSnapshot = await tx.get(stateRef(db, householdId, petId));
    const perDay = petSnapshot.exists() ? feedingPlan(petSnapshot.data() as PetProfile).perDay : null;
    const raw = stateSnapshot.exists() ? stateSnapshot.data() : null;
    const stored = readFeedingState(raw);
    // A latest feed deleted offline is not a feed (its log is gone).
    const latestSurvives = stored?.lastLogId ? (await tx.get(doc(logsRef(db, householdId, petId), stored.lastLogId))).exists() : false;
    const now = input.clock?.() ?? new Date();
    const today = householdDay(now, timeZone);
    // Surviving feedings from today's start or the last 90 minutes, whichever is
    // earlier, plus the newest ones, read on every attempt (a feeding just before
    // household midnight still counts as recent; today's count comes from today's
    // logs only; the state is derived from them).
    const recent = await stateFeedings(db, householdId, petId, feedReadStart(today, now, timeZone));
    const plan = planFeed(
      {
        now,
        timeZone,
        perDay,
        stored,
        latestSurvives,
        recent,
        known,
        existing: existingSnapshot.exists() ? { loggedByUid: (existingSnapshot.get('loggedByUid') as string | undefined) ?? null } : null,
      },
      { userUid: input.user.uid, userName: input.user.name, logId, confirm: input.confirm, backdatedAt: input.backdatedAt, serverRefusedPlain },
    );
    if (plan.kind === 'already') return { status: 'saved', logId, countToday: plan.countToday, perDay: plan.perDay, replayed: true } as const;
    if (plan.kind === 'needsConfirm') return { status: 'needsConfirm', staleConfirm: plan.staleConfirm, ...plan.check } as const;
    writeFeed(tx, db, input, logRef.id, plan);
    return { status: 'saved', logId, countToday: plan.countToday, perDay: plan.perDay } as const;
  });
}

function writeFeed(
  tx: Transaction,
  db: Firestore,
  input: FeedPetInput,
  logId: string,
  plan: WritePlan,
) {
  const { householdId, petId } = input;
  // A backdated entry's log and state carry the same Timestamp, so the rules see one time.
  const stamp = Timestamp.fromDate(plan.fedAt);
  tx.set(doc(logsRef(db, householdId, petId), logId), logData(input, plan, stamp));
  const state = plan.live
    ? plan.state
    : { ...plan.state, latest: plan.state.latest?.logId === logId ? { ...plan.state.latest, rawDate: stamp } : plan.state.latest, prev: plan.state.prev?.logId === logId ? { ...plan.state.prev, rawDate: stamp } : plan.state.prev };
  tx.set(stateRef(db, householdId, petId), stateDocument(state, plan.live ? logId : null));
}

async function feedOffline(db: Firestore, input: FeedPetInput, logId: string): Promise<FeedPetResult> {
  const { householdId, petId, known, timeZone } = input;
  const now = input.clock?.() ?? new Date();
  const logRef = doc(logsRef(db, householdId, petId), logId);
  // Only what this device has cached: this press's log (already queued?), the pet's plan and the last state it saw.
  const [existing, petSnapshot, stateSnapshot] = await Promise.all([
    getDocFromCache(logRef).catch(() => null),
    getDocFromCache(petRef(db, householdId, petId)).catch(() => null),
    getDocFromCache(stateRef(db, householdId, petId)).catch(() => null),
  ]);
  const perDay = petSnapshot?.exists() ? feedingPlan(petSnapshot.data() as PetProfile).perDay : null;
  const stored = readFeedingState(stateSnapshot?.exists() ? stateSnapshot.data() : null);
  if (existing?.exists()) {
    // This press is already queued (or saved): never queue it twice.
    return { status: 'queued', logId, countToday: known?.countToday ?? 0, perDay, replayed: true };
  }
  const plan = planOfflineFeed({ now, timeZone, perDay, stored, known }, { userUid: input.user.uid, confirm: input.confirm, backdatedAt: input.backdatedAt });
  if (plan.kind === 'needsConfirm') return { status: 'needsConfirm', staleConfirm: plan.staleConfirm, ...plan.check };
  const batch = writeBatch(db);
  // The state is not written offline: a queued blind write could replace a newer
  // feed by someone else when it syncs. The next online feed or Undo updates it.
  batch.set(logRef, logData(input, { fedAt: plan.fedAt, live: false, repeat: 'offline' }));
  const status = await awaitWriteUnlessOffline(batch.commit(), input.onLateError);
  return { status, logId, countToday: plan.countToday, perDay };
}

/**
 * Deletes a feeding (Undo and the history's delete) and keeps the state honest:
 * when the state still points at this log, the previous feed is restored and the
 * count drops; when a newer feed came since, only the count drops (if the log was
 * on the counted day). Offline only the log delete is queued. Undoing the record
 * does not undo the meal; the next feed still runs the last-fed check.
 */
export async function runUndoFeed(db: Firestore, input: {
  householdId: string;
  petId: string;
  logId: string;
  timeZone?: string | null;
  onLateError?: (error: unknown) => void;
}): Promise<'saved' | 'queued'> {
  const { householdId, petId, logId, timeZone } = input;
  const logRef = doc(logsRef(db, householdId, petId), logId);
  if (isBrowserOffline()) {
    const batch = writeBatch(db);
    batch.delete(logRef);
    return awaitWriteUnlessOffline(batch.commit(), input.onLateError);
  }
  await runTransaction(db, async (tx) => {
    const stateSnapshot = await tx.get(stateRef(db, householdId, petId));
    const logSnapshot = await tx.get(logRef);
    if (!logSnapshot.exists()) return;
    const now = new Date();
    const today = householdDay(now, timeZone);
    // The state is derived again from the surviving logs without this one: the
    // previous feed comes back at its own (possibly corrected) time, never from
    // an old snapshot, and today's count repairs any offline delete.
    const logs = await stateFeedings(db, householdId, petId, householdDayStart(today, timeZone));
    const derived = planFeedDelete({ now, timeZone, logs, logId, hasState: stateSnapshot.exists() });
    tx.delete(logRef);
    if (derived) tx.set(stateRef(db, householdId, petId), stateDocument(derived, null));
  });
  return 'saved';
}

/** Why a feeding's time could not be corrected (shown in the dialog). */
export class FeedCorrectionError extends Error {
  constructor(readonly reason: 'offline' | 'missing' | 'not-allowed' | 'future' | 'unchanged' | 'invalid') {
    super(`feed-correction-${reason}`);
    this.name = 'FeedCorrectionError';
  }
}

/**
 * Corrects a saved feeding's effective time (`date`, PE-5e), for example an
 * offline entry whose device clock ran ahead. Allowed to its author for 10
 * minutes after `loggedAt` or to members with `pets.deleteLogs` (rules enforce
 * both); never later than the clock-skew allowance. `loggedAt` (server-recorded)
 * never changes; the first correction keeps the original time in `originalDate`
 * and every correction records who and when (`dateCorrectedAt`, by uid and
 * name). In the same transaction the state's count is recounted and, when this
 * is the latest feed, `lastFedAt` follows. Online only: offline it throws
 * `FeedCorrectionError('offline')` (a queued correction could not keep the state right).
 */
export async function runCorrectFeedTime(db: Firestore, input: {
  householdId: string;
  petId: string;
  logId: string;
  date: Date;
  user: { uid: string; name: string };
  canDeleteLogs: boolean;
  timeZone?: string | null;
}): Promise<'saved'> {
  const { householdId, petId, logId, date, timeZone } = input;
  if (isBrowserOffline()) throw new FeedCorrectionError('offline');
  const logRef = doc(logsRef(db, householdId, petId), logId);
  await runTransaction(db, async (tx) => {
    const logSnapshot = await tx.get(logRef);
    const stateSnapshot = await tx.get(stateRef(db, householdId, petId));
    if (!logSnapshot.exists()) throw new FeedCorrectionError('missing');
    const data = logSnapshot.data();
    const now = new Date();
    const check = checkFeedCorrection({ log: data, viewerUid: input.user.uid, canDeleteLogs: input.canDeleteLogs, newDate: date, now });
    if (!check.ok) throw new FeedCorrectionError(check.reason);
    const today = householdDay(now, timeZone);
    const read = await stateFeedings(db, householdId, petId, householdDayStart(today, timeZone));
    const stamp = Timestamp.fromDate(date);
    tx.update(logRef, {
      date: stamp,
      ampm: format(date, 'a').toUpperCase(),
      ...('originalDate' in data ? {} : { originalDate: data.date ?? null }),
      dateCorrectedAt: serverTimestamp(),
      dateCorrectedByUid: input.user.uid,
      dateCorrectedByName: input.user.name,
    });
    // The corrected feeding takes its place by effective time (latest, previous
    // or neither); the state is derived again, so a corrected previous feed is
    // never restored later at its old time.
    const derived = planFeedCorrection({
      now,
      timeZone,
      logs: [...read, { id: logId, ...data } as StateLog],
      logId,
      newDate: date,
      rawNewDate: stamp,
      hasState: stateSnapshot.exists(),
    });
    if (derived) tx.set(stateRef(db, householdId, petId), stateDocument(derived, null));
  });
  return 'saved';
}
