/**
 * The shared Shopping tick and its Undo (S3, HP-33c): one operation with two callers,
 * the Shopping page's rows and the dashboard's Shopping tile.
 *
 * UI-free and Firebase-free: the Firestore side comes in through `TickIO`
 * (`shoppingTickIO` in `tick-firestore.ts`), so the decisions are unit tested
 * (tests/unit/shopping-tick.test.ts).
 *
 * - A tick is a write by id: `tickUpdate` (the reader's uid as `purchasedByUid`, the
 *   server's time, a fresh `purchaseOpId`). It is issued at once and Firestore queues it
 *   offline, so the caller's live listener shows it immediately on every device state.
 * - An item the caller's live list already shows as purchased (or gone) is never ticked
 *   again: the earlier buyer's stamps stay.
 * - The Undo writes only `undoTickUpdate(purchaseOpId)`, which the rules accept only
 *   while the item's `purchaseOpId` is still this tick's; a refusal reads "Changed by
 *   someone else — not undone".
 */
import { tickUpdate, undoTickUpdate } from './item-writes';
import { once, trackWrite, type LocalPersistence, type TrackedWrite } from './save-status';
import { CHANGED_ELSEWHERE_TITLE, isChangedElsewhere, newOpId, planTickUndo, type KnownItem } from './undo';

/** Where an item lives. Writes always go to the item's own list. */
export type ItemPath = { householdId: string; listId: string; itemId: string };

/** The Firestore side of a tick (injected, so the logic is testable). */
export type TickIO = {
  /** `updateDoc` on the item: resolves when the server acknowledges it, rejects when refused. */
  update: (path: ItemPath, data: Record<string, unknown>) => Promise<void>;
  persistence: () => LocalPersistence;
  offline: () => boolean;
  /** Whether a cache read shows the item with `status` (a queued write is on this device). */
  cachedStatusIs: (path: ItemPath, status: 'needed' | 'purchased') => Promise<boolean>;
  /** A fresh op id (tests inject one). */
  opId?: () => string;
  /**
   * Remembers a tick made on this device (SH-28c: the overview's "is shopping" never
   * counts this device's own ticks), called once per tick, before the write's answer.
   */
  recordLocal?: (path: ItemPath, opId: string) => void;
  /**
   * The tick's write was answered: `acknowledged` (its server `purchasedAt` exists
   * now, so its "own tick" memory starts ageing) or `refused` (forget it).
   */
  settleLocal?: (path: ItemPath, opId: string, outcome: 'acknowledged' | 'refused') => void;
};

/** The item as the caller's live list shows it right now; `null` = not in the list (deleted). */
export type TickCurrent = { status?: string | null } | null;

export type TickPlan = 'tick' | 'already-purchased' | 'gone';

/** Whether a tick may be written: never over a purchase the live list already shows. */
export function planTick(current: TickCurrent): TickPlan {
  if (current === null) return 'gone';
  return current.status === 'purchased' ? 'already-purchased' : 'tick';
}

export type TickStarted = {
  status: 'ticked';
  /** This tick's `purchaseOpId` (its Undo must match it). */
  opId: string;
  /** The write; Firestore queues it offline and the live listener shows it at once. */
  write: Promise<void>;
  /** The browser was offline when the tick was sent. */
  offline: boolean;
  /**
   * The honest status (SH-4): waits at most 4 s online (not at all offline), then
   * `saved`, `stored-locally` (only when the durable cache shows it), `sending` or
   * `failed`; `settled` reports the final answer. Runs once however often it is called.
   */
  track: () => Promise<TrackedWrite<void>>;
  /** Whether the durable cache already shows the tick (false on a memory cache). */
  storedLocally: () => Promise<boolean>;
};

export type TickOutcome = { status: 'already-purchased' } | { status: 'gone' } | TickStarted;

/**
 * Ticks `path` for `uid`. `current` is the item as the caller's live list shows it at
 * the moment of the tap (not a value captured when the row rendered).
 */
export function tickShoppingItem(io: TickIO, { path, uid, current }: { path: ItemPath; uid: string | null | undefined; current: TickCurrent }): TickOutcome {
  const plan = planTick(current);
  if (plan !== 'tick') return { status: plan };
  const opId = (io.opId ?? newOpId)();
  io.recordLocal?.(path, opId);
  const offline = io.offline();
  const write = io.update(path, tickUpdate(uid, opId));
  if (io.settleLocal) {
    const settle = io.settleLocal;
    write.then(() => settle(path, opId, 'acknowledged'), () => settle(path, opId, 'refused'));
  }
  const storedLocally = async () => {
    if (io.persistence() !== 'durable') return false;
    return io.cachedStatusIs(path, 'purchased').catch(() => false);
  };
  const track = once(() => trackWrite(write, {
    kind: 'write',
    persistence: io.persistence,
    offline: io.offline,
    cacheReflectsWrite: () => io.cachedStatusIs(path, 'purchased'),
  }));
  return { status: 'ticked', opId, write, offline, track, storedLocally };
}

export type UndoStarted = {
  status: 'written';
  write: Promise<void>;
  track: () => Promise<TrackedWrite<void>>;
};

export type UndoOutcome =
  /** Already needed again under this purchase (undone here or elsewhere): nothing written. */
  | { status: 'already' }
  /** The caller's live list shows a newer purchase or no item: nothing written. */
  | { status: 'refused' }
  | UndoStarted;

/**
 * The Undo of the tick `opId`. `known` is the item as the caller sees it (`undefined`
 * when it cannot tell, for example the dashboard, which lists only needed items: then
 * the rules make the call). The write is queued offline like the tick.
 */
export function undoShoppingTick(io: TickIO, { path, opId, known }: { path: ItemPath; opId: string; known: KnownItem }): UndoOutcome {
  const plan = planTickUndo(known, opId);
  if (plan === 'already') return { status: 'already' };
  if (plan === 'refused') return { status: 'refused' };
  const write = io.update(path, undoTickUpdate(opId));
  const track = once(() => trackWrite(write, { kind: 'write', persistence: io.persistence, offline: io.offline }));
  return { status: 'written', write, track };
}

/**
 * Calls `onFail` if the tracked write fails, now or after a late answer; resolves with
 * the state when the wait ended. Never rejects.
 */
export async function reportFailure(tracked: Promise<TrackedWrite<void>>, onFail: (error: unknown) => void): Promise<TrackedWrite<void>['state']> {
  const result = await tracked;
  if (result.state === 'failed') {
    onFail(result.error);
    return result.state;
  }
  if (result.state !== 'saved') {
    void result.settled.then((final) => {
      if (final.state === 'failed') onFail(final.error);
    });
  }
  return result.state;
}

/**
 * The toast for an Undo that did not happen: someone else changed the item (refused by
 * the plan or the rules), or another error (`null`: the caller reports it as an error).
 */
export function notUndoneNotice(name: string, error?: unknown): { title: string; description: string } | null {
  if (error === undefined || isChangedElsewhere(error)) {
    return { title: CHANGED_ELSEWHERE_TITLE, description: `${name} was changed on another device after this, so that change stays.` };
  }
  return null;
}
