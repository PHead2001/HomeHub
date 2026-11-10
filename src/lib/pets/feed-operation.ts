'use client';

/**
 * The one feed operation (audit PE-23, canonical for PE-1; PE-5; PE-2). Every
 * feeding entry point goes through it: the Feed button and hold to feed
 * (`useQuickFeed`), the `?feed=1` picker, the command palette's quick add
 * (`logFeeding`) and the feeding-log form (including backdated entries).
 *
 * Online, a transaction reads the pet and `feeding-state/current`, runs the
 * "Feed again?" check (`feedConfirmDecision`) and, unless a confirmation is
 * needed, writes the log (date and loggedAt = server time) and the state in one
 * commit, so two people feeding at once cannot both pass the check. Offline a
 * transaction cannot run: the log is queued in a batch marked
 * `repeat: 'offline'`, `clockSource: 'device'` (date = this device's clock) and
 * the state is left for the next online feed; the check then only uses what this
 * device already knows, and the UI says so.
 */
import {
  collection,
  doc,
  getDocFromCache,
  runTransaction,
  serverTimestamp,
  Timestamp,
  writeBatch,
  type DocumentData,
} from 'firebase/firestore';
import { format } from 'date-fns';
import { db } from '@/lib/firebase';
import { awaitWriteUnlessOffline, isBrowserOffline } from '@/lib/firestore-offline';
import { feedingPlan, toDate } from './care';
import {
  becomesLatest,
  countAfterFeed,
  FEEDING_STATE_ID,
  feedConfirmDecision,
  householdDay,
  planUndo,
  reconcileDayCount,
  readFeedingState,
  type FeedCheck,
  type KnownFeedings,
} from './feed-decision';
import type { FoodType, PetProfile, PortionUnit } from './types';

const petRef = (householdId: string, petId: string) => doc(db, 'households', householdId, 'pets', petId);
const logsRef = (householdId: string, petId: string) => collection(db, 'households', householdId, 'pets', petId, 'feeding-logs');
const stateRef = (householdId: string, petId: string) => doc(db, 'households', householdId, 'pets', petId, 'feeding-state', FEEDING_STATE_ID);

export type FeedPetInput = {
  householdId: string;
  petId: string;
  portion: { amount: number; unit: PortionUnit };
  food: FoodType;
  comments?: string;
  /** The member already answered "Feed again?" with yes. */
  confirm?: boolean;
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
};

export type FeedPetResult =
  | ({ status: 'needsConfirm' } & FeedCheck)
  /** Committed on the server, with today's count after this feed. */
  | { status: 'saved'; logId: string; countToday: number; perDay: number | null }
  /** Offline: queued on this device; nobody else's feed could be checked. */
  | { status: 'queued'; logId: string; countToday: number; perDay: number | null };

type Repeat = 'none' | 'confirmed' | 'offline';

function logData(input: FeedPetInput, fedAt: Date, repeat: Repeat, live: boolean): DocumentData {
  return {
    date: live ? serverTimestamp() : fedAt,
    loggedAt: serverTimestamp(),
    cups: input.portion.amount,
    foodAmountType: input.portion.unit,
    foodType: input.food,
    comments: input.comments ?? '',
    ampm: format(fedAt, 'a').toUpperCase(),
    loggedByUid: input.user.uid,
    loggedByName: input.user.name,
    repeat,
    ...(repeat === 'offline' ? { clockSource: 'device' } : {}),
    ...(input.backdatedAt ? { backdated: true } : {}),
  };
}

/** The stored fields of a state, kept as stored (Timestamps unchanged), for `prev`. */
function previousOf(raw: DocumentData | null) {
  if (!raw) return null;
  return {
    lastLogId: raw.lastLogId ?? null,
    lastFedAt: raw.lastFedAt ?? null,
    lastFedByUid: raw.lastFedByUid ?? null,
    lastFedByName: raw.lastFedByName ?? null,
    day: raw.day ?? null,
    countOnDay: typeof raw.countOnDay === 'number' ? raw.countOnDay : 0,
  };
}

/**
 * Logs a feeding, or returns `needsConfirm` (with who fed and when) so the UI
 * can ask "Sam fed Rex 12 min ago. Feed again?"; call again with `confirm: true`.
 */
