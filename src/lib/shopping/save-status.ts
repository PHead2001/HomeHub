/**
 * Honest save status for shopping writes (SH-4, audit 17.3). No Firebase imports:
 * callers pass the persistence state, the connectivity check and the cache check,
 * so the classification is unit tested with injected values and timings
 * (tests/unit/shopping-save-status.test.ts).
 *
 * States:
 * - `saved`: the server acknowledged the write.
 * - `stored-locally`: not acknowledged yet, but known to be on this device and to
 *   survive a reload: the persistent cache is confirmed (`durable`) AND a cache read
 *   shows the write. Only this state may say "Saved, will sync".
 * - `sending`: a queued write that is not acknowledged and not known to be durable
 *   (memory cache, unknown persistence, or the cache does not show it). It may still
 *   arrive; the input is kept until it settles.
 * - `uncertain`: a transaction that has not answered in time. Transactions never
 *   queue: it may or may not commit, so the UI shows a pending chip until it settles.
 * - `failed`: rejected. The input is kept for Retry.
 *
 * A timeout alone is never proof of anything: it only moves a write from "waiting"
 * to `sending`/`uncertain`, or to `stored-locally` when the cache check passes.
 */

import { pluralize } from './items';

export type LocalPersistence = 'durable' | 'memory' | 'unknown';
export type SaveState = 'saved' | 'stored-locally' | 'sending' | 'uncertain' | 'failed';
/** `write`: set/update/delete, queued by Firestore. `transaction`: needs the server, never queued. */
export type WriteKind = 'write' | 'transaction';
export type SettledState = 'saved' | 'failed';

/** How long an online write may take before it is classified without an answer. */
export const SAVE_STATUS_TIMEOUT_MS = 4_000;

/**
 * State of a write that has not settled yet, once the wait is over (timeout, or at
 * once offline). Pure.
 */
export function classifyUnsettled({
  kind,
  persistence,
  cacheReflectsWrite,
}: {
  kind: WriteKind;
  persistence: LocalPersistence;
  /** Whether a cache read shows the write; `null` when it was not or could not be checked. */
  cacheReflectsWrite: boolean | null;
}): Exclude<SaveState, 'saved' | 'failed'> {
  if (kind === 'transaction') return 'uncertain';
  return persistence === 'durable' && cacheReflectsWrite === true ? 'stored-locally' : 'sending';
}

/** State of a settled write. Pure. */
export function classifySettled(outcome: { ok: boolean }): SettledState {
  return outcome.ok ? 'saved' : 'failed';
}

/** Whether the submission is finished from the member's point of view (input may be cleared). */
export function isSettledForInput(state: SaveState): boolean {
  return state === 'saved' || state === 'stored-locally';
}

/** Whether the entry still waits for an answer (pending chip, input kept). */
export function isPendingState(state: SaveState): state is 'sending' | 'uncertain' {
  return state === 'sending' || state === 'uncertain';
}

/** Short status text for a state (toasts, the quick-add status line). */
export function saveStateLabel(state: SaveState): string {
  switch (state) {
    case 'saved': return 'Saved';
    case 'stored-locally': return 'Saved, will sync';
    case 'sending': return 'Still sending…';
    case 'uncertain': return 'Checking…';
    case 'failed': return 'Not saved';
  }
}

/**
 * Worst state of several entries, for one summary line: failed > uncertain >
 * sending > stored-locally > saved.
 */
export function summarizeStates(states: readonly SaveState[]): SaveState | null {
  const order: SaveState[] = ['failed', 'uncertain', 'sending', 'stored-locally', 'saved'];
  for (const state of order) if (states.includes(state)) return state;
  return null;
}

export type TrackedWrite<T> = {
  /** State when the wait ended (settled, timed out, or offline at once). */
  state: SaveState;
  /** The write's value when it settled in time. */
  value?: T;
  error?: unknown;
  /** Resolves when the write finally settles (immediately when it already has). Never rejects. */
  settled: Promise<{ state: 'saved'; value: T } | { state: 'failed'; error: unknown }>;
};

export type TrackWriteDeps = {
  kind: WriteKind;
  persistence: () => LocalPersistence;
  offline: () => boolean;
  /** Reads the cache and says whether it shows the write (queued writes only). */
  cacheReflectsWrite?: () => Promise<boolean>;
  timeoutMs?: number;
  /** Injected for tests. */
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
};

/**
 * Waits for a write at most `timeoutMs` (not at all for a queued write offline),
 * then classifies it. The returned `settled` promise reports the final answer.
 */
export async function trackWrite<T>(write: Promise<T>, deps: TrackWriteDeps): Promise<TrackedWrite<T>> {
  const settled = write.then(
    (value) => ({ state: 'saved' as const, value }),
    (error: unknown) => ({ state: 'failed' as const, error }),
  );
  const setTimer = deps.setTimer ?? ((callback: () => void, ms: number) => setTimeout(callback, ms));
  const clearTimer = deps.clearTimer ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));

  // Offline a queued write cannot be acknowledged: classify it straight away.
  const skipWait = deps.kind === 'write' && deps.offline();
  let handle: unknown;
  const first = skipWait
    ? await Promise.race([settled, Promise.resolve('timeout' as const)])
    : await Promise.race([
      settled,
      new Promise<'timeout'>((resolve) => {
        handle = setTimer(() => resolve('timeout'), deps.timeoutMs ?? SAVE_STATUS_TIMEOUT_MS);
      }),
    ]);
  if (handle !== undefined) clearTimer(handle);

  if (first !== 'timeout') {
    return first.state === 'saved'
      ? { state: 'saved', value: first.value, settled }
      : { state: 'failed', error: first.error, settled };
  }

  let cacheReflectsWrite: boolean | null = null;
  if (deps.kind === 'write' && deps.persistence() === 'durable' && deps.cacheReflectsWrite) {
    cacheReflectsWrite = await deps.cacheReflectsWrite().catch(() => null);
  }
  return {
    state: classifyUnsettled({ kind: deps.kind, persistence: deps.persistence(), cacheReflectsWrite }),
    settled,
  };
}

/**
 * Per-submission guard (SH-4c): a submission id is accepted once; a second submit
 * with the same id, or any submit while `busy` holds one, is ignored.
 */
export function createSubmissionGuard() {
  const seen = new Set<string>();
  let active: string | null = null;
  return {
    /** True when this submission may start (and marks it active). */
    begin(id: string): boolean {
      if (active !== null || seen.has(id)) return false;
      seen.add(id);
      active = id;
      return true;
    },
    end(id: string) {
      if (active === id) active = null;
    },
    get busy() {
      return active !== null;
    },
  };
}

let submissionCounter = 0;
/** A fresh id for one submission (unique per page). */
export function newSubmissionId(): string {
  submissionCounter += 1;
  return `s${Date.now().toString(36)}-${submissionCounter}`;
}

/**
 * Offline note shown inside the first offline tick's Undo toast (SH-7c). It says
 * "saved on this device" only when the durable cache was seen to hold the tick.
 */
export function offlineTickNote(storedLocally: boolean): string {
  return storedLocally
    ? 'You are offline. Ticks are saved on this device and sync when you reconnect.'
    : 'You are offline. Ticks sync when you reconnect; keep HomeHub open until then.';
}

/**
 * What a tick does after its write was tracked: report a failure, run the
 * trip-completion check now (acknowledged in time), or wait for the late answer.
 */
export function tickFollowUp(state: SaveState): 'fail' | 'check-now' | 'check-after-settle' {
  if (state === 'failed') return 'fail';
  return state === 'saved' ? 'check-now' : 'check-after-settle';
}

/** A tick's late answer: a rejection is reported; an acknowledgement still runs the completion check. */
export function settledTickFollowUp(final: SettledState): 'fail' | 'check' {
  return final === 'failed' ? 'fail' : 'check';
}

/** Wraps `run` so it executes at most once; later calls return the first call's promise. */
export function once<T>(run: () => Promise<T>): () => Promise<T> {
  let first: Promise<T> | null = null;
  return () => {
    first ??= run();
    return first;
  };
}

/**
 * A write's final state if it is already known, else `pending`, without waiting:
 * an already-settled promise wins the race against the immediate sentinel.
 */
export function peekSettled(settled: Promise<SettledState>): Promise<SettledState | 'pending'> {
  return Promise.race([settled, Promise.resolve('pending' as const)]);
}

/**
 * The toast after the batched AI call failed. Only entries whose write the server
 * confirmed (`savedNames`) are "saved to Other"; entries still unconfirmed when the
 * call failed (a write slower than the 4 s status wait, which may yet fail) are
 * only said not to have been sorted. Null when there is nothing to say.
 */
export function categorizationNotice(
  { savedNames, unconfirmedNames }: { savedNames: readonly string[]; unconfirmedNames: readonly string[] },
  reasonText: string,
): { title: string; description: string } | null {
  const saved = savedNames.length;
  const unconfirmed = unconfirmedNames.length;
  if (saved === 0 && unconfirmed === 0) return null;
  if (unconfirmed === 0) {
    return saved === 1
      ? { title: 'Item saved to Other', description: `${reasonText} ${savedNames[0]} stays under Other.` }
      : { title: 'Items saved to Other', description: `${reasonText} ${pluralize(saved, 'item')} stay under Other.` };
  }
  const notSorted = unconfirmed === 1 ? `${unconfirmedNames[0]} was not sorted` : `${pluralize(unconfirmed, 'item')} were not sorted`;
  const stays = saved === 0 ? '' : saved === 1 ? ` ${savedNames[0]} stays under Other.` : ` ${pluralize(saved, 'item')} stay under Other.`;
  return { title: 'Automatic sorting failed', description: `${reasonText} ${notSorted}.${stays}` };
}

/** Which Add Item dialog, on which list, and which edit of its draft a submission came from. */
export type DialogDraft = { session: number; listId: string | null; revision: number };

/**
 * What a late-confirmed Add Item save may do to the dialog (SH-4). The form is
 * shared by every opening of the dialog, so a write that settles after the member
 * closed it, opened it on another list or typed a new draft must not wipe or close
 * that. `reset` clears the draft only while it is still the submitted one (nothing
 * typed since, so only already-saved text is cleared); `close` closes only the same
 * opening of the dialog on the same list. The save's success is reported either way.
 */
export function dialogAfterSave(
  submitted: DialogDraft,
  current: DialogDraft & { open: boolean },
): { reset: boolean; close: boolean } {
  const unchanged = submitted.revision === current.revision;
  const sameDialog = submitted.session === current.session && submitted.listId === current.listId;
  return {
    reset: unchanged,
    close: unchanged && sameDialog && current.open,
  };
}