export async function feedPet(input: FeedPetInput): Promise<FeedPetResult> {
  const { householdId, petId, backdatedAt, known, timeZone } = input;
  const backdated = Boolean(backdatedAt);
  if (isBrowserOffline()) return feedOffline(input);

  return runTransaction(db, async (tx) => {
    const petSnapshot = await tx.get(petRef(householdId, petId));
    const stateSnapshot = await tx.get(stateRef(householdId, petId));
    const perDay = petSnapshot.exists() ? feedingPlan(petSnapshot.data() as PetProfile).perDay : null;
    const raw = stateSnapshot.exists() ? stateSnapshot.data() : null;
    const state = readFeedingState(raw);
    const now = new Date();
    const today = householdDay(now, timeZone);

    let repeat: Repeat = 'none';
    if (!backdated) {
      const check = feedConfirmDecision({ state, known, now, timeZone, perDay });
      if (check.needsConfirm && !input.confirm) return { status: 'needsConfirm', ...check } as const;
      if (check.needsConfirm) repeat = 'confirmed';
    }

    const fedAt = backdatedAt ?? now;
    const logRef = doc(logsRef(householdId, petId));
    tx.set(logRef, logData(input, fedAt, repeat, !backdated));

    // Feedings that synced from offline are in the logs but not in the state's count.
    const count = countAfterFeed(reconcileDayCount(state, known, today), householdDay(fedAt, timeZone));
    if (becomesLatest(fedAt, backdated, state, known)) {
      tx.set(stateRef(householdId, petId), {
        lastLogId: logRef.id,
        lastFedAt: backdated ? Timestamp.fromDate(fedAt) : serverTimestamp(),
        lastFedByUid: input.user.uid,
        lastFedByName: input.user.name,
        day: count.day,
        countOnDay: count.countOnDay,
        prev: previousOf(raw),
      });
    } else if (state && (count.day !== state.day || count.countOnDay !== state.countOnDay)) {
      // An older backdated entry: only today's count can change, never who fed last.
      tx.update(stateRef(householdId, petId), { day: count.day, countOnDay: count.countOnDay });
    }
    return { status: 'saved', logId: logRef.id, countToday: count.day === today ? count.countOnDay : 0, perDay } as const;
  });
}

async function feedOffline(input: FeedPetInput): Promise<FeedPetResult> {
  const { householdId, petId, backdatedAt, known, timeZone } = input;
  const now = new Date();
  // Only what this device has cached: the pet's plan and the last state it saw.
  const [petSnapshot, stateSnapshot] = await Promise.all([
    getDocFromCache(petRef(householdId, petId)).catch(() => null),
    getDocFromCache(stateRef(householdId, petId)).catch(() => null),
  ]);
  const perDay = petSnapshot?.exists() ? feedingPlan(petSnapshot.data() as PetProfile).perDay : null;
  const state = readFeedingState(stateSnapshot?.exists() ? stateSnapshot.data() : null);
  const check = feedConfirmDecision({ state, known, now, timeZone, perDay });
  if (!backdatedAt && check.needsConfirm && !input.confirm) return { status: 'needsConfirm', ...check };

  const fedAt = backdatedAt ?? now;
  const logRef = doc(logsRef(householdId, petId));
  const batch = writeBatch(db);
  // The state is not written offline: a queued blind write could replace a newer
  // feed by someone else when it syncs. The next online feed or Undo updates it.
  batch.set(logRef, logData(input, fedAt, 'offline', false));
  const status = await awaitWriteUnlessOffline(batch.commit(), input.onLateError);
  return { status, logId: logRef.id, countToday: check.countToday + (householdDay(fedAt, timeZone) === householdDay(now, timeZone) ? 1 : 0), perDay };
}

/**
 * Deletes a feeding (Undo and the history's delete) and keeps the state honest:
 * when the state still points at this log, the previous feed is restored and the
 * count drops; when a newer feed came since, only the count drops (if the log was
 * on the counted day). Offline only the log delete is queued. Undoing the record
 * does not undo the meal; the next feed still runs the last-fed check.
 */
export async function undoFeed(input: {
  householdId: string;
  petId: string;
  logId: string;
  timeZone?: string | null;
  onLateError?: (error: unknown) => void;
}): Promise<'saved' | 'queued'> {
  const { householdId, petId, logId, timeZone } = input;
  const logRef = doc(logsRef(householdId, petId), logId);
  if (isBrowserOffline()) {
    const batch = writeBatch(db);
    batch.delete(logRef);
    return awaitWriteUnlessOffline(batch.commit(), input.onLateError);
  }
  await runTransaction(db, async (tx) => {
    const stateSnapshot = await tx.get(stateRef(householdId, petId));
    const logSnapshot = await tx.get(logRef);
    if (!logSnapshot.exists()) return;
    const raw = stateSnapshot.exists() ? stateSnapshot.data() : null;
    const state = readFeedingState(raw);
    // Restoring `prev` only brings back a feed whose log still exists.
    const prevLogId = state?.lastLogId === logId ? state.prevLogId : null;
    const prevSurvives = prevLogId ? (await tx.get(doc(logsRef(householdId, petId), prevLogId))).exists() : false;
    const date = toDate(logSnapshot.get('date'));
    const plan = planUndo(state, { id: logId, day: date ? householdDay(date, timeZone) : null }, prevSurvives);
    tx.delete(logRef);
    if (plan.kind === 'restore') {
      const prev = plan.restorePrev ? previousOf(raw?.prev ?? null) : null;
      tx.set(stateRef(householdId, petId), {
        lastLogId: prev?.lastLogId ?? null,
        lastFedAt: prev?.lastFedAt ?? null,
        lastFedByUid: prev?.lastFedByUid ?? null,
        lastFedByName: prev?.lastFedByName ?? null,
        day: plan.day,
        countOnDay: plan.countOnDay,
        prev: null,
      });
    } else if (plan.kind === 'count') {
      // Deleting the feed `prev` points at clears `prev`, so no later Undo restores it.
      tx.update(stateRef(householdId, petId), {
        day: plan.day,
        countOnDay: plan.countOnDay,
        ...(plan.dropPrev ? { prev: null } : {}),
      });
    }
  });
  return 'saved';
}
